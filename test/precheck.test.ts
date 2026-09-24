import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import catalog from '../src/generated/catalog.json' with { type: 'json' }
import {
  allNodesLack,
  erofsPrecheckStatus,
  hasGpuModel,
  parseNodePrecheck,
  parsePrecheckUpload,
  unavailableFamilyReason,
  unavailableFamilyForChecks,
  unavailableModeReason,
  unavailableModeForChecks,
  unavailableShimReason,
  unavailableVendorReason,
  unavailableVendorForChecks,
  type NodePrecheck,
} from '../src/lib/precheck.ts'
import type { HardwareFamilyCatalog, VendorCatalog } from '../src/lib/artifacts.ts'

const probe = (status: 'yes' | 'no' | 'unknown') => ({ status, reason: 'fixture' })
const report = (arch = 'amd64'): NodePrecheck => ({
  kind: 'krab-node-precheck', schemaVersion: 1,
  node: { architecture: arch, kernel: '6.12.0' },
  checks: { kvm: probe('yes'), tdx: probe('unknown'), snp: probe('no'), se: probe('no'),
    iommufd: probe('yes'), erofs: probe('yes') },
  gpus: { present: probe('yes'), nvidia: probe('yes'), cc: probe('unknown'), ppcie: probe('unknown'),
    nvswitch: probe('unknown'), devices: [{ name: 'NVIDIA H100', pciBusId: '0000:01:00.0' }] },
})

const family = {
  id: 'hopper', displayName: 'NVIDIA HGX Hx00', supportedArches: ['amd64'], models: ['H100'],
} as HardwareFamilyCatalog

test('parses a versioned node report and rejects incomplete reports', () => {
  assert.deepEqual(parseNodePrecheck(JSON.stringify(report())), report())
  assert.throws(() => parseNodePrecheck('{"kind":"krab-node-precheck","schemaVersion":1}'))
})

test('accepts one complete cluster collection', () => {
  const collection = { kind: 'krab-cluster-precheck', schemaVersion: 1,
    nodes: [{ nodeName: 'worker-1', report: report() }, { nodeName: 'worker-2', report: report('arm64') }] }
  assert.deepEqual(parsePrecheckUpload(JSON.stringify(collection), 'cluster.json').map(({ name }) => name),
    ['worker-1', 'worker-2'])
  collection.nodes[1].nodeName = 'worker-1'
  assert.throws(() => parsePrecheckUpload(JSON.stringify(collection), 'cluster.json'))
})

test('accepts the existing example report', async () => {
  const example = await readFile(resolve(import.meta.dirname, '../examples/krab-precheck-example.json'), 'utf8')
  const nodes = parsePrecheckUpload(example, 'krab-precheck-example.json')
  assert.equal(nodes.length, 2)
  assert.equal(nodes.find(({ name }) => name === 'worker-h100')?.report.checks.tdx.status, 'yes')
})

test('accepts a 500-node collection within the upload limit', () => {
  const collection = {
    kind: 'krab-cluster-precheck', schemaVersion: 1,
    nodes: Array.from({ length: 500 }, (_, index) => ({
      nodeName: `worker-${index + 1}`,
      report: report(),
    })),
  }
  const example = JSON.stringify(collection)
  const nodes = parsePrecheckUpload(example, '500-nodes.json')
  assert.ok(Buffer.byteLength(example) < 10_000_000)
  assert.equal(nodes.length, 500)
  assert.equal(new Set(nodes.map(({ name }) => name)).size, 500)
})

test('GPU model matching uses complete model names', () => {
  const node = report()
  assert.equal(hasGpuModel(node, 'h100'), true)
  assert.equal(hasGpuModel(node, 'H200'), false)
  node.gpus.devices[0].name = 'NVIDIA GB200'
  assert.equal(hasGpuModel(node, 'B200'), false)
  assert.equal(hasGpuModel(node, 'GB200'), true)
  node.gpus.devices[0] = { name: 'NVIDIA GPU', chip: 'B200', pciBusId: '0000:01:00.0' }
  assert.equal(hasGpuModel(node, 'B200'), true)
  assert.equal(hasGpuModel(node, 'GB200'), false)
  node.gpus.devices = []
  assert.equal(hasGpuModel(node, 'GB200'), false)
})

