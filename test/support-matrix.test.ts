import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import catalog from '../src/generated/catalog.json' with { type: 'json' }
import {
  buildValuesBundle,
  createAdvancedConfiguration,
  importValuesBundle,
  type ExplorerCatalog,
  type HardwareFamilyCatalog,
} from '../src/lib/artifacts.ts'
import {
  ANY_GPU_MODEL,
  hasGpuModel,
  parseNodePrecheck,
  unavailableFamilyForChecks,
  unavailableModeForChecks,
  type NodePrecheck,
} from '../src/lib/precheck.ts'

const explorer = catalog as ExplorerCatalog
const nvidia = explorer.vendors.find(({ id }) => id === 'nvidia')!

const inventory: Record<string, { architecture: string; chip: string }> = {
  blackwell: { architecture: 'amd64', chip: 'B200 SXM' },
  hopper: { architecture: 'amd64', chip: 'H100 SXM5 80GB' },
  'pcie-gpu': { architecture: 'amd64', chip: 'NVIDIA RTX 6000 Ada' },
}

async function nodeReport(family: HardwareFamilyCatalog, tee: string | null) {
  const example = JSON.parse(await readFile(resolve(import.meta.dirname,
    '../examples/krab-precheck-example.json'), 'utf8')) as {
    nodes: Array<{ report: NodePrecheck }>
  }
  const report = example.nodes[0].report
  const device = inventory[family.id]
  assert.ok(device, `Add an inventory fixture for ${family.id}`)
  report.node.architecture = device.architecture
  report.gpus.devices = [{ name: 'NVIDIA GPU', chip: device.chip, pciBusId: '0000:0a:00.0' }]
  report.checks.tdx.status = tee === 'tdx' ? 'yes' : 'no'
  report.checks.snp.status = tee === 'snp' ? 'yes' : 'no'
  return parseNodePrecheck(JSON.stringify(report))
}

test('every available GPU mode has a matching node report and install values', async () => {
  const families = nvidia.hardwareFamilies.filter(({ availability }) => availability === 'available')
  const policy = JSON.parse(await readFile(resolve(import.meta.dirname,
    '../upstream/compatibility.json'), 'utf8')) as {
    families: Record<string, { availability: string; profiles: Record<string, unknown> }>
  }
  assert.deepEqual(families.map(({ id }) => id), Object.entries(policy.families)
    .filter(([, definition]) => definition.availability === 'available')
    .map(([id]) => id))

  for (const family of families) {
    for (const mode of family.modes) {
      for (const tee of mode.supportedCpuTeeIds.length ? mode.supportedCpuTeeIds : [null]) {
        const report = await nodeReport(family, tee)
        const model = family.models[0]
        const checks = tee ? ['gpu', tee] as Array<'gpu' | 'tdx' | 'snp'> : ['gpu'] as Array<'gpu'>
        const selectedModels = model ? [model] : [ANY_GPU_MODEL]
        if (model) assert.equal(hasGpuModel(report, model), true, `${family.id}: ${model}`)
        assert.equal(unavailableFamilyForChecks(family, [report], checks, selectedModels), null,
          `${family.id}: ${mode.id} ${tee ?? ''}`)
        assert.equal(unavailableModeForChecks(mode, family, [report], checks, selectedModels), null,
          `${family.id}: ${mode.id} ${tee ?? ''}`)

        const values = buildValuesBundle(
          explorer, nvidia,
          { [family.id]: { enabled: true, modeId: mode.id, cpuTeeIds: tee ? [tee] : [] } },
          { distributionId: 'kubeadm', selinuxEnabled: false, architectures: [report.node.architecture] },
          { selectedShimIds: [], runtimeHttpsProxy: '', runtimeNoProxy: '', nvidiaDcgmEnabled: false },
          createAdvancedConfiguration(),
        )
        const generated = parse(values)
        const profiles = generated['kata-device-provisioner'].profiles
        assert.equal(Object.keys(profiles).length, 1, `${family.id}: ${mode.id} ${tee ?? ''}`)
        assert.ok(Object.keys(profiles)[0].startsWith(mode.profileName))
        const profile = Object.values(profiles)[0] as { ccMode: string; enabled: boolean }
        assert.equal(profile.ccMode, mode.id)
        assert.equal(profile.enabled, true)
        const imported = importValuesBundle(explorer, values)
        assert.equal(imported.selections[family.id].modeId, mode.id)
      }
    }
  }
})
