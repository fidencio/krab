import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parse, parseAllDocuments } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import { buildValuesBundle, createAdvancedConfiguration, type ExplorerCatalog } from '../src/lib/artifacts.ts'

for (const continuous of [false, true]) test(`CPU choices render an automatic node stage; conformance=${continuous}`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'krab-native-cpu-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const catalog = catalogData as ExplorerCatalog
  const advanced = createAdvancedConfiguration()
  advanced.continuousConformance = continuous
  const file = join(directory, 'values.yaml')
  writeFileSync(file, buildValuesBundle(catalog, catalog.vendors.find(v => v.id === 'custom')!, {},
    { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
    { selectedShimIds: ['qemu-nvidia-cpu-tdx-runtime-rs', 'qemu-nvidia-cpu-snp-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false }, advanced))
  const rendered = execFileSync('helm', ['template', 'cpu-cc', resolve('charts/krab'), '--namespace', 'kata-system', '-f', file], { encoding: 'utf8' })
  const manifests = parseAllDocuments(rendered).map(doc => { assert.deepEqual(doc.errors, []); return doc.toJS() }).filter(Boolean)
  const classes = manifests.filter(doc => doc.kind === 'RuntimeClass')
  assert.deepEqual(classes.map(doc => doc.metadata.name).sort(), ['kata-qemu-nvidia-cpu-snp-runtime-rs', 'kata-qemu-nvidia-cpu-tdx-runtime-rs'])
  for (const runtime of classes) {
    assert.equal(runtime.overhead.podFixed.memory, '10240Mi')
    assert.equal(runtime.scheduling.nodeSelector['nvidia.com/cc.ready.state'], undefined)
    assert.equal(runtime.scheduling.nodeSelector['feature.node.kubernetes.io/krab-conformance'], continuous ? 'pass' : undefined)
  }
  const teeRules = manifests.filter(doc => doc.kind === 'NodeFeatureRule' && doc.metadata.name === 'kata-tee-keys')
  assert.equal(teeRules.length, 1, 'fresh installs must emit CPU discovery rules before NFD exists')
  for (const [name, label, resource] of [
    ['intel.tdx', 'intel.feature.node.kubernetes.io/tdx', 'tdx.intel.com/keys'],
    ['amd.sev-snp', 'amd.feature.node.kubernetes.io/snp', 'sev-snp.amd.com/esids'],
  ]) {
    const rule = teeRules[0].spec.rules.find((rule: { name: string }) => rule.name === name)
    assert.equal(rule.labels[label], 'true')
    assert.ok(rule.extendedResources[resource])
  }
  const configs = manifests.find(doc => doc.kind === 'ConfigMap' && doc.data?.['custom-runtimes.list'])
  assert.ok(configs)
  for (const tee of ['snp', 'tdx']) assert.ok(configs.data['custom-runtimes.list'].includes(`kata-qemu-nvidia-cpu-${tee}-runtime-rs:qemu-nvidia-gpu-${tee}-runtime-rs:nydus:guest-pull:amd64`))
  const jobs = manifests.filter(doc => doc.kind === 'ConfigMap').flatMap(doc => Object.values(doc.data ?? {}))
    .filter((source): source is string => typeof source === 'string' && source.includes('krab-node-setup'))
    .map(source => parse(source)).filter(doc => doc.kind === 'Job')
  assert.equal(jobs.length, 2)
  for (const job of jobs) {
    const pod = job.spec.template.spec
    assert.equal(pod.automountServiceAccountToken, false)
    assert.equal(pod.hostPID, true)
    const index = pod.initContainers.findIndex((container: { name: string }) => container.name === 'krab-node-setup')
    const helper = pod.initContainers[index]
    assert.equal(helper.image, `ghcr.io/kata-containers/krab-preflight:${catalog.plannedArchitecture.charts.krab.version}`)
    assert.ok(helper.args.includes('kata-system/cpu-cc'))
    if (helper.args.includes('--remove')) assert.equal(index, 0)
    else {
      assert.equal(index, pod.initContainers.length - 1)
      assert.ok(helper.args.includes('--cpu-tee'))
      assert.equal(helper.args.includes('--continuous-conformance'), continuous)
      if (continuous) {
        const policy = JSON.parse(helper.args[helper.args.indexOf('--deployment-policy') + 1])
        assert.deepEqual(policy.map((p: { requirements: string[] }) => p.requirements).sort(), [['kvm', 'snp'], ['kvm', 'tdx']])
      }
    }
  }
  assert.equal(manifests.filter(doc => doc.kind === 'NodeFeatureRule' && doc.metadata.name.endsWith('node-conformance')).length, continuous ? 1 : 0)
  const worker = manifests.find(doc => doc.kind === 'DaemonSet' && doc.metadata.name.includes('worker'))
  assert.ok(worker.spec.template.spec.volumes.some((volume: { hostPath?: { path: string } }) => volume.hostPath?.path === '/run/krab/features'))
})
