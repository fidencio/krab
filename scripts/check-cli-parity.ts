import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  buildValuesBundle, createAdvancedConfiguration,
  type ExplorerCatalog, type FamilySelections,
} from '../src/lib/artifacts.ts'

// Run against a built native binary: KRAB_CLI_BINARY=/path/to/krab npm run test:cli-parity.
const binary = process.env.KRAB_CLI_BINARY ?? resolve('cli/target/debug/krab')
const catalog = JSON.parse(readFileSync('src/generated/catalog.json', 'utf8')) as ExplorerCatalog
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
          const input = stringify({ apiVersion: 'krab/v1alpha1', vendor: vendor.id, distribution: distribution.id,
            architectures: arches, selinux: configured, runtimes: selectedShimIds, hardware,
            components: advanced.components, runtime: { erofsMode, erofsFsverity: configured, installErofsUtils: configured,
              httpsProxy: runtime.runtimeHttpsProxy, noProxy: runtime.runtimeNoProxy, nvidiaDcgm: configured } })
          const context = `${vendor.id} ${JSON.stringify(hardware)} ${selectedShimIds} ${distribution.id} ${erofsMode}`
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
if (process.env.KRAB_CLI_FIXTURES) {
  writeFileSync(process.env.KRAB_CLI_FIXTURES, JSON.stringify(fixtures))
  console.log(`Wrote ${cases} CLI/web comparison fixtures.`)
} else {
  console.log(`CLI/web values parity passed for ${cases} configurations.`)
}
