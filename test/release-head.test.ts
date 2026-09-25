import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const script = resolve(import.meta.dirname, '../scripts/verify-release-head.sh')

test('release publication stops when main moves after dispatch', async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'krab-release-head-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const bin = resolve(fixture, 'bin')
  await mkdir(bin)
  await writeFile(resolve(bin, 'gh'), `#!/bin/bash
[[ "$1" == api && "$2" == repos/fidencio/krab/git/ref/heads/main && "$3" == --jq && "$4" == .object.sha ]] || exit 2
printf '%s\\n' "$MOCK_MAIN_SHA"
`)
  await chmod(resolve(bin, 'gh'), 0o755)

  const sha = 'a'.repeat(40)
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: 'fidencio/krab',
    GITHUB_SHA: sha,
    MOCK_MAIN_SHA: sha,
  }
  assert.doesNotThrow(() => execFileSync('bash', [script], { env }))
  const stale = spawnSync('bash', [script], {
    env: { ...env, MOCK_MAIN_SHA: 'b'.repeat(40) },
    encoding: 'utf8',
  })
  assert.equal(stale.status, 1)
  assert.match(stale.stdout, /main moved from/)
})
