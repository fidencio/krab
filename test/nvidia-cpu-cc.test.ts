import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { cocohash, fixture, generate, prepare, python } from './fixtures/nvidia-cpu-cc.ts'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import { buildValuesBundle, createAdvancedConfiguration, importValuesBundle, type ExplorerCatalog } from '../src/lib/artifacts.ts'

test('CPU CC custom runtimes preserve all reference settings except the GPU extension', (t) => {
  const directory = prepare(t)
  const result = generate(directory)
  assert.equal(result.status, 0, result.stderr)
  const values = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(values), ['kata-deploy'])
  const kata = values['kata-deploy']
  assert.equal(kata.customRuntimes.enabled, true)
  assert.equal(kata.shims.disableAll, undefined)
  for (const tee of ['snp', 'tdx']) {
    const name = `qemu-nvidia-cpu-${tee}-runtime-rs`
    const base = `qemu-nvidia-gpu-${tee}-runtime-rs`
    const runtime = kata.customRuntimes.runtimes[name]
    const manifest = parse(runtime.runtimeClass)
    assert.equal(runtime.baseConfig, base)
    assert.equal(runtime.inheritBaseOverhead, true)
    assert.deepEqual(runtime.containerd, { snapshotter: 'nydus' })
    assert.deepEqual(runtime.crio, { pullType: 'guest-pull' })
    assert.equal(manifest.metadata.name, `kata-${name}`)
    assert.equal(manifest.handler, `kata-${name}`)
    assert.equal(manifest.scheduling.nodeSelector['kubernetes.io/arch'], 'amd64')
    assert.equal(manifest.scheduling.nodeSelector['nvidia.com/cc.ready.state'], undefined)
    const label = tee === 'snp'
      ? 'amd.feature.node.kubernetes.io/snp' : 'intel.feature.node.kubernetes.io/tdx'
    const resource = tee === 'snp' ? 'sev-snp.amd.com/esids' : 'tdx.intel.com/keys'
    assert.equal(manifest.scheduling.nodeSelector[label], 'true')
    assert.equal(manifest.overhead.podFixed[resource], '1')
    assert.deepEqual(kata.shims[base], { supportedArches: ['amd64'] })
    assert.equal(readFileSync(join(directory, `configuration-${base}.toml`), 'utf8'), fixture(tee))
    const digest = createHash('sha256').update(fixture(tee)).digest('hex')
    assert.ok(runtime.dropIn.includes(digest))
    // Model the pinned Kata drop-in merge, checking the full effective TOML.
    const verified = spawnSync(python, ['-c', `
import json,sys,tomllib
data=json.load(sys.stdin)
base=tomllib.loads(data['base'])
overlay=tomllib.loads(data['dropIn'])
expected=tomllib.loads(data['base'])
expected['hypervisor']['qemu']['guest_extension_images'] = [
 x for x in expected['hypervisor']['qemu']['guest_extension_images'] if x['name'] != 'gpu']
# Model common drop-ins enabling DCGM for an independently selected GPU handler.
base['hypervisor']['qemu']['kernel_params'] += ' nvrc.dcgm=on'
base['hypervisor']['qemu'].update(overlay['hypervisor']['qemu'])
assert base == expected
assert base['hypervisor']['qemu']['guest_extension_images'][0]['verity_params'] == data['hash']
`], { input: JSON.stringify({ base: fixture(tee), dropIn: runtime.dropIn, hash: cocohash }), encoding: 'utf8' })
    assert.equal(verified.status, 0, verified.stderr)
  }
})

