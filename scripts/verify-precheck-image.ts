import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveImageLock, type ImageLock } from './sync-precheck.ts'

const path = resolve(import.meta.dirname, '../upstream/precheck-image.lock.json')
const pinned = JSON.parse(await readFile(path, 'utf8')) as ImageLock
const published = await resolveImageLock(pinned.reference, pinned.tag)
if (JSON.stringify(published) !== JSON.stringify(pinned)) {
  throw new Error('Published provisioner image differs from upstream/precheck-image.lock.json')
}
console.log(`Verified ${pinned.reference}:${pinned.tag}@${pinned.digest}`)
