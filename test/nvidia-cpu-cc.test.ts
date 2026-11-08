import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import { coreRequest } from '../src/lib/core.ts'
import { fixture, cocohash } from './fixtures/nvidia-cpu-cc.ts'
import { buildValuesBundle, createAdvancedConfiguration, importValuesBundle, type ExplorerCatalog } from '../src/lib/artifacts.ts'

const catalog = catalogData as ExplorerCatalog
const vendor = catalog.vendors.find(({ id }) => id === 'custom')!
const cluster = { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] }

for (const continuous of [false, true]) test(`CPU presets generate and round-trip without GPU dependencies, conformance=${continuous}`, () => {
  const advanced = createAdvancedConfiguration()
  advanced.continuousConformance = continuous
  const runtime = { selectedShimIds: ['qemu-nvidia-cpu-tdx-runtime-rs', 'qemu-nvidia-cpu-snp-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false }
  const source = buildValuesBundle(catalog, vendor, {}, cluster, runtime, advanced)
  const values = parse(source)
  assert.equal(values.nvidia.enabled, false)
  assert.equal(values['kata-deploy'].nodeFeatureRules.create, true)
  assert.equal(values['intel-tdx-qgs'].enabled, true)
  assert.equal(values['kata-device-plugin'].enabled, false)
  assert.equal(values['kata-device-provisioner'].enabled, false)
  assert.deepEqual(values.global.krab.nvidiaCpuTees, ['snp', 'tdx'])
  for (const tee of ['tdx', 'snp']) {
    const id = `qemu-nvidia-cpu-${tee}-runtime-rs`
    const custom = values['kata-deploy'].customRuntimes.runtimes[id]
    assert.equal(custom.baseConfig, `qemu-nvidia-gpu-${tee}-runtime-rs`)
    assert.equal(custom.inheritBaseOverhead, true)
    assert.deepEqual(custom.containerd, { snapshotter: 'nydus' })
    const cls = parse(custom.runtimeClass)
    assert.equal(cls.scheduling.nodeSelector['nvidia.com/cc.ready.state'], undefined)
    assert.equal(cls.scheduling.nodeSelector['feature.node.kubernetes.io/krab-conformance'], continuous ? 'pass' : undefined)
    assert.equal(values['kata-deploy'].shims[id], undefined)
  }
  const imported = importValuesBundle(catalog, source)
  assert.deepEqual(imported.runtime.selectedShimIds.sort(), runtime.selectedShimIds.sort())
  assert.equal(imported.advanced.continuousConformance, continuous)
  assert.equal(imported.advanced.customRuntimes.length, 0)
  assert.deepEqual(parse(buildValuesBundle(catalog, vendor, imported.selections, imported.cluster, imported.runtime, imported.advanced)), values)
})

test('browser and node use the Rust CPU derivation retaining measured metadata and common arguments', () => {
  for (const tee of ['tdx', 'snp']) {
    const derived = coreRequest<{ dropIn: string }>('deriveCpuCc', undefined, catalog, {
      source: fixture(tee), tee, directory: '/custom/opt/kata',
      kernelParams: 'root=verified debug nvrc.dcgm=on agent.proxy="two words"',
    })
    assert.ok(derived.dropIn.includes(cocohash))
    assert.ok(derived.dropIn.includes('/custom/opt/kata/share/kata-containers/coco.img'))
    assert.ok(derived.dropIn.includes('debug'))
    assert.ok(!derived.dropIn.includes('gpu.img'))
    assert.ok(!derived.dropIn.includes('nvrc.dcgm='))
    assert.throws(() => coreRequest('deriveCpuCc', undefined, catalog, {
      source: fixture(tee).replace(cocohash, ''), tee,
    }), /integrity metadata/)
  }
})


test('continuous conformance preserves independent new-node enrollment choices', () => {
  for (const scheduled of [false, true]) {
    for (const continuous of [false, true]) {
      const advanced = createAdvancedConfiguration()
      advanced.scheduledReconcileEnabled = scheduled
      advanced.scheduledReconcileSchedule = '*/7 * * * *'
      advanced.continuousConformance = continuous
      const values = parse(buildValuesBundle(catalog, vendor, {}, cluster,
        { selectedShimIds: ['qemu-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false }, advanced))
      assert.equal(values['kata-deploy'].job.reconcile?.enabled === true, scheduled)
      if (scheduled) assert.equal(values['kata-deploy'].job.reconcile.schedule, '*/7 * * * *')
    }
  }
})