test('EROFS is confirmed only when every checked node has it', () => {
  const first = report()
  const second = report()
  assert.equal(erofsPrecheckStatus([]), 'unverified')
  assert.equal(erofsPrecheckStatus([first, second]), 'confirmed')
  second.checks.erofs = probe('no')
  assert.equal(erofsPrecheckStatus([first, second]), 'provision')
  second.checks.erofs = probe('unknown')
  assert.equal(erofsPrecheckStatus([first, second]), 'provision')
})

test('definitive negatives block choices while unknowns remain available', () => {
  const node = report()
  assert.equal(unavailableFamilyReason(family, [node]), null)
  assert.equal(unavailableModeReason('ppcie', [node], ['tdx']), null)
  assert.equal(allNodesLack([node], 'tdx'), false)
  assert.equal(allNodesLack([node], 'snp'), true)
  assert.match(unavailableShimReason({ id: 'qemu-snp-runtime-rs', supportedArches: ['amd64'] }, [node])!, /SNP/)
  assert.match(unavailableFamilyReason(family, [report('arm64')])!, /architecture/)
  node.checks.iommufd = probe('no')
  assert.match(unavailableFamilyReason(family, [node])!, /IOMMUFD/)
})

test('one capable node preserves a choice in a mixed cluster', () => {
  const blocked = report()
  blocked.checks.tdx = probe('no')
  const possible = report()
  possible.checks.tdx = probe('yes')
  assert.equal(unavailableModeReason('ppcie', [blocked, possible], ['tdx']), null)
  assert.equal(allNodesLack([blocked, possible], 'tdx'), false)
})

test('current GPU CC mode does not rule out passthrough or PPCIE deployment', () => {
  const node = report()
  node.gpus.cc = probe('no')
  node.gpus.ppcie = probe('yes')
  assert.equal(unavailableFamilyReason(family, [node]), null)
  assert.equal(unavailableModeReason('off', [node], [], family), null)
  node.checks.tdx = probe('yes')
  node.gpus.ppcie = probe('no')
  assert.equal(unavailableModeReason('ppcie', [node], ['tdx'], family), null)
})

test('the first page can rule out an unsupported vendor path', () => {
  const intel = { hardwareFamilies: [], runtime: { shims: [
    { id: 'qemu-tdx-runtime-rs', supportedArches: ['amd64'] },
  ] } } as VendorCatalog
  const node = report()
  node.checks.tdx = probe('no')
  assert.match(unavailableVendorReason(intel, [node])!, /No uploaded node/)
  node.checks.tdx = probe('unknown')
  assert.equal(unavailableVendorReason(intel, [node]), null)
})

test('selected checks and GPU models restrict vendor cards', () => {
  const vendors = Object.fromEntries(catalog.vendors.map((vendor) => [vendor.id, vendor as VendorCatalog]))
  const available = (checks: Array<'tdx' | 'snp' | 'se' | 'gpu'>, models: string[] = [], nodes: NodePrecheck[] = []) =>
    catalog.vendors.filter((vendor) =>
      !unavailableVendorForChecks(vendor as VendorCatalog, nodes, checks, models)).map(({ id }) => id)

  assert.deepEqual(available(['tdx']), ['nvidia', 'intel'])
  assert.deepEqual(available(['snp']), ['nvidia', 'amd'])
  assert.deepEqual(available(['se']), ['ibm'])
  assert.deepEqual(available(['gpu']), ['nvidia'])
  assert.deepEqual(available(['tdx', 'gpu'], ['H100']), ['nvidia'])
  assert.deepEqual(available(['se', 'gpu']), [])
  assert.deepEqual(available(['tdx', 'snp']), [])
  assert.match(unavailableVendorForChecks(vendors.nvidia, [], ['tdx', 'gpu'], ['GB200'])!, /No NVIDIA GPU path/)

  const node = report()
  node.checks.tdx = probe('yes')
  assert.deepEqual(available(['tdx', 'gpu'], ['H100'], [node]), ['nvidia'])
  assert.deepEqual(available(['tdx', 'gpu'], ['H200'], [node]), [])
  node.checks.tdx = probe('no')
  assert.deepEqual(available(['tdx', 'gpu'], ['H100'], [node]), [])
})