test('CPU CC generation rejects incomplete or unsafe source configs without partial output', (t) => {
  const directory = prepare(t)
  const path = join(directory, 'configuration-qemu-nvidia-gpu-tdx-runtime-rs.toml')
  for (const [from, to, reason] of [
    ['confidential_guest = true', 'confidential_guest = false', 'confidential_guest'],
    ['sev_snp_guest = false', 'sev_snp_guest = true', 'CPU TEE'],
    ['name = "coco"', 'name = "other"', 'CoCo extension'],
    ['name = "gpu"', 'name = "coco"', 'GPU extension'],
    [cocohash, '', 'integrity metadata'],
    ['nvrc.smi.srs=1', 'nvrc.dcgm=on', 'without DCGM'],
    ['coco.img"', 'coco.img"\nunknown = "value"', 'unsupported extension fields'],
  ]) {
    writeFileSync(path, fixture('tdx').replace(from, to))
    const result = generate(directory)
    assert.equal(result.status, 1, reason)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes(reason), result.stderr)
  }
})

test('selecting TDX alone does not require an installed SNP config', (t) => {
  const directory = prepare(t)
  rmSync(join(directory, 'configuration-qemu-nvidia-gpu-snp-runtime-rs.toml'))
  const result = generate(directory, 'tdx')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)['kata-deploy'].customRuntimes.runtimes),
    ['qemu-nvidia-cpu-tdx-runtime-rs'])
  const missing = generate(directory)
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
})

test('KRAB round-trips CPU CC custom runtimes and preserves their deployment requirements', (t) => {
  const directory = prepare(t)
  const result = generate(directory)
  assert.equal(result.status, 0, result.stderr)
  const catalog = catalogData as ExplorerCatalog
  const custom = catalog.vendors.find(({ id }) => id === 'custom')!
  const original = JSON.parse(result.stdout)['kata-deploy'].customRuntimes
  const advanced = createAdvancedConfiguration()
  advanced.customRuntimes = Object.entries(original.runtimes).map(([name, config]) => {
    const preset = config as {
      baseConfig: string; dropIn: string; runtimeClass: string;
      inheritBaseOverhead: boolean; crio: { pullType: string };
    }
    return { name, baseConfig: preset.baseConfig, dropIn: preset.dropIn,
      runtimeClass: preset.runtimeClass, inheritBaseOverhead: preset.inheritBaseOverhead,
      crioPullType: preset.crio.pullType }
  })
  const runtime = { selectedShimIds: [], runtimeHttpsProxy: '', runtimeNoProxy: '',
    nvidiaDcgmEnabled: false }
  const source = buildValuesBundle(catalog, custom, {},
    { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
    runtime, advanced)
  const imported = importValuesBundle(catalog, source)
  assert.equal(imported.advanced.customRuntimes.length, 2)
  assert.deepEqual(imported.runtime.selectedShimIds, [])
  assert.deepEqual(imported.cluster.architectures, ['amd64'])
  const vendor = catalog.vendors.find(({ id }) => id === imported.vendorId)!
  const values = parse(buildValuesBundle(catalog, vendor, imported.selections,
    imported.cluster, imported.runtime, imported.advanced))
  const kata = values['kata-deploy']
  assert.equal(values['intel-tdx-qgs'].enabled, true)
  assert.equal(values['kata-device-plugin'].enabled, false)
  assert.equal(values['kata-device-provisioner'].enabled, false)
  assert.deepEqual(kata.snapshotter.setup, ['nydus'])
  assert.equal(kata.defaultShim, undefined)
  assert.deepEqual(kata.customRuntimes, original)
  for (const tee of ['snp', 'tdx']) {
    const base = `qemu-nvidia-gpu-${tee}-runtime-rs`
    assert.equal(kata.shims[base].enabled, false)
    assert.deepEqual(kata.shims[base].supportedArches, ['amd64'])
  }
  const withGpu = parse(buildValuesBundle(catalog, custom, {}, imported.cluster,
    { ...runtime, selectedShimIds: ['qemu-nvidia-gpu-tdx-runtime-rs'], nvidiaDcgmEnabled: true }, advanced))
  assert.equal(withGpu['kata-deploy'].shims['qemu-nvidia-gpu-tdx-runtime-rs'].enabled, true)
  assert.equal(withGpu['kata-deploy'].shims['qemu-nvidia-gpu-tdx-runtime-rs'].nvrc.enableDCGM, true)
  assert.deepEqual(withGpu['kata-deploy'].customRuntimes, original)
})
