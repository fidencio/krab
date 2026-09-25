import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

export function renderedImages(source: string): Set<string> {
  const images = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'image' && typeof child === 'string') images.add(child)
        else visit(child)
      }
    }
  }
  for (const document of parseAllDocuments(source)) {
    if (document.errors.length > 0) throw document.errors[0]
    visit(document.toJS())
  }
  return images
}

export function missingImages(sbom: {
  packages: Array<{ name: string; versionInfo?: string; primaryPackagePurpose?: string }>
}, renders: string[]): string[] {
  const documented = new Set(sbom.packages
    .filter(({ primaryPackagePurpose }) => primaryPackagePurpose === 'CONTAINER')
    .map(({ name, versionInfo }) =>
      `${name}${versionInfo?.startsWith('sha256:') ? '@' : ':'}${versionInfo}`))
  return [...new Set(renders.flatMap((render) => [...renderedImages(render)]))]
    .filter((reference) => !documented.has(reference))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sbomPath, ...renderPaths] = process.argv.slice(2)
  if (!sbomPath || renderPaths.length === 0) {
    throw new Error('Usage: tsx scripts/verify-sbom-images.ts SBOM.spdx.json RENDER.yaml ...')
  }
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'))
  const renders = renderPaths.map((path) => readFileSync(path, 'utf8'))
  const missing = missingImages(sbom, renders)
  if (missing.length > 0) {
    throw new Error(`Rendered container images absent from the chart SBOM: ${missing.join(', ')}`)
  }
}
