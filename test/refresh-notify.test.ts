import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const script = resolve(import.meta.dirname, '../scripts/notify-refresh-slack.sh')

test('blocked refresh sends one Slack DM with the failed jobs and run link', async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'krab-slack-test-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const bin = resolve(fixture, 'bin')
  const payloadFile = resolve(fixture, 'payload.json')
  await mkdir(bin)
  await writeFile(resolve(bin, 'curl'), `#!/bin/bash
while (( $# > 0 )); do
  if [[ "$1" == --data ]]; then printf '%s' "$2" > "$MOCK_PAYLOAD"; break; fi
  shift
done
printf '%s' "$MOCK_RESPONSE"
`)
  await chmod(resolve(bin, 'curl'), 0o755)

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_PAYLOAD: payloadFile,
    MOCK_RESPONSE: '{"ok":true}',
    SLACK_BOT_TOKEN: 'test-token',
    SLACK_USER_ID: 'U123456',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'fidencio/krab',
    GITHUB_RUN_ID: '123',
    PIN_STATUS: 'success',
    UPSTREAM_STATUS: 'failure',
    EROFS_STATUS: 'success',
  }
  execFileSync('bash', [script], { env })
  const payload = JSON.parse(await readFile(payloadFile, 'utf8')) as { channel: string; text: string }
  assert.equal(payload.channel, 'U123456')
  assert.match(payload.text, /Upstream release refresh: failure/)
  assert.match(payload.text, /https:\/\/github\.com\/fidencio\/krab\/actions\/runs\/123/)
  assert.doesNotMatch(payload.text, /EROFS image refresh/)
  assert.throws(() => execFileSync('bash', [script], {
    env: { ...env, MOCK_RESPONSE: '{"ok":false,"error":"channel_not_found"}' },
    stdio: 'pipe',
  }), /channel_not_found/)
})
