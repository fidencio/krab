import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import { newerRelease, resolveTagCommit, updateGroupLock } from '../scripts/refresh-upstream.ts'

const release = (tag_name: string, prerelease = false) => ({ tag_name, prerelease, draft: false })

test('stable groups ignore prereleases while provisioner accepts them', () => {
  const candidates = [release('v0.20.0-rc.1', true), release('v0.19.1'), release('v0.18.9')]
  assert.equal(newerRelease(candidates, 'v0.19.0', 'nfd'), 'v0.19.1')
  assert.equal(newerRelease([release('v0.1.0-alpha.2', true)], 'v0.1.0-alpha.1', 'provisioner'),
    'v0.1.0-alpha.2')
  assert.equal(newerRelease([release('v0.2.0-rc.0', true)], 'v0.2.0-rc.0', 'device-plugin'), undefined)
  assert.equal(newerRelease([release('v4.3.0-rc.1', true)], '4.2.0', 'kata'), undefined)
  assert.equal(newerRelease([release('v4.3.0-rc.1')], '4.2.0', 'kata'), undefined)
})

test('annotated release tags resolve to immutable commits', async () => {
  const tagObject = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  const requests: string[] = []
  const resolved = await resolveTagCommit('kata-containers/kata-containers', '4.3.0', async (path) => {
    requests.push(path)
    return (requests.length === 1
      ? { ref: 'refs/tags/4.3.0', object: { type: 'tag', sha: tagObject } }
      : { object: { type: 'commit', sha: commit } }) as never
  })
  assert.equal(resolved, commit)
  assert.equal(requests[1], `/repos/kata-containers/kata-containers/git/tags/${tagObject}`)
})

test('a group lock is updated only when every source exists and the chart matches', () => {
  const lock = `schemaVersion: 1
sources:
  - id: nfd-chart
    repository: kubernetes-sigs/node-feature-discovery
    ref: ${'a'.repeat(40)}
    release: v0.19.0
    path: Chart.yaml
    sha256: ${'0'.repeat(64)}
  - id: nfd-values
    repository: kubernetes-sigs/node-feature-discovery
    ref: ${'a'.repeat(40)}
    release: v0.19.0
    path: values.yaml
    sha256: ${'0'.repeat(64)}
`
  const files = new Map([['Chart.yaml', 'name: node-feature-discovery\nversion: 0.2.1\nappVersion: v0.20.0\n']])
  assert.throws(() => updateGroupLock(lock, 'nfd', 'v0.20.0', 'b'.repeat(40), files), /missing values.yaml/)
  files.set('values.yaml', 'image: new\n')
  const updated = parse(updateGroupLock(lock, 'nfd', 'v0.20.0', 'b'.repeat(40), files))
  assert.equal(updated.sources[0].ref, 'b'.repeat(40))
  assert.equal(updated.sources[1].release, 'v0.20.0')
  assert.match(updated.sources[1].sha256, /^[0-9a-f]{64}$/)
  files.set('Chart.yaml', 'name: node-feature-discovery\nappVersion: v0.19.0\n')
  assert.throws(() => updateGroupLock(lock, 'nfd', 'v0.20.0', 'b'.repeat(40), files), /does not match/)
})
