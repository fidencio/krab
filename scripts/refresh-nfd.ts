import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse, parseDocument } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const lockPath = resolve(root, 'upstream/sources.lock.yaml')
const repository = 'kubernetes-sigs/node-feature-discovery'
const sources = {
  'nfd-chart': 'deployment/helm/node-feature-discovery/Chart.yaml',
  'nfd-values': 'deployment/helm/node-feature-discovery/values.yaml',
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'krab-upstream-refresh' },
  })
  if (!response.ok) throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`)
  return response.text()
}

async function main() {
  const document = parseDocument(await readFile(lockPath, 'utf8'))
  if (document.errors.length) throw document.errors[0]
  const lock = document.toJS() as {
    sources: { id: string; repository: string; release?: string; path: string }[]
  }
  const latest = await fetch(`https://github.com/${repository}/releases/latest`, {
    redirect: 'manual',
  })
  const tag = latest.headers.get('location')?.match(
    /^https:\/\/github\.com\/kubernetes-sigs\/node-feature-discovery\/releases\/tag\/(v[^/]+)$/,
  )?.[1]
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Unexpected NFD release tag: ${tag}`)
  }

  const updates = await Promise.all(Object.entries(sources).map(async ([id, path]) => {
    const index = lock.sources.findIndex((item) => item.id === id)
    const source = lock.sources[index]
    if (!source || source.repository !== repository || source.path !== path) {
      throw new Error(`NFD source lock is missing ${id}`)
    }
    const content = await fetchText(
      `https://raw.githubusercontent.com/${repository}/${tag}/${path}`,
    )
    return { id, index, content, sha256: createHash('sha256').update(content).digest('hex') }
  }))
  const chart = parse(updates.find((item) => item.id === 'nfd-chart')!.content)
  if (chart.name !== 'node-feature-discovery' || String(chart.appVersion) !== tag) {
    throw new Error(`NFD ${tag} chart metadata does not match the release`)
  }

  for (const { index, sha256 } of updates) {
    document.setIn(['sources', index, 'ref'], tag)
    document.setIn(['sources', index, 'release'], tag)
    document.setIn(['sources', index, 'sha256'], sha256)
  }
  const updated = document.toString()
  if (updated !== await readFile(lockPath, 'utf8')) {
    await writeFile(lockPath, updated)
    console.log(`Pinned NFD ${tag}; run npm run sync:upstream to regenerate KRAB`)
  } else {
    console.log(`NFD ${tag} is already pinned`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
