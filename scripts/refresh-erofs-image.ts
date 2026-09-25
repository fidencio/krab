import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { compareVersions, inspectErofsImage, listErofsTags, validateErofsImageLock, type ErofsImageLock } from './erofs-image.ts'

const path = resolve(import.meta.dirname, '../upstream/erofs-utils-image.lock.json')
const lock = JSON.parse(await readFile(path, 'utf8')) as ErofsImageLock
validateErofsImageLock(lock)
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `current=${lock.tag}\n`)
const tags = await listErofsTags(lock.reference)
const candidates = tags.filter((tag) => compareVersions(tag, lock.tag) > 0)
  .sort(compareVersions).reverse()
for (const tag of candidates) {
  try {
    const next = await inspectErofsImage(lock.reference, tag)
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `changed=true\ntag=${tag}\n`)
    }
    console.log(`Selected ${next.reference}:${tag}@${next.digest}`)
    process.exit(0)
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid EROFS utility image lock') {
      console.warn(`Skipping ${tag}: amd64 or arm64 image is missing`)
      continue
    }
    throw error
  }
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'changed=false\n')
console.log('No newer EROFS utility image covers amd64 and arm64')
