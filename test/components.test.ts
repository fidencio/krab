import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import {
  buildValuesBundle, createAdvancedConfiguration, importValuesBundle,
  type ExplorerCatalog,
} from '../src/lib/artifacts.ts'

const catalog = catalogData as ExplorerCatalog
const vendor = catalog.vendors.find(({ id }) => id === 'custom')!
const keys = {
  nfd: 'node-feature-discovery', kataDeploy: 'kata-deploy',
  devicePlugin: 'kata-device-plugin', provisioner: 'kata-device-provisioner',
  qgs: 'intel-tdx-qgs',
} as const

test('device plugin targets NVIDIA GPU hardware independently of Kata deployment', () => {
  const defaults = parse(readFileSync(new URL('../charts/krab/values.yaml', import.meta.url), 'utf8'))
  const selector = {
    'katacontainers.io/kata-runtime': null,
    'feature.node.kubernetes.io/pci-0302_10de.present': 'true',
  }
  assert.deepEqual(defaults[keys.devicePlugin].nodeSelector, selector)
  for (const gpuVendor of catalog.vendors.filter(({ id }) => ['custom', 'nvidia'].includes(id))) {
    const advanced = createAdvancedConfiguration()
    advanced.components.kataDeploy = false
    advanced.components.provisioner = false
    const values = parse(buildValuesBundle(catalog, gpuVendor,
      { hopper: { enabled: true, modeId: 'off', cpuTeeIds: [] } },
      { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
      { selectedShimIds: [], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
      advanced))
    assert.equal(values[keys.devicePlugin].enabled, true)
    assert.deepEqual(values[keys.devicePlugin].nodeSelector, selector)
  }
})

test('independent component choices survive GPU values generation and import', () => {
  for (let mask = 0; mask < 32; mask++) {
    const advanced = createAdvancedConfiguration()
    Object.keys(keys).forEach((key, index) => {
      advanced.components[key as keyof typeof keys] = Boolean(mask & (1 << index))
    })
    const source = buildValuesBundle(catalog, vendor,
      { hopper: { enabled: true, modeId: 'ppcie', cpuTeeIds: ['tdx'] } },
      { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
      { selectedShimIds: ['qemu-tdx-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
      advanced)
    const values = parse(source)
    for (const [key, valuesKey] of Object.entries(keys)) {
      assert.equal(values[valuesKey].enabled, advanced.components[key as keyof typeof keys])
    }
    const imported = importValuesBundle(catalog, source)
    assert.deepEqual(imported.advanced.components, advanced.components)
    assert.deepEqual(imported.warnings, [], `combination ${mask}`)
    assert.deepEqual(parse(buildValuesBundle(catalog, vendor, imported.selections,
      imported.cluster, imported.runtime, imported.advanced)), values)
  }
})

test('an existing runtime is not required when Kata deployment is disabled', () => {
  const advanced = createAdvancedConfiguration()
  advanced.components.kataDeploy = false
  const source = buildValuesBundle(catalog, vendor, {},
    { distributionId: 'kubeadm', selinuxEnabled: false, architectures: [] },
    { selectedShimIds: [], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
    advanced)
  const imported = importValuesBundle(catalog, source)
  assert.equal(imported.advanced.components.kataDeploy, false)
  assert.deepEqual(imported.runtime.selectedShimIds, [])
})

test('QGS defaults follow TDX runtimes and explicit choices override them', () => {
  const runtime = { selectedShimIds: ['qemu-tdx-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false }
  const cluster = { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] }
  const advanced = createAdvancedConfiguration()
  const generate = () => parse(buildValuesBundle(catalog, vendor, {}, cluster, runtime, advanced))
  assert.equal(generate()['intel-tdx-qgs'].enabled, true)
  advanced.components.qgs = false
  assert.equal(generate()['intel-tdx-qgs'].enabled, false)
  advanced.components.qgs = null
  assert.equal(generate()['intel-tdx-qgs'].enabled, true)
  runtime.selectedShimIds = ['qemu-snp-runtime-rs']
  assert.equal(generate()['intel-tdx-qgs'].enabled, false)
  advanced.components.qgs = true
  assert.equal(generate()['intel-tdx-qgs'].enabled, true)
})

test('Custom QGS provisioning and existing SGX plugin settings survive values import', () => {
  for (const mode of ['Online', 'Offline', 'External'] as const) {
    const advanced = createAdvancedConfiguration()
    advanced.qgs = { mode, pcsApiKeySecretName: 'existing-pcs-key', deploySgxPlugin: false }
    const source = buildValuesBundle(catalog, vendor, {},
      { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
      { selectedShimIds: ['qemu-tdx-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
      advanced)
    const qgs = parse(source)['intel-tdx-qgs']
    assert.equal(qgs.enabled, true)
    assert.equal(qgs.tdxQuoteGenerationService.mode, mode)
    assert.equal(qgs.pcsApiKey.secretName, 'existing-pcs-key')
    assert.equal(qgs['intel-sgx-plugin'].enabled, false)
    const imported = importValuesBundle(catalog, source)
    assert.deepEqual(imported.advanced.qgs, advanced.qgs)
    assert.deepEqual(imported.warnings, [])
    assert.deepEqual(parse(buildValuesBundle(catalog, vendor, imported.selections,
      imported.cluster, imported.runtime, imported.advanced)), parse(source))
  }
})
