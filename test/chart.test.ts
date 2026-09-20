import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import Ajv from 'ajv'
import { parse } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import {
  buildValuesBundle,
  type ExplorerCatalog,
} from '../src/lib/artifacts.ts'

const root = resolve(import.meta.dirname, '..')
const catalog = catalogData as unknown as ExplorerCatalog
const vendor = catalog.vendors[0]

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

  const generated = parse(
    buildValuesBundle(
      catalog,
      vendor,
      {
        hopper: { modeId: 'ppcie', cpuTeeIds: ['snp', 'tdx'] },
        blackwell: { modeId: 'on', cpuTeeIds: ['tdx'] },
      },
      { distributionId: 'rke2', selinuxEnabled: true },
    ),
  )

  assert.equal(validate(generated), true, JSON.stringify(validate.errors))
  assert.equal(generated.nvidia.enabled, true)
  assert.equal(
    generated['kata-device-provisioner']['node-feature-discovery'].enabled,
    false,
  )
  assert.ok(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'],
  )
  assert.ok(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'],
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'].ccMode,
    'ppcie',
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'].values,
    undefined,
  )
  assert.equal(
    generated['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'].profile,
    undefined,
  )
})

test('non-NVIDIA generated values omit conditional dependencies', () => {
  const generated = parse(
    buildValuesBundle(
      catalog,
      { ...vendor, id: 'other-vendor' },
      {},
      { distributionId: 'kubeadm', selinuxEnabled: false },
    ),
  )

  assert.equal(generated.nvidia.enabled, false)
  assert.equal(generated['kata-device-plugin'], undefined)
  assert.equal(generated['kata-device-provisioner'], undefined)
  assert.ok(generated['node-feature-discovery'])
  assert.ok(generated['kata-deploy'])
})
