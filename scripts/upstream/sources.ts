import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { inspectErofsImage, validateErofsImageLock, type ErofsImageLock } from '../erofs-image.ts'

export type Source = {
  id: string
  repository: string
  ref: string
  release?: string
  pullRequest?: number
  draft?: boolean
  path: string
  cache: string
  sha256: string
  url?: string
  sourceUrl?: string
}

type LockFile = {
  schemaVersion: number
  sources: Source[]
}

export const requireValue = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined || value === '') throw new Error(message)
  return value
}

export const readYaml = async (path: string) => parse(await readFile(path, 'utf8'))

const rawUrl = (source: Source) => source.url ??
  `https://raw.githubusercontent.com/${source.repository}/${source.ref}/${source.path}`

export const blobUrl = (source: Source) => source.sourceUrl ??
  `https://github.com/${source.repository}/blob/${source.ref}/${source.path}`

export async function loadSources(root: string, shouldFetch: boolean) {
  const erofsLock = JSON.parse(await readFile(resolve(root, 'upstream/erofs-utils-image.lock.json'), 'utf8')) as ErofsImageLock
  validateErofsImageLock(erofsLock)
  if (shouldFetch) {
    const published = await inspectErofsImage(erofsLock.reference, erofsLock.tag)
    if (published.digest !== erofsLock.digest ||
        JSON.stringify(published.platforms) !== JSON.stringify(erofsLock.platforms)) {
      throw new Error('Published EROFS utility image differs from the pinned lock')
    }
  }

  const lock = await readYaml(resolve(root, 'upstream/sources.lock.yaml')) as LockFile
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources)) {
    throw new Error('Unsupported upstream source lock schema')
  }
  const sourceById = new Map(lock.sources.map((source) => [source.id, source]))
  if (sourceById.size !== lock.sources.length) {
    throw new Error('Every upstream source id must be unique')
  }

  const cacheRoot = resolve(root, 'upstream/cache')
  for (const source of lock.sources) {
    const path = resolve(cacheRoot, source.cache)
    let content: string | undefined
    if (!shouldFetch) {
      try {
        content = await readFile(path, 'utf8')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      }
    }
    if (shouldFetch || content === undefined) {
      const response = await fetch(rawUrl(source))
      if (!response.ok) throw new Error(`Unable to fetch ${source.id}: HTTP ${response.status}`)
      content = await response.text()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    const actualChecksum = createHash('sha256').update(content).digest('hex')
    if (actualChecksum !== source.sha256) {
      throw new Error(`${source.id} checksum mismatch: expected ${source.sha256}, got ${actualChecksum}`)
    }
  }

  const source = (id: string) => requireValue(sourceById.get(id), `Missing locked source: ${id}`)
  const cachePath = (id: string) => resolve(cacheRoot, source(id).cache)
  const sourceLink = (id: string) => blobUrl(source(id))
  return { lock, source, sourceById, cachePath, sourceLink }
}
