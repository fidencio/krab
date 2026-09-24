import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { syncPrecheck, type ImageLock } from '../scripts/sync-precheck.ts'

test('precheck generation restores both image pins from one provisioner release', async () => {
  const root = resolve(import.meta.dirname, '..')
  const dockerfile = await readFile(resolve(root, 'Dockerfile.precheck'), 'utf8')
  const values = await readFile(resolve(root, 'charts/precheck/values.yaml'), 'utf8')
  const lock = JSON.parse(
    await readFile(resolve(root, 'upstream/precheck-image.lock.json'), 'utf8'),
  ) as ImageLock
  const dispatcher = parse(values).dispatcherImage as string
  const separator = dispatcher.lastIndexOf(':')
  const pinnedDispatcher = {
    reference: dispatcher.slice(0, separator),
    tag: dispatcher.slice(separator + 1),
  }
  const staleDockerfile = dockerfile.replaceAll(lock.digest, `sha256:${'0'.repeat(64)}`)
  const staleValues = values.replace(dispatcher, 'example.com/old-dispatcher:old')
  const generated = syncPrecheck(
    staleDockerfile,
    staleValues,
    lock,
    { reference: lock.reference, tag: lock.tag },
    pinnedDispatcher,
  )

  assert.equal(generated.dockerfile, dockerfile)
  assert.equal(generated.values, values)
  assert.equal(
    syncPrecheck(dockerfile, values, lock, lock, pinnedDispatcher).dockerfile,
    dockerfile,
  )
  assert.throws(
    () => syncPrecheck(dockerfile, values, lock, { reference: lock.reference, tag: 'new-release' }, pinnedDispatcher),
    /does not match/,
  )
})
