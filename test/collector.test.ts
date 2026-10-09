import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dirname, '..')
test('collector aggregates current reports and rejects failed or incomplete collections', () => {
  assert.match(execFileSync('bash', ['test/collector-smoke.sh', 'charts/precheck/files/collect.sh'],
    { cwd: root, encoding: 'utf8' }), /Collector smoke tests passed/)
})

test('collector and node probes use separate images in the rendered precheck chart', () => {
  const rendered = execFileSync('helm', ['template', 'krab-precheck', 'charts/precheck'],
    { cwd: root, encoding: 'utf8' })
  const resources = parseAllDocuments(rendered).map((document) => document.toJS())
  const results = resources.find((resource) => resource?.kind === 'Job' && resource.metadata.name.endsWith('-results'))
  const collector = results.spec.template.spec.containers[0]
  assert.match(collector.image, /^ghcr\.io\/fidencio\/krab-collector:/)
  assert.deepEqual(collector.command, ['/bin/bash', '/etc/krab/collect.sh'])
  const configmap = resources.find((resource) => resource?.kind === 'ConfigMap')
  assert.match(configmap.data['node-job.yaml'], /ghcr\.io\/fidencio\/krab-preflight:/)
  const dockerfile = readFileSync(resolve(root, 'Dockerfile.collector'), 'utf8')
  assert.match(dockerfile, /apt-get install .*bash ca-certificates curl jq/)
})
