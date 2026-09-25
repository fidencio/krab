import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import catalog from '../src/generated/catalog.json' with { type: 'json' }
import {
  allNodesLack,
  erofsPrecheckStatus,
  gpuModelChoices,
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
import { precheckCommand } from '../src/lib/precheck-command.ts'
import precheckSchema from '../contracts/precheck-v1.schema.json' with { type: 'json' }
import commandConfig from '../upstream/precheck-command.json' with { type: 'json' }
import packageData from '../package.json' with { type: 'json' }

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
  const invalid = report()
  invalid.gpus.devices[0].name = 3 as unknown as string
  assert.throws(() => parseNodePrecheck(JSON.stringify(invalid)))
  assert.throws(() => parseNodePrecheck(JSON.stringify({ ...report(), newField: true })))
  assert.deepEqual(precheckSchema.definitions.nodeReport.properties.checks.required,
    ['kvm', 'tdx', 'snp', 'se', 'iommufd', 'erofs'])
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
  node.gpus.devices[0].chip = 'H100 SXM5 80GB'
  assert.equal(hasGpuModel(node, 'H100'), true)
  assert.equal(hasGpuModel(node, 'H200'), false)
  node.gpus.devices = []
  assert.equal(hasGpuModel(node, 'GB200'), false)
})

test('precheck model choices follow profiles, including pending families', () => {
  const families = catalog.vendors.find((vendor) => vendor.id === 'nvidia')!.hardwareFamilies
  const choices = gpuModelChoices(families)
  assert.deepEqual(choices, [...new Set(families.flatMap(({ models }) => models))])
  assert.ok(families.some((family) => family.availability === 'pending' &&
    family.models.some((model) => choices.includes(model))))
  assert.deepEqual(gpuModelChoices([{ models: [' H100 ', 'H200'] }, { models: ['h100', 'B200', ''] }]),
    ['H100', 'H200', 'B200'])
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

  assert.deepEqual(available(['tdx']), ['nvidia', 'custom', 'intel'])
  assert.deepEqual(available(['snp']), ['nvidia', 'custom', 'amd'])
  assert.deepEqual(available(['se']), ['custom', 'ibm'])
  assert.deepEqual(available(['gpu']), ['nvidia', 'custom'])
  assert.deepEqual(available(['tdx', 'gpu'], ['H100']), ['nvidia', 'custom'])
  assert.deepEqual(available(['se', 'gpu']), [])
  assert.deepEqual(available(['tdx', 'snp']), [])
  assert.match(unavailableVendorForChecks(vendors.nvidia, [], ['tdx', 'gpu'], ['GB200'])!, /No NVIDIA GPU path/)

  const node = report()
  node.checks.tdx = probe('yes')
  assert.deepEqual(available(['tdx', 'gpu'], ['H100'], [node]), ['nvidia', 'custom'])
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
  const imageLock = JSON.parse(await readFile(resolve(root, 'upstream/precheck-image.lock.json'), 'utf8'))
  const workflow = await readFile(resolve(root, '.github/workflows/release-chart.yml'), 'utf8')
  const provisioner = catalog.vendors.find((vendor) => vendor.id === 'nvidia')!.provisioner
  const dispatcher = provisioner.values.job.dispatcherImage
  assert.equal(values.dispatcherImage, `${dispatcher.reference}:${dispatcher.tag}`)
  assert.equal(values.nodeSelector, undefined)
  assert.match(jobs, /--job-template=\/etc\/krab\/node-job\.yaml/)
  assert.match(jobs, /--node-selector=krab\/preflight=true,kubernetes\.io\/os=linux/)
  assert.match(jobs, /helm\.sh\/hook-weight: "10"/)
  assert.match(configmap, /automountServiceAccountToken: false/)
  assert.match(configmap, /privileged: true/)
  assert.match(collector, /kind:"krab-cluster-precheck"/)
  assert.match(collector, /Node coverage mismatch/)
  assert.match(dockerfile, /COPY --from=preflight-builder \/build\/runtime\/ \/$/m)
  assert.match(dockerfile, /amd64\|arm64\) cp "\/build\/provisioner-\$TARGETARCH"/)
  assert.match(dockerfile, /ppc64le\|s390x\) ;;/)
  assert.ok(dockerfile.includes(`${imageLock.reference}:${imageLock.tag}@${imageLock.digest}`))
  assert.match(dockerfile, /FROM gcr\.io\/distroless\/cc-debian13:latest/)
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/krab-preflight", "--node-report"\]/)
  assert.doesNotMatch(dockerfile, /apt-get|\/bin\/bash|\/usr\/bin\/jq/)
  assert.match(workflow, /linux\/amd64,linux\/arm64,linux\/ppc64le,linux\/s390x/)
  assert.equal(values.probeImage.repository, 'ghcr.io/fidencio/krab-preflight')
})

test('node reports are requested before vendor selection', async () => {
  const app = await readFile(resolve(import.meta.dirname, '../src/App.tsx'), 'utf8')
  const panel = await readFile(resolve(import.meta.dirname, '../src/NodePrecheckPanel.tsx'), 'utf8')
  assert.ok(app.indexOf('<NodePrecheckPanel') < app.indexOf('<div className="platform-directory">'))
  assert.equal(app.match(/<NodePrecheckPanel/g)?.length, 1)
  assert.match(panel, /krab\/preflight=true/)
  assert.match(panel, /precheckCommand\(chartVersion\)/)
  assert.doesNotMatch(panel, /\.\/charts\/precheck/)
  const command = precheckCommand('0.1.0-test')
  assert.match(command, /--timeout 35m/)
  assert.match(command, /--namespace krab-precheck --create-namespace &&/)
  assert.match(command, /kubectl --namespace krab-precheck logs/)
  assert.match(command, new RegExp(commandConfig.ociReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const readme = await readFile(resolve(import.meta.dirname, '../README.md'), 'utf8')
  assert.ok(readme.includes(precheckCommand(packageData.version)))
})
