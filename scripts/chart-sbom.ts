import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

type Chart = {
  name: string
  version: string
  appVersion?: string
  dependencies?: Array<{ name: string; version: string }>
  annotations?: Record<string, string>
}

const digest = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex')

const directoryDigest = (directory: string) => {
  const hash = createHash('sha256')
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) {
        hash.update(relative(directory, child))
        hash.update('\0')
        hash.update(readFileSync(child))
      } else throw new Error(`Unsupported chart entry ${child}`)
    }
  }
  visit(directory)
  return hash.digest('hex')
}

const chartFromArchive = (archive: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'krab-chart-sbom-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', directory])
    const roots = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
    if (roots.length !== 1) {
      throw new Error(`${archive} must contain one chart directory`)
    }
    return { directory, root: roots[0] }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function chartSbom(
  archive: string,
  created = new Date(
    process.env.SOURCE_DATE_EPOCH
      ? Number(process.env.SOURCE_DATE_EPOCH) * 1000
      : Date.now(),
  ).toISOString().replace(/\.\d{3}Z$/, 'Z'),
) {
  const packages: Array<Record<string, unknown>> = []
  const relationships: Array<Record<string, string>> = []
  const temporaryDirectories: string[] = []
  const visited = new Set<string>()
  const imageSources = new Map<string, Set<string>>()
  let rootName = ''
  let rootVersion = ''

  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}

  const merge = (defaults: unknown, overrides: unknown): Record<string, unknown> => {
    const combined = { ...asRecord(defaults) }
    for (const [key, value] of Object.entries(asRecord(overrides))) {
      combined[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? merge(combined[key], value)
        : value
    }
    return combined
  }

  const addImage = (reference: string, source: string, chartId: string) => {
    const match = reference.match(/^(.+?)(?:@sha256:([0-9a-f]{64})|:([^/:]+))?$/)
    if (!match) throw new Error(`Invalid image reference ${reference} at ${source}`)
    const [, name, sha256, tag] = match
    if (!sha256 && !tag) throw new Error(`Image ${reference} at ${source} has no tag or digest`)
    const imageId = `SPDXRef-Image-${createHash('sha256').update(reference).digest('hex').slice(0, 24)}`
    if (!imageSources.has(imageId)) {
      imageSources.set(imageId, new Set())
      packages.push({
        SPDXID: imageId,
        name,
        versionInfo: sha256 ? `sha256:${sha256}` : tag,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
        primaryPackagePurpose: 'CONTAINER',
        ...(sha256 ? { checksums: [{ algorithm: 'SHA256', checksumValue: sha256 }] } : {}),
      })
    }
    imageSources.get(imageId)!.add(source)
    if (!relationships.some((relationship) =>
      relationship.spdxElementId === chartId && relationship.relatedSpdxElement === imageId)) {
      relationships.push({
        spdxElementId: chartId,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: imageId,
      })
    }
  }

  const addImagesFromValues = (
    values: unknown,
    chart: Chart,
    chartId: string,
    path = chart.name,
  ) => {
    for (const [key, value] of Object.entries(asRecord(values))) {
      const source = `${path}.${key}`
      const imageField = key === 'image' || key.endsWith('Image')
      if (imageField && typeof value === 'string' && value) {
        addImage(value, source, chartId)
      } else if (imageField && value !== null && typeof value === 'object') {
        const image = asRecord(value)
        const reference = image.reference ?? image.repository
        if (typeof reference === 'string' && reference) {
          const fallback = key === 'probeImage'
            ? chart.version
            : chart.appVersion ?? chart.version
          const tag = image.tag || fallback
          const fullReference = reference.includes('@sha256:') ||
            /:[^/:]+$/.test(reference)
            ? reference
            : `${reference}:${tag}`
          addImage(fullReference, source, chartId)
        }
      }
      if (value !== null && typeof value === 'object') {
        addImagesFromValues(value, chart, chartId, source)
      }
    }
  }

  const visitDirectory = (
    root: string,
    archive?: string,
    parentValues?: Record<string, unknown>,
  ): string => {
    const chart = parse(readFileSync(join(root, 'Chart.yaml'), 'utf8')) as Chart
    if (!chart?.name || !chart?.version) {
      throw new Error(`${root} has no chart name or version`)
    }
    const sha256 = archive ? digest(archive) : directoryDigest(root)
    const id = `SPDXRef-Chart-${sha256.slice(0, 24)}`
    if (visited.has(id)) return id
    visited.add(id)

    if (!rootName) {
      rootName = chart.name
      rootVersion = chart.version
    }
    packages.push({
      SPDXID: id,
      name: chart.name,
      versionInfo: chart.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: chart.annotations?.['artifacthub.io/license'] ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      checksums: [{ algorithm: 'SHA256', checksumValue: sha256 }],
      primaryPackagePurpose: 'APPLICATION',
    })
    const values = merge(
      parse(readFileSync(join(root, 'values.yaml'), 'utf8'), { uniqueKeys: false }),
      parentValues?.[chart.name],
    )
    addImagesFromValues(values, chart, id)

    if (chart.name === 'krab') {
      const lock = JSON.parse(readFileSync(resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../upstream/erofs-utils-image.lock.json',
      ), 'utf8')) as { reference: string; tag: string; digest: string }
      addImage(`${lock.reference}@${lock.digest}`,
        `upstream/erofs-utils-image.lock.json (optional EROFS setup, tag ${lock.tag})`, id)
    }

    const chartsPath = join(root, 'charts')
    let children: string[] = []
    try {
      children = readdirSync(chartsPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() ||
          (entry.isFile() && entry.name.endsWith('.tgz')))
        .map((entry) => join(chartsPath, entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const found = new Set<string>()
    for (const child of children) {
      const childId = child.endsWith('.tgz')
        ? visitArchive(child, values)
        : visitDirectory(child, undefined, values)
      const childPackage = packages.find((entry) => entry.SPDXID === childId)!
      const key = `${childPackage.name}@${childPackage.versionInfo}`
      if (!(chart.dependencies ?? []).some((dependency) =>
        `${dependency.name}@${dependency.version}` === key)) {
        throw new Error(`${chart.name} contains undeclared dependency ${key}`)
      }
      found.add(key)
      relationships.push({
        spdxElementId: id,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: childId,
      })
    }
    for (const dependency of chart.dependencies ?? []) {
      const key = `${dependency.name}@${dependency.version}`
      if (!found.has(key)) {
        throw new Error(`${chart.name} is missing packaged dependency ${key}`)
      }
    }
    return id
  }

  const visitArchive = (archive: string, parentValues?: Record<string, unknown>): string => {
    const { directory, root } = chartFromArchive(archive)
    temporaryDirectories.push(directory)
    return visitDirectory(root, archive, parentValues)
  }

  try {
    const rootId = visitArchive(resolve(archive))
    relationships.unshift({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: rootId,
    })
    for (const entry of packages) {
      const sources = imageSources.get(String(entry.SPDXID))
      if (sources) entry.comment = `Referenced by ${[...sources].join(', ')}`
    }
    return {
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `${rootName}-${rootVersion}`,
      documentNamespace: `https://github.com/fidencio/krab/sbom/${rootName}-${rootVersion}/${digest(archive)}`,
      creationInfo: { created, creators: ['Tool: krab-chart-sbom'] },
      packages,
      relationships,
    }
  } finally {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, output] = process.argv.slice(2)
  if (!archive || !output) {
    throw new Error('Usage: tsx scripts/chart-sbom.ts CHART.tgz OUTPUT.spdx.json')
  }
  writeFileSync(output, `${JSON.stringify(chartSbom(archive), null, 2)}\n`)
}
