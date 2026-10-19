import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse, parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dirname, '..')

for (const [name, overrides, selector] of [
  ['default', [], 'kubernetes.io/os=linux'],
  ['unset', ['--set', 'nodeSelector=null'], 'kubernetes.io/os=linux'],
  ['labeled', ['--set-string', 'nodeSelector=krab/preflight=true'], 'krab/preflight=true,kubernetes.io/os=linux'],
] as const) {
  test(`precheck dispatcher and collector check the same Linux nodes (${name})`, () => {
    const rendered = execFileSync('helm', ['template', 'krab-precheck', 'charts/precheck', ...overrides],
      { cwd: root, encoding: 'utf8' })
    const resources = parseAllDocuments(rendered).map((document) => document.toJS())
    const container = (suffix: string) => resources.find((resource) =>
      resource?.kind === 'Job' && resource.metadata.name.endsWith(suffix)).spec.template.spec.containers[0]
    const dispatcherSelector = container('-dispatcher').args.filter((arg: string) => arg.startsWith('--node-selector='))
    assert.deepEqual(dispatcherSelector, [`--node-selector=${selector}`])
    assert.equal(container('-results').env.find((env: { name: string }) => env.name === 'NODE_SELECTOR').value, selector)
  })
}

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

test('precheck cache mounts are confined to the cache directory and configured through the Rust binary', () => {
  for (const [overrides, enabled, force] of [
    [[], true, false],
    [['--set', 'cache.forceRefresh=true', '--set', 'cache.hostPath=/var/cache/custom-krab'], true, true],
    [['--set', 'cache.enabled=false'], false, false],
  ] as const) {
    const rendered = execFileSync('helm', ['template', 'krab-precheck', 'charts/precheck', ...overrides],
      { cwd: root, encoding: 'utf8' })
    const resources = parseAllDocuments(rendered).map((document) => document.toJS())
    const configmap = resources.find((resource) => resource?.kind === 'ConfigMap')
    const spec = parse(configmap.data['node-job.yaml']).spec.template.spec
    const probe = spec.containers[0]
    assert.equal(spec.automountServiceAccountToken, false)
    assert.ok(probe.volumeMounts.filter((mount: { name: string }) => mount.name !== 'preflight-cache')
      .every((mount: { readOnly: boolean }) => mount.readOnly))
    const cacheVolume = spec.volumes.find((volume: { name: string }) => volume.name === 'preflight-cache')
    if (enabled) {
      assert.deepEqual(probe.args, ['--cache-dir', '/var/cache/krab-preflight', ...(force ? ['--force-refresh'] : [])])
      assert.deepEqual(cacheVolume.hostPath, { path: force ? '/var/cache/custom-krab' : '/var/lib/krab/preflight', type: 'DirectoryOrCreate' })
      assert.equal(probe.volumeMounts.find((mount: { name: string }) => mount.name === 'preflight-cache').mountPath, '/var/cache/krab-preflight')
    } else {
      assert.deepEqual(probe.args, ['--no-cache'])
      assert.equal(cacheVolume, undefined)
      assert.equal(probe.volumeMounts.some((mount: { name: string }) => mount.name === 'preflight-cache'), false)
    }
  }
})

test('Helm conformance gates success on the Rust verdict and preserves collection errors for exit 2', () => {
  const rendered = execFileSync('helm', ['template', 'krab-precheck', 'charts/precheck',
    '--set', 'conformance.enabled=true', '--set', 'conformance.requirements={tdx,gpu-cc}'],
  { cwd: root, encoding: 'utf8' })
  const resources = parseAllDocuments(rendered).map((document) => document.toJS())
  const jobs = resources.filter((resource) => resource?.kind === 'Job')
  assert.equal(jobs.length, 2)
  const dispatcher = jobs.find((job) => job.metadata.name === 'krab-precheck-dispatcher-1')
  // This must start as a regular resource: a failing dispatcher hook would stop
  // Helm before it could create the conformance Job and report ERROR.
  assert.equal(dispatcher.metadata.annotations?.['helm.sh/hook'], undefined)
  const job = jobs.find((job) => job.metadata.name === 'krab-precheck-conformance')
  assert.equal(job.metadata.annotations['helm.sh/hook'], 'post-install,post-upgrade')
  assert.equal(job.metadata.annotations['helm.sh/hook-delete-policy'], 'before-hook-creation')
  assert.equal(job.spec.backoffLimit, 0)
  const spec = job.spec.template.spec
  assert.equal(spec.restartPolicy, 'Never')
  assert.equal(spec.automountServiceAccountToken, false)
  const collector = spec.initContainers[0]
  assert.match(collector.args[0], /collection-error.txt; exit 0$/)
  assert.equal(collector.env.find((env: { name: string }) => env.name === 'WAIT_FOR_DISPATCHER').value, 'true')
  assert.equal(collector.env.find((env: { name: string }) => env.name === 'DISPATCHER_JOB_NAME').value, dispatcher.metadata.name)
  const evaluator = spec.containers[0]
  assert.deepEqual(evaluator.command, ['/usr/local/bin/krab-preflight'])
  assert.deepEqual(evaluator.args, ['conformance', '--report', '/work/precheck.json', '--collection-error',
    '/work/collection-error.txt', '--termination-message', '/dev/termination-log', '--json',
    '--require', 'tdx', '--require', 'gpu-cc'])
  assert.equal(evaluator.terminationMessagePath, '/dev/termination-log')
  assert.equal(evaluator.volumeMounts.some((mount: { name: string }) => mount.name === 'api-access'), false)
  assert.equal(collector.volumeMounts.some((mount: { name: string }) => mount.name === 'api-access'), true)
  const configmap = resources.find((resource) => resource?.kind === 'ConfigMap')
  assert.ok(parse(configmap.data['node-job.yaml']).spec.template.spec.containers[0].args.includes('--force-refresh'))
})

test('Helm conformance refuses an empty, unknown, or conflicting selection before creating Jobs', () => {
  for (const requirements of ['', 'conformance.requirements={unsupported}', 'conformance.requirements={tdx,snp}']) {
    const args = ['template', 'krab-precheck', 'charts/precheck', '--set', 'conformance.enabled=true',
      ...(requirements ? ['--set', requirements] : [])]
    assert.throws(() => execFileSync('helm', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /requirements|requirement/)
  }
})

test('Helm supports a GPU OR selection by itself or alongside mandatory CPU requirements', () => {
  for (const withCpu of [false, true]) {
    const rendered = execFileSync('helm', ['template', 'krab-precheck', 'charts/precheck',
      '--set', 'conformance.enabled=true', '--set', 'conformance.anyOf={gpu-cc,gpu-ppcie}',
      ...(withCpu ? ['--set', 'conformance.requirements={tdx}'] : [])], { cwd: root, encoding: 'utf8' })
    const resources = parseAllDocuments(rendered).map((document) => document.toJS())
    const args = resources.find((r) => r?.kind === 'Job' && r.metadata.name.endsWith('-conformance'))
      .spec.template.spec.containers[0].args
    assert.deepEqual(args.slice(-2), ['--require-any', 'gpu-cc,gpu-ppcie'])
    assert.equal(args.includes('tdx'), withCpu)
  }
  assert.throws(() => execFileSync('helm', ['template', 'krab-precheck', 'charts/precheck',
    '--set', 'conformance.enabled=true', '--set', 'conformance.anyOf={tdx,snp}'],
  { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /anyOf accepts gpu-cc and gpu-ppcie/)
})
