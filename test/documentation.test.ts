import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { withWebmDuration } from '../scripts/webm-duration.mjs'

const root = resolve(import.meta.dirname, '..')

test('walkthroughs ship video, posters, captions, and readable transcripts together', async () => {
  const recordings = JSON.parse(await readFile(resolve(root, 'src/generated/walkthroughs.json'), 'utf8'))
  assert.deepEqual(Object.keys(recordings).sort(), ['cli', 'tui', 'website'])
  for (const [name, recording] of Object.entries(recordings) as Array<[string, { duration: number; steps: unknown[] }]>) {
    assert.ok(recording.duration > 0)
    assert.ok(recording.steps.length >= 4)
    const base = resolve(root, 'public/walkthroughs', name)
    const webm = await readFile(`${base}.webm`)
    assert.equal(webm.subarray(0, 4).toString('hex'), '1a45dfa3')
    const poster = await readFile(`${base}.png`)
    assert.equal(poster.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const captions = await readFile(`${base}.vtt`, 'utf8')
    assert.match(captions, /^WEBVTT\n/)
    assert.equal(captions.match(/ --> /g)?.length, recording.steps.length)
    // Reapplying duration is idempotent, rather than accumulating Info elements.
    assert.deepEqual(withWebmDuration(webm, recording.duration), webm)
  }
})

test('documentation is an on-site route and the compact terminal strip has no inline manual', async () => {
  const app = await readFile(resolve(root, 'src/App.tsx'), 'utf8')
  const guide = await readFile(resolve(root, 'src/CliGuide.tsx'), 'utf8')
  const docs = await readFile(resolve(root, 'src/Documentation.tsx'), 'utf8')
  assert.match(app, /hash\.startsWith\('#docs'\)/)
  assert.match(app, /<Documentation/)
  assert.match(guide, /href="#docs\/tui"/)
  assert.doesNotMatch(guide, /<details>|Install and use KRAB/)
  for (const section of ['install', 'website', 'tui', 'cli', 'checks', 'reference']) {
    assert.ok(docs.includes(`id="docs/${section}"`))
  }
  assert.doesNotMatch(docs, /<track\b/)
  assert.match(docs, /Read the walkthrough/)
  assert.match(docs, /preload="none"/)
})
