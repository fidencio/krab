import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('artifact promotion requires the exact successful main push and every unexpired platform', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'krab-promotion-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const sha = 'a'.repeat(40)
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
data=json.loads(Path(os.environ['KRAB_PROMOTION_FIXTURE']).read_text())
path=sys.argv[2]
if '/artifacts?' in path:
    print(json.dumps({'artifacts': data['artifacts']}))
else:
    workflow=path.split('/workflows/')[1].split('/')[0]
    run={**data['run'], 'path': data.get('path', '.github/workflows/'+workflow)}
    print(json.dumps({'workflow_runs': [run]}))
`, { mode: 0o755 })
  const artifacts = ['krab-preflight-linux-amd64', 'krab-preflight-linux-arm64',
    'krab-cli-linux-amd64', 'krab-cli-linux-arm64', 'krab-cli-darwin-arm64'].map((name) =>
    ({ name, expired: false, size_in_bytes: 1024 }))
  const run = { id: 123, head_sha: sha, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success' }
  const check = (fixture: unknown) => {
    const source = join(directory, 'fixture.json'), output = join(directory, 'outputs')
    writeFileSync(source, JSON.stringify(fixture))
    writeFileSync(output, '')
    const result = spawnSync('python3', [resolve('scripts/reuse-release-artifacts.py'), '--wait-seconds', '0'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
        KRAB_PROMOTION_FIXTURE: source, GITHUB_REPOSITORY: 'fixture/krab', GITHUB_SHA: sha, GITHUB_OUTPUT: output },
    })
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(output, 'utf8')
  }
  assert.equal(check({ run, artifacts }), 'preflight=123\ncli=123\n')
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' },
    { event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
    assert.equal(check({ run: { ...run, ...change }, artifacts }), 'preflight=\ncli=\n')
  }
  assert.equal(check({ run, artifacts, path: '.github/workflows/untrusted.yml' }), 'preflight=\ncli=\n')
  assert.equal(check({ run, artifacts: artifacts.map((item) => ({ ...item, expired: true })) }), 'preflight=\ncli=\n')
  assert.equal(check({ run, artifacts: artifacts.filter((item) => item.name !== 'krab-cli-darwin-arm64') }),
    'preflight=123\ncli=\n')
})
