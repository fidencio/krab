import assert from 'node:assert/strict'
import test from 'node:test'
import { parse, stringify } from 'yaml'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import {
  buildValuesBundle,
  createAdvancedConfiguration,
  importValuesBundle,
  type ExplorerCatalog,
} from '../src/lib/artifacts.ts'

const catalog = catalogData as ExplorerCatalog
const vendor = catalog.vendors.find(({ id }) => id === 'nvidia')!
const version = catalog.plannedArchitecture.charts.krab.version
const marked = (data: unknown) => `# KRAB values format: 2\n# KRAB chart version: ${version}\n${stringify(data)}`
const values = buildValuesBundle(
  catalog, vendor,
  { hopper: { enabled: true, modeId: 'off', cpuTeeIds: [] } },
  { distributionId: 'kubeadm', selinuxEnabled: false },
  { selectedShimIds: [], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
  createAdvancedConfiguration(),
)

test('generated values carry a format and chart version', () => {
  assert.match(values, /^# KRAB values format: 2$/m)
  assert.match(values, new RegExp(`^# KRAB chart version: ${version.replaceAll('.', '\\.')}$`, 'm'))
  assert.deepEqual(importValuesBundle(catalog, values).warnings, [])
})

test('compatible v2 values retain their deployment name while unversioned values are rejected', () => {
  const importedVersion = `${version}-import-test`
  const older = values.replace(`# KRAB chart version: ${version}`, `# KRAB chart version: ${importedVersion}`)
  const imported = importValuesBundle(catalog, older, `demo-${importedVersion}-values.yaml`)
  assert.equal(imported.deploymentName, 'demo')
  assert.ok(imported.warnings[0]?.includes(`made for KRAB ${importedVersion}`))
  const legacy = values.replace(/^# KRAB (?:values format|chart version): .*\n/gm, '')
  assert.throws(() => importValuesBundle(catalog, legacy), /Unsupported KRAB values format/)
})

test('import warns when a retained field changes on regeneration', () => {
  const changed = parse(values)
  changed['kata-deploy'].deploymentMode = 'daemonset'
  const imported = importValuesBundle(catalog, marked(changed))
  assert.ok(imported.warnings.some((warning) =>
    /kata-deploy.deploymentMode/.test(warning)))
})

test('changed or unknown chart fields fail instead of being discarded', () => {
  assert.throws(() => importValuesBundle(catalog,
    values.replace('# KRAB values format: 2', '# KRAB values format: 1')),
  /Unsupported KRAB values format/)

  const unknownRoot = parse(values)
  unknownRoot.removedDependency = {}
  assert.throws(() => importValuesBundle(catalog, marked(unknownRoot)),
    /does not match the current KRAB chart/)

  const unknownNested = parse(values)
  unknownNested['kata-deploy'].removedSetting = true
  assert.throws(() => importValuesBundle(catalog, marked(unknownNested)),
    /cannot preserve these imported fields: kata-deploy.removedSetting/)

  const unknownShim = parse(values)
  unknownShim['kata-deploy'].shims['removed-runtime'] = { enabled: true }
  assert.throws(() => importValuesBundle(catalog, marked(unknownShim)),
    /RuntimeClass removed-runtime is not available/)

  const unknownProfile = parse(values)
  unknownProfile['kata-device-provisioner'].profiles['old-profile'] = {
    enabled: true, ccMode: 'off',
  }
  assert.throws(() => importValuesBundle(catalog, marked(unknownProfile)),
    /profile old-profile is not available/)

  const changedMode = parse(values)
  changedMode['kata-device-provisioner'].profiles['HGX-Hx00'].ccMode = 'on'
  assert.throws(() => importValuesBundle(catalog, marked(changedMode)),
    /profile HGX-Hx00 has a different mode/)
})
