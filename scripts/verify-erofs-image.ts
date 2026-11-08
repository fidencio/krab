import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inspectErofsImage, validateErofsImageLock, type ErofsImageLock } from './erofs-image.ts'

const path = resolve(import.meta.dirname, '../upstream/erofs-utils-image.lock.json')
const lock = JSON.parse(await readFile(path, 'utf8')) as ErofsImageLock
validateErofsImageLock(lock)
const published = await inspectErofsImage(lock.reference, lock.tag)
if (published.digest !== lock.digest ||
    JSON.stringify(published.platforms) !== JSON.stringify(lock.platforms)) {
  throw new Error('Published EROFS utility image differs from the pinned lock')
}
console.log(`Verified ${lock.reference}:${lock.tag}@${lock.digest}`)
