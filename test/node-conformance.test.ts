import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseAllDocuments } from 'yaml'

test('conformance NFD policy is opt-in and labels only explicit fresh results', () => {
  // Isolate the umbrella template from unrelated packaged dependency versions.
  const chart = mkdtempSync(join(tmpdir(), 'krab-conformance-rule-'))
  try {
    mkdirSync(join(chart, 'templates'))
    writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: krab\nversion: 0.0.0\n')
    copyFileSync(resolve('charts/krab/values.yaml'), join(chart, 'values.yaml'))
    copyFileSync(resolve('charts/krab/values.schema.json'), join(chart, 'values.schema.json'))
    copyFileSync(resolve('charts/krab/templates/conformance-feature-rules.yaml'), join(chart, 'templates/rule.yaml'))
    const render = (...args: string[]) => parseAllDocuments(execFileSync('helm',
      ['template', 'example', chart, '--namespace', 'kata-system', ...args], { encoding: 'utf8', stdio: 'pipe' }))
      .map(document => {
        assert.deepEqual(document.errors, [])
        return document.toJS()
      }).filter(Boolean)
    assert.deepEqual(render(), [])
    const resources = render('--set', 'global.krab.continuousConformance=true')
    assert.equal(resources.length, 1)
    const rule = resources[0]
    assert.equal(rule.kind, 'NodeFeatureRule')
    for (const state of ['pass', 'fail', 'error']) {
      const matching = rule.spec.rules.filter((entry: { matchFeatures: Array<{ feature: string, matchExpressions: Record<string, { op: string, value: string[] }> }> }) =>
        entry.matchFeatures.every(feature => feature.feature === 'local.feature' &&
          Object.entries(feature.matchExpressions).every(([key, expression]) =>
            key === 'krab.conformance.state' && expression.op === 'In' && expression.value.includes(state))))
      assert.equal(matching.length, 1)
      assert.equal(matching[0].labels['feature.node.kubernetes.io/krab-conformance'], state)
    }
    assert.equal(rule.spec.rules.length, 3)
    assert.deepEqual(render('--set', 'global.krab.continuousConformance=false'), [])
    assert.throws(() => render('--set-string', 'global.krab.continuousConformance=yes'), /continuousConformance[\s\S]*boolean/)
  } finally {
    rmSync(chart, { recursive: true, force: true })
  }
})
