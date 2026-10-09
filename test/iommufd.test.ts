import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import catalogData from '../src/generated/catalog.json' with { type: 'json' }
import { parseNodePrecheck, parsePrecheckUpload, unavailableFamilyReason } from '../src/lib/precheck.ts'
import { iommufdNeedsModuleSetup, iommufdSetupCommands } from '../src/lib/iommufd.ts'
import type { ExplorerCatalog } from '../src/lib/artifacts.ts'

const example = parsePrecheckUpload(readFileSync(new URL('../examples/krab-precheck-example.json', import.meta.url), 'utf8'), 'example.json')[0].report
test('an unloaded IOMMUFD module requests persistent setup and keeps GPU choices available', () => {
  const report = structuredClone(example)
  report.checks.iommufd = { status: 'unknown', reason: 'IOMMUFD module is installed; run sudo modprobe iommufd and persist it' }
  report.checks.kvm.status = 'yes'
  report.gpus.nvidia.status = 'yes'
  const parsed = parseNodePrecheck(JSON.stringify(report))
  assert.equal(iommufdNeedsModuleSetup(parsed), true)
  const family = (catalogData as ExplorerCatalog).vendors.find(({ id }) => id === 'nvidia')!
    .hardwareFamilies.find(({ id }) => id === 'pcie-gpu')!
  assert.equal(unavailableFamilyReason(family, [parsed]), null)
  assert.match(iommufdSetupCommands, /sudo modprobe iommufd/)
  assert.match(iommufdSetupCommands, /sudo tee \/etc\/modules-load\.d\/iommufd\.conf/)
})

test('ready devices and unsupported kernels do not request module setup', () => {
  const report = structuredClone(example)
  report.checks.iommufd = { status: 'yes', reason: 'iommufd is available' }
  assert.equal(iommufdNeedsModuleSetup(report), false)
  report.checks.iommufd = { status: 'no', reason: 'CONFIG_IOMMUFD is disabled' }
  assert.equal(iommufdNeedsModuleSetup(report), false)
})