test('NVIDIA GPU families and modes follow the selected checks', () => {
  const nvidia = catalog.vendors.find(({ id }) => id === 'nvidia')!
  const hopper = nvidia.hardwareFamilies.find(({ id }) => id === 'hopper') as HardwareFamilyCatalog
  const blackwell = nvidia.hardwareFamilies.find(({ id }) => id === 'blackwell') as HardwareFamilyCatalog
  const hopperOff = hopper.modes.find(({ id }) => id === 'off')!
  const hopperPpcie = hopper.modes.find(({ id }) => id === 'ppcie')!
  const blackwellOn = blackwell.modes.find(({ id }) => id === 'on')!

  assert.equal(unavailableFamilyForChecks(hopper, [], ['tdx', 'gpu'], ['H100']), null)
  assert.match(unavailableFamilyForChecks(blackwell, [], ['tdx', 'gpu'], ['H100'])!, /models/)
  assert.match(unavailableModeForChecks(hopperOff, hopper, [], ['tdx', 'gpu'], ['H100'])!, /CPU TEE/)
  assert.equal(unavailableModeForChecks(hopperPpcie, hopper, [], ['tdx', 'gpu'], ['H100']), null)
  assert.equal(unavailableModeForChecks(blackwellOn, blackwell, [], ['snp', 'gpu'], ['B200']), null)
})

test('pre-check chart reuses the pinned dispatcher and aggregates all node reports', async () => {
  const root = resolve(import.meta.dirname, '..')
  const values = parse(await readFile(resolve(root, 'charts/precheck/values.yaml'), 'utf8'))
  const jobs = await readFile(resolve(root, 'charts/precheck/templates/jobs.yaml'), 'utf8')
  const configmap = await readFile(resolve(root, 'charts/precheck/templates/configmap.yaml'), 'utf8')
  const collector = await readFile(resolve(root, 'charts/precheck/files/collect.sh'), 'utf8')
  const dockerfile = await readFile(resolve(root, 'Dockerfile.precheck'), 'utf8')
  const workflow = await readFile(resolve(root, '.github/workflows/release-chart.yml'), 'utf8')
  assert.equal(values.dispatcherImage, 'ghcr.io/kata-containers/k8s-job-dispatcher:0.4.0')
  assert.equal(values.nodeSelector, undefined)
  assert.match(jobs, /--job-template=\/etc\/krab\/node-job\.yaml/)
  assert.match(jobs, /--node-selector=krab\/preflight=true,kubernetes\.io\/os=linux/)
  assert.match(jobs, /helm\.sh\/hook-weight: "10"/)
  assert.match(configmap, /automountServiceAccountToken: false/)
  assert.match(configmap, /privileged: true/)
  assert.match(collector, /kind:"krab-cluster-precheck"/)
  assert.match(collector, /Node coverage mismatch/)
  assert.match(dockerfile, /COPY public\/node-precheck\.sh/)
  assert.match(dockerfile, /COPY --from=preflight-builder \/build\/target\/release\/krab-preflight/)
  assert.match(dockerfile, /kata-device-provisioner:0\.1\.0-alpha\.1/)
  assert.match(workflow, /linux\/amd64,linux\/arm64,linux\/ppc64le,linux\/s390x/)
  assert.equal(values.probeImage.repository, 'ghcr.io/fidencio/krab-preflight')
})

test('node reports are requested before vendor selection', async () => {
  const app = await readFile(resolve(import.meta.dirname, '../src/App.tsx'), 'utf8')
  const panel = await readFile(resolve(import.meta.dirname, '../src/NodePrecheckPanel.tsx'), 'utf8')
  assert.ok(app.indexOf('<NodePrecheckPanel') < app.indexOf('<div className="platform-directory">'))
  assert.equal(app.match(/<NodePrecheckPanel/g)?.length, 1)
  assert.match(panel, /krab\/preflight=true/)
  assert.match(panel, /oci:\/\/ghcr\.io\/fidencio\/krab-precheck/)
  assert.doesNotMatch(panel, /\.\/charts\/precheck/)
  assert.match(panel, /--timeout 35m/)
  assert.match(panel, /--namespace krab-precheck --create-namespace &&/)
  assert.match(panel, /kubectl --namespace krab-precheck logs/)
})
