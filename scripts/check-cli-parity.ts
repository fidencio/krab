import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  buildValuesBundle, buildCliConfiguration, createAdvancedConfiguration, validateCliConfiguration,
  type ExplorerCatalog, type FamilySelections,
} from '../src/lib/artifacts.ts'

// Run against a built native binary: KRAB_CLI_BINARY=/path/to/krab npm run test:cli-parity.
const binary = process.env.KRAB_CLI_BINARY ?? resolve('cli/target/debug/krab')
const catalog = JSON.parse(readFileSync('src/generated/catalog.json', 'utf8')) as ExplorerCatalog
if (!process.env.KRAB_CLI_FIXTURES) {
  const embedded = spawnSync(binary, ['list', 'catalog', '--json'], { encoding: 'utf8' })
  assert.equal(embedded.status, 0, embedded.stderr)
  assert.deepEqual(JSON.parse(embedded.stdout), catalog, 'CLI must embed the exact website catalog')
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), `krab ${catalog.plannedArchitecture.charts.krab.version}`)
}
let cases = 0
const fixtures: Array<{ context: string; input: string; expected: unknown }> = []
for (const vendor of catalog.vendors) {
  const selections: FamilySelections[] = [{}]
  for (const family of vendor.hardwareFamilies) {
    if (family.availability !== 'available') continue
    for (const mode of family.modes) {
      const teeSets = mode.id === 'off' ? [[]] : [mode.supportedCpuTeeIds, ...mode.supportedCpuTeeIds.map((id) => [id])]
      for (const cpuTeeIds of teeSets) {
        selections.push({ [family.id]: { enabled: true, modeId: mode.id, cpuTeeIds } })
      }
    }
  }
  for (const selection of selections) {
    const selectedFamilies = vendor.hardwareFamilies.filter((f) => selection[f.id])
    const runtimeSets = Object.keys(selection).length
      ? [[]]
      : vendor.runtime.shims.map(({ id }) => [id])
    for (const selectedShimIds of runtimeSets) {
      const arches = selectedFamilies.length
        ? selectedFamilies[0].supportedArches
        : vendor.runtime.shims.find(({ id }) => id === selectedShimIds[0])!.supportedArches
      for (const distribution of catalog.plannedArchitecture.cluster.distributions) {
        for (const erofsMode of ['memory', 'disk'] as const) {
          const configured = erofsMode === 'disk'
          const cluster = { distributionId: distribution.id, selinuxEnabled: configured, architectures: arches }
          const runtime = { selectedShimIds, runtimeHttpsProxy: configured ? 'https://proxy.test:8443' : '',
            runtimeNoProxy: configured ? 'localhost,.cluster.local' : '', nvidiaDcgmEnabled: configured }
          const advanced = createAdvancedConfiguration()
          advanced.erofsSnapshotterMode = erofsMode
          advanced.erofsEnableFsverity = configured
          advanced.installErofsUtils = configured
          if (configured) advanced.components = { nfd: false, kataDeploy: true, devicePlugin: false, provisioner: false, qgs: true }
          const expected = parse(buildValuesBundle(catalog, vendor, selection, cluster, runtime, advanced))
          const hardware = Object.fromEntries(Object.entries(selection).map(([id, choice]) => [id, { mode: choice.modeId, cpuTees: choice.cpuTeeIds }]))
          const input = stringify(buildCliConfiguration(vendor, selection, cluster, runtime, advanced))
          const context = `${vendor.id} ${JSON.stringify(hardware)} ${selectedShimIds} ${distribution.id} ${erofsMode}`
          const invalid = validateCliConfiguration(parse(input), catalog)
          if (invalid && Object.values(distribution.unsupportedSnapshotters ?? {}).some(reason => invalid.includes(reason))) {
            if (!process.env.KRAB_CLI_FIXTURES) {
              const rejected = spawnSync(binary, ['generate', '--config', '-', '--json'], { input, encoding: 'utf8' })
              assert.equal(rejected.status, 2, context)
              assert.ok(rejected.stderr.includes(invalid), rejected.stderr)
            }
            continue
          }
          if (process.env.KRAB_CLI_FIXTURES) {
            fixtures.push({ context, input, expected })
            cases++
            continue
          }
          const result = spawnSync(binary, ['generate', '--config', '-', '--json'], { input, encoding: 'utf8' })
          assert.equal(result.status, 0, `${context}\n${result.error ?? result.stderr}`)
          assert.deepEqual(parse(result.stdout), expected, context)
          cases++
        }
      }
    }
  }
}
// Exercise the complete website advanced form, not just defaults.
for (const vendor of catalog.vendors) {
  for (const distribution of catalog.plannedArchitecture.cluster.distributions) {
    for (const shim of vendor.runtime.shims.filter(shim => !shim.derivedBase)) {
      const advanced = createAdvancedConfiguration()
      advanced.debug = true
      advanced.qgs = { mode: 'Offline', pcsApiKeySecretName: ' pcs-key ', deploySgxPlugin: false }
      advanced.containerdConfigDir = ' /etc/containerd '
      advanced.containerdRuntimeSocket = ' /run/containerd/containerd.sock '
      advanced.containerdConfigFileName = ' config.toml '
      advanced.containerdUserDropIn = '[debug]\n  level = "debug"\n'
      advanced.shimDropIns = { [shim.id]: '[hypervisor.qemu]\n  default_vcpus = 4\n' }
      advanced.customRuntimes = [{ name: 'my-runtime', baseConfig: shim.id,
        dropIn: '[agent.kata]\n  debug = true\n', runtimeClass: 'kata-my-runtime',
        inheritBaseOverhead: false, crioPullType: 'guest-pull' }]
      advanced.nodeSelector = [{ key: ' pool ', value: ' kata ' }]
      advanced.nodeAffinity = [{ key: ' zone ', operator: 'In', values: [' eu ', ''] },
        { key: 'maintenance', operator: 'DoesNotExist', values: [] }]
      advanced.tolerations = [{ key: ' kata ', operator: 'Equal', value: ' true ', effect: 'NoSchedule' },
        { key: 'gpu', operator: 'Exists', value: '', effect: '' }]
      advanced.scheduledReconcileEnabled = true
      advanced.scheduledReconcileSchedule = ' */30 * * * * '
      advanced.erofsSnapshotterMode = 'disk'
      advanced.erofsDiskSize = '512M'
      advanced.erofsDmverity = false
      advanced.erofsEnableFsverity = true
      advanced.installErofsUtils = true
      advanced.erofsUtilsImage = 'registry.test/erofs:custom'
      advanced.components = { nfd: false, kataDeploy: true, devicePlugin: true, provisioner: true, qgs: null }
      for (const image of Object.values(advanced.images)) {
        Object.assign(image, { reference: ' registry.test/image ', tag: ' test ', pullPolicy: 'Always',
          pullSecrets: [' registry-key ', ''], dispatcherReference: 'registry.test/dispatcher', dispatcherTag: 'v1' })
      }
      advanced.images.kataDeploy.kubectlReference = 'registry.test/kubectl'
      advanced.images.kataDeploy.kubectlTag = 'v2'
      const cluster = { distributionId: distribution.id, selinuxEnabled: true, architectures: shim.supportedArches }
      const runtime = { selectedShimIds: [shim.id], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false }
      if (vendor.id === 'custom') runtime.selectedShimIds = []
      const expected = parse(buildValuesBundle(catalog, vendor, {}, cluster, runtime, advanced))
      const input = stringify(buildCliConfiguration(vendor, {}, cluster, runtime, advanced))
      const context = `advanced ${vendor.id} ${distribution.id} ${shim.id}`
      const invalid = validateCliConfiguration(parse(input), catalog)
      if (invalid && Object.values(distribution.unsupportedSnapshotters ?? {}).some(reason => invalid.includes(reason))) {
        if (!process.env.KRAB_CLI_FIXTURES) {
          const rejected = spawnSync(binary, ['generate', '--config', '-', '--json'], { input, encoding: 'utf8' })
          assert.equal(rejected.status, 2, context)
          assert.ok(rejected.stderr.includes(invalid), rejected.stderr)
        }
        continue
      }
      if (process.env.KRAB_CLI_FIXTURES) fixtures.push({ context, input, expected })
      else {
        const result = spawnSync(binary, ['generate', '--config', '-', '--json'], { input, encoding: 'utf8' })
        assert.equal(result.status, 0, `${context}\n${result.error ?? result.stderr}`)
        assert.deepEqual(parse(result.stdout), expected, context)
      }
      cases++
    }
  }
}
// CPU presets and continuous conformance use the same full engine in both clients.
const cpuVendor = catalog.vendors.find(({ id }) => id === 'custom')!
for (const selectedShimIds of [['qemu-nvidia-cpu-tdx-runtime-rs'], ['qemu-nvidia-cpu-snp-runtime-rs'], ['qemu-nvidia-cpu-tdx-runtime-rs', 'qemu-nvidia-cpu-snp-runtime-rs']]) {
  for (const distribution of catalog.plannedArchitecture.cluster.distributions) {
    for (const continuous of [false, true]) {
      const advanced = createAdvancedConfiguration()
      advanced.continuousConformance = continuous
      const cluster = { distributionId: distribution.id, selinuxEnabled: false, architectures: ['amd64'] }
      const runtime = { selectedShimIds, runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false }
      const input = stringify(buildCliConfiguration(cpuVendor, {}, cluster, runtime, advanced))
      const expected = parse(buildValuesBundle(catalog, cpuVendor, {}, cluster, runtime, advanced))
      const context = `NVIDIA CPU ${selectedShimIds} ${distribution.id} continuous=${continuous}`
      if (process.env.KRAB_CLI_FIXTURES) fixtures.push({ context, input, expected })
      else {
        const result = spawnSync(binary, ['generate', '--config', '-', '--json'], { input, encoding: 'utf8' })
        assert.equal(result.status, 0, `${context}\n${result.error ?? result.stderr}`)
        assert.deepEqual(parse(result.stdout), expected, context)
      }
      cases++
    }
  }
}
if (process.env.KRAB_CLI_FIXTURES) {
  writeFileSync(process.env.KRAB_CLI_FIXTURES, JSON.stringify(fixtures))
  console.log(`Wrote ${cases} CLI/web comparison fixtures.`)
} else {
  console.log(`CLI/web values parity passed for ${cases} configurations.`)
}
