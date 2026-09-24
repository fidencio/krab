import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import Ajv from 'ajv'
import { parse } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import {
  buildValuesBundle,
  createAdvancedConfiguration,
  type ExplorerCatalog,
} from '../src/lib/artifacts.ts'

const root = resolve(import.meta.dirname, '..')
const catalog = catalogData as unknown as ExplorerCatalog
const vendor = catalog.vendors.find(({ id }) => id === 'nvidia')!
const runtimeVendors = catalog.vendors.filter(
  ({ hardwareFamilies }) => hardwareFamilies.length === 0,
)

const readYaml = async (path: string) =>
  parse(await readFile(resolve(root, path), 'utf8'))

test('KRAB chart declares unconditional and NVIDIA dependencies', async () => {
  const chart = await readYaml('charts/krab/Chart.yaml')
  const dependencies = Object.fromEntries(
    chart.dependencies.map((dependency: { name: string }) => [
      dependency.name,
      dependency,
    ]),
  )

  assert.equal(chart.name, 'krab')
  assert.equal(dependencies['node-feature-discovery'].condition, undefined)
  assert.equal(dependencies['kata-deploy'].condition, undefined)
  assert.equal(dependencies['kata-device-plugin'].condition, 'nvidia.enabled')
  assert.equal(
    dependencies['kata-device-provisioner'].condition,
    'nvidia.enabled',
  )
})

test('front-page component versions match the packaged charts', async () => {
  const chart = await readYaml('charts/krab/Chart.yaml')
  const precheck = await readYaml('charts/precheck/Chart.yaml')
  const packageData = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const versions = catalog.plannedArchitecture.charts
  const dependencies = Object.fromEntries(
    chart.dependencies.map((dependency: { name: string; version: string }) =>
      [dependency.name, dependency.version]),
  )

  assert.equal(versions.krab.version, chart.version)
  assert.equal(versions.kataDeploy.version, dependencies['kata-deploy'])
  assert.equal(versions.nfd.version, dependencies['node-feature-discovery'])
  assert.equal(versions.devicePlugin.version, dependencies['kata-device-plugin'])
  assert.equal(versions.provisioner.version, dependencies['kata-device-provisioner'])
  assert.equal(precheck.version, packageData.version)
})

test('chart prerelease annotation matches its semantic version', async () => {
  const chart = await readYaml('charts/krab/Chart.yaml')
  const match = chart.version.match(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )

  assert.ok(match, `${chart.version} must be valid SemVer`)
  assert.equal(
    chart.annotations['artifacthub.io/prerelease'],
    String(match[1] !== undefined),
  )
})

test('chart defaults and generated values satisfy the values schema', async () => {
  const schema = JSON.parse(
    await readFile(resolve(root, 'charts/krab/values.schema.json'), 'utf8'),
  )
  const validate = new Ajv({ allErrors: true }).compile(schema)
  const defaults = await readYaml('charts/krab/values.yaml')

  assert.equal(validate(defaults), true, JSON.stringify(validate.errors))
  assert.equal(
    defaults['kata-device-provisioner']['node-feature-discovery'].enabled,
    false,
  )
  assert.deepEqual(defaults['kata-device-plugin'].image, {
    repository: 'ghcr.io/kata-containers/kata-device-plugin',
    tag: 'v0.2.0-rc.0',
  })

  const generated = parse(
    buildValuesBundle(
      catalog,
      vendor,
      {
        hopper: { modeId: 'ppcie', cpuTeeIds: ['snp', 'tdx'] },
        blackwell: { modeId: 'on', cpuTeeIds: ['tdx'] },
      },
      {
        distributionId: 'rke2',
        selinuxEnabled: true,
      },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      createAdvancedConfiguration(),
    ),
  )

  assert.equal(validate(generated), true, JSON.stringify(validate.errors))
  const custom = catalog.vendors.find(({ id }) => id === 'custom')!
  const mixed = parse(buildValuesBundle(
    catalog,
    custom,
    { hopper: { enabled: true, modeId: 'off', cpuTeeIds: [] } },
    { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
    { selectedShimIds: ['qemu-tdx-runtime-rs', 'qemu-snp-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
    createAdvancedConfiguration(),
  ))
  assert.equal(validate(mixed), true, JSON.stringify(validate.errors))
  assert.equal(generated.nvidia.enabled, true)
  assert.equal(
    generated['kata-device-provisioner']['node-feature-discovery'].enabled,
    false,
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'],
    undefined,
  )
  assert.ok(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'],
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'].ccMode,
    'ppcie',
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'].values,
    undefined,
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'].profile,
    undefined,
  )

  for (const runtimeVendor of runtimeVendors) {
    const runtimeGenerated = parse(
      buildValuesBundle(
        catalog,
        runtimeVendor,
        {},
        { distributionId: 'kubeadm', selinuxEnabled: false },
        {
          selectedShimIds: [runtimeVendor.runtime.shims[0].id],
          runtimeHttpsProxy: '',
          runtimeNoProxy: '',
          nvidiaDcgmEnabled: false,
        },
        createAdvancedConfiguration(),
      ),
    )
    assert.equal(
      validate(runtimeGenerated),
      true,
      JSON.stringify(validate.errors),
    )
    assert.equal(runtimeGenerated.nvidia.enabled, false)
    assert.equal(
      runtimeGenerated['kata-deploy'].snapshotter?.erofsMergeMode,
      undefined,
    )
  }
})

test('non-NVIDIA generated values omit conditional dependencies', () => {
  const generated = parse(
    buildValuesBundle(
      catalog,
      { ...vendor, id: 'other-vendor' },
      {},
      {
        distributionId: 'kubeadm',
        selinuxEnabled: false,
      },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      createAdvancedConfiguration(),
    ),
  )

  assert.equal(generated.nvidia.enabled, false)
  assert.equal(generated['kata-device-plugin'], undefined)
  assert.equal(generated['kata-device-provisioner'], undefined)
  assert.ok(generated['node-feature-discovery'])
  assert.ok(generated['kata-deploy'])
})
