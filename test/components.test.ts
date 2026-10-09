import assert from 'node:assert/strict'
import test from 'node:test'
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
} as const

test('independent component choices survive GPU values generation and import', () => {
  for (let mask = 0; mask < 16; mask++) {
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
