import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { parseAllDocuments } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import {
  buildValuesBundle,
  createAdvancedConfiguration,
  type ExplorerCatalog,
  type FamilySelections,
  type VendorCatalog,
} from '../src/lib/artifacts.ts'

const catalog = catalogData as ExplorerCatalog
const chart = resolve(import.meta.dirname, '../charts/krab')
const precheckChart = resolve(import.meta.dirname, '../charts/precheck')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'krab-helm-render-'))
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

function helm(...args: string[]) {
  return execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function packagedChart(source: string) {
  const directory = mkdtempSync(join(temporaryDirectory, 'package-'))
  helm('package', source, '--destination', directory)
  const archives = readdirSync(directory).filter((name) => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, `${source} should produce one chart archive`)
  return join(directory, archives[0])
}

type Manifest = {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> }
}

function verifyManifests(rendered: string, caseName: string) {
  const documents = parseAllDocuments(rendered, { uniqueKeys: true })
  const identities = new Set<string>()
  const resources: Manifest[] = []
  for (const [index, document] of documents.entries()) {
    assert.deepEqual(document.errors, [], `${caseName}: YAML document ${index + 1} is invalid`)
    const resource = document.toJS() as Manifest | null
    if (!resource) continue
    assert.ok(resource.apiVersion, `${caseName}: document ${index + 1} has no apiVersion`)
    assert.ok(resource.kind, `${caseName}: document ${index + 1} has no kind`)
    assert.ok(resource.metadata?.name, `${caseName}: document ${index + 1} has no name`)
    const identity = [resource.apiVersion, resource.kind, resource.metadata.namespace ?? '', resource.metadata.name].join('/')
    assert.ok(!identities.has(identity), `${caseName}: duplicate resource ${identity}`)
    identities.add(identity)
    resources.push(resource)
  }
  assert.ok(resources.length > 0, `${caseName}: no Kubernetes resources rendered`)
  return resources
}

function renderCase(caseName: string, archive: string, values?: string) {
  const args = ['template', 'krab', archive, '--namespace', 'kata-system']
  if (values) {
    const path = join(temporaryDirectory, `${caseName.replace(/[^a-z0-9-]+/gi, '-')}.yaml`)
    writeFileSync(path, values)
    args.push('--values', path)
  }
  const rendered = helm(...args)
  const resources = verifyManifests(rendered, caseName)
  const hasSource = (name: string) => rendered.includes(`# Source: krab/charts/${name}/templates/`)
  assert.ok(hasSource('node-feature-discovery'), `${caseName}: NFD did not render`)
  assert.ok(hasSource('kata-deploy'), `${caseName}: kata-deploy did not render`)
  const gpuEnabled = values ? Boolean(parseAllDocuments(values)[0].toJS()?.nvidia?.enabled) : false
  assert.equal(hasSource('kata-device-plugin'), gpuEnabled, `${caseName}: device plugin gate`)
  assert.equal(hasSource('kata-device-provisioner'), gpuEnabled, `${caseName}: provisioner gate`)
  assert.ok(!rendered.includes('# Source: krab/charts/kata-deploy/charts/node-feature-discovery/'),
    `${caseName}: kata-deploy installed a duplicate NFD release`)
  assert.ok(!rendered.includes('# Source: krab/charts/kata-device-provisioner/charts/node-feature-discovery/'),
    `${caseName}: provisioner installed a duplicate NFD release`)
  return resources
}

function generatedValues(vendor: VendorCatalog, selections: FamilySelections = {}, shimIds: string[] = []) {
  return buildValuesBundle(
    catalog,
    vendor,
    selections,
    { distributionId: 'kubeadm', selinuxEnabled: false, architectures: ['amd64'] },
    { selectedShimIds: shimIds, runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
    createAdvancedConfiguration(),
  )
}

test('packaged KRAB defaults and precheck chart lint and render as unique YAML resources', () => {
  helm('lint', '--strict', chart)
  helm('lint', '--strict', precheckChart)
  const krabArchive = packagedChart(chart)
  const precheckArchive = packagedChart(precheckChart)
  renderCase('KRAB defaults', krabArchive)
  const precheck = helm('template', 'krab-precheck', precheckArchive, '--namespace', 'krab-precheck')
  const resources = verifyManifests(precheck, 'precheck defaults')
  assert.equal(resources.filter((resource) => resource.kind === 'Job').length, 2)
  assert.ok(resources.some((resource) => resource.kind === 'ConfigMap'))
})

test('packaged KRAB chart renders each selectable runtime shim', async (t) => {
  const archive = packagedChart(chart)
  for (const vendor of catalog.vendors) {
    for (const shim of vendor.runtime.shims.filter((item) => item.userSelectable !== false)) {
      const caseName = `${vendor.id} runtime ${shim.id}`
      await t.test(caseName, () => {
        renderCase(caseName, archive, generatedValues(vendor, {}, [shim.id]))
      })
    }
  }
})

test('packaged KRAB chart renders each GPU family, mode, and CPU TEE', async (t) => {
  const archive = packagedChart(chart)
  for (const vendor of catalog.vendors.filter((item) => item.hardwareFamilies.length > 0)) {
    for (const family of vendor.hardwareFamilies.filter((item) => item.availability === 'available')) {
      for (const mode of family.modes) {
        for (const teeId of mode.supportedCpuTeeIds.length > 0 ? mode.supportedCpuTeeIds : [null]) {
          const caseName = `${vendor.id} ${family.id} ${mode.id} ${teeId ?? 'passthrough'}`
          const selections = { [family.id]: { enabled: true, modeId: mode.id, cpuTeeIds: teeId ? [teeId] : [] } }
          await t.test(caseName, () => {
            renderCase(caseName, archive, generatedValues(vendor, selections))
          })
        }
      }
    }
  }
})

test('Custom CPU and GPU selections render together with advanced runtime settings', () => {
  const archive = packagedChart(chart)
  const vendor = catalog.vendors.find((item) => item.id === 'custom')!
  const advanced = createAdvancedConfiguration()
  advanced.nodeSelector = [{ key: 'kubernetes.io/arch', value: 'amd64' }]
  advanced.nodeAffinity = [{ key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] }]
  advanced.tolerations = [{ key: 'dedicated', operator: 'Equal', value: 'kata', effect: 'NoSchedule' }]
  advanced.scheduledReconcileEnabled = true
  advanced.images.kataDeploy.pullSecrets = ['registry-key']
  const values = buildValuesBundle(
    catalog,
    vendor,
    { hopper: { enabled: true, modeId: 'ppcie', cpuTeeIds: ['tdx'] } },
    { distributionId: 'rke2', selinuxEnabled: true, architectures: ['amd64'] },
    { selectedShimIds: ['qemu-tdx-runtime-rs'], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
    advanced,
  )
  const resources = renderCase('Custom mixed advanced', archive, values)
  assert.ok(resources.some((resource) => resource.kind === 'RuntimeClass'))
  assert.ok(resources.some((resource) => resource.kind === 'CronJob'))
})
