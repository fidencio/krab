import type { HardwareFamilyCatalog, VendorCatalog } from './artifacts'
import Ajv from 'ajv'
import precheckSchema from '../../contracts/precheck-v1.schema.json' with { type: 'json' }
import catalog from '../generated/catalog.json' with { type: 'json' }

export type ProbeStatus = 'yes' | 'no' | 'unknown' | 'review'
export type RequestedCheck = 'tdx' | 'snp' | 'se' | 'gpu'
export const ANY_GPU_MODEL = 'any-gpu-model'
export const needsGpuType = (checks: RequestedCheck[], gpuModels: string[]) =>
  checks.includes('gpu') && gpuModels.length === 0
type Probe = { status: ProbeStatus; reason: string }

export type NodePrecheck = {
  schemaVersion: 1
  kind: 'krab-node-precheck'
  node: { architecture: string; kernel: string }
  checks: Record<'kvm' | 'tdx' | 'snp' | 'se' | 'iommufd' | 'erofs', Probe>
  erofsVersion?: string | null
  runtime?: { detected: string[]; layout: Probe }
  gpus: {
    present: Probe
    nvidia: Probe
    cc: Probe
    ppcie: Probe
    nvswitch: Probe
    devices: Array<{ name: string; pciBusId: string; chip?: string | null }>
  }
}

export function gpuModelChoices(families: ReadonlyArray<{ models: readonly string[] }>): string[] {
  const models = new Map<string, string>()
  for (const family of families) {
    for (const model of family.models) {
      const name = model.trim()
      if (name && !models.has(name.toUpperCase())) models.set(name.toUpperCase(), name)
    }
  }
  return [...models.values()]
}

const ajv = new Ajv()
const validateNodeReport = ajv.compile({ $ref: '#/definitions/nodeReport', definitions: precheckSchema.definitions })
const validateClusterReport = ajv.compile({ $ref: '#/definitions/clusterReport', definitions: precheckSchema.definitions })
const modelAliases = new Map(Object.entries(Object.assign({}, ...catalog.vendors
  .flatMap((vendor) => vendor.hardwareFamilies)
  .map((family) => family.modelAliases)))) as Map<string, string[]>

export function parseNodePrecheck(text: string): NodePrecheck {
  const data: unknown = JSON.parse(text)
  if (!validateNodeReport(data)) {
    throw new Error('This is not a supported KRAB node pre-check report.')
  }
  return data as NodePrecheck
}

export function parsePrecheckUpload(text: string, filename: string): Array<{ name: string; report: NodePrecheck }> {
  const data: unknown = JSON.parse(text)
  if (typeof data === 'object' && data !== null && 'kind' in data && data.kind === 'krab-cluster-precheck') {
    if (!validateClusterReport(data))
      throw new Error('Invalid KRAB cluster pre-check collection.')
    const collection = data as unknown as { nodes: Array<{ nodeName: string; report: NodePrecheck }> }
    const names = new Set<string>()
    return collection.nodes.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('nodeName' in entry) ||
          typeof entry.nodeName !== 'string' || !entry.nodeName || names.has(entry.nodeName) ||
          !('report' in entry)) throw new Error('Invalid or repeated node in cluster report.')
      names.add(entry.nodeName)
      return { name: entry.nodeName, report: parseNodePrecheck(JSON.stringify(entry.report)) }
    })
  }
  return [{ name: filename, report: parseNodePrecheck(text) }]
}

export const allNodesLack = (reports: NodePrecheck[], key: string) =>
  reports.length > 0 && reports.every((report) =>
    key in report.checks && report.checks[key as keyof NodePrecheck['checks']].status === 'no')

export function erofsPrecheckStatus(reports: NodePrecheck[]): 'confirmed' | 'provision' | 'unverified' {
  if (reports.length === 0) return 'unverified'
  return reports.every(({ checks }) => checks.erofs.status === 'yes') ? 'confirmed' : 'provision'
}

export function hasGpuModel(report: NodePrecheck, model: string): boolean {
  const aliases = modelAliases.get(model) ?? []
  return [model, ...aliases].some((candidate) => {
    const wanted = candidate.trim().replace(/\s+/g, ' ')
    if (!wanted) return true
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i')
    return report.gpus.devices.some(({ name, chip }) =>
      chip?.toLowerCase() === wanted.toLowerCase() || pattern.test(name.replace(/\s+/g, ' ')))
  })
}

export function unavailableShimReason(shim: { id: string; supportedArches: string[] }, reports: NodePrecheck[]): string | null {
  if (!reports.length) return null
  if (reports.every(({ node }) => !shim.supportedArches.includes(node.architecture)))
    return 'No uploaded node has a supported architecture.'
  if (allNodesLack(reports, 'kvm')) return 'KVM is unavailable on every uploaded node.'
  const tee = ['tdx', 'snp', 'se'].find((id) => shim.id.split('-').includes(id))
  if (tee && allNodesLack(reports, tee)) return `${tee.toUpperCase()} is unavailable on every uploaded node.`
  return null
}

const possibleFamilyOnNode = (family: HardwareFamilyCatalog, report: NodePrecheck) => {
  if (!family.supportedArches.includes(report.node.architecture) ||
      report.checks.kvm.status === 'no' || report.checks.iommufd.status === 'no' ||
      report.gpus.nvidia.status === 'no') return false
  if (family.id !== 'pcie-gpu' && report.gpus.devices.length > 0 &&
      !family.models.some((model) => hasGpuModel(report, model))) return false
  return true
}

export function unavailableFamilyReason(family: HardwareFamilyCatalog, reports: NodePrecheck[]): string | null {
  if (!reports.length) return null
  if (reports.every(({ node }) => !family.supportedArches.includes(node.architecture)))
    return 'No uploaded node has a supported architecture.'
  if (reports.every(({ checks }) => checks.kvm.status === 'no'))
    return 'KVM is unavailable on every uploaded node.'
  if (reports.every(({ checks }) => checks.iommufd.status === 'no'))
    return 'IOMMUFD is unavailable on every uploaded node.'
  if (reports.every(({ gpus }) => gpus.nvidia.status === 'no'))
    return 'No NVIDIA GPU was found on any uploaded node.'
  const hasDevices = reports.some(({ gpus }) => gpus.devices.length > 0)
  if (hasDevices && family.id !== 'pcie-gpu') {
    const matches = family.models.some((model) => reports.some((report) => hasGpuModel(report, model)))
    if (!matches) return `No ${family.displayName} GPU was found in the uploaded reports.`
  }
  if (!reports.some((report) => possibleFamilyOnNode(family, report)))
    return 'No uploaded node meets this GPU family’s confirmed prerequisites.'
  return null
}

export function unavailableModeReason(modeId: string, reports: NodePrecheck[], cpuTeeIds: string[] = [], family?: HardwareFamilyCatalog): string | null {
  if (!reports.length || modeId === 'off') return null
  const candidates = family ? reports.filter((report) => possibleFamilyOnNode(family, report)) : reports
  // The provisioner can change CC/PPCIE mode during installation, so the
  // GPU's pre-flight state must not disable a deployment mode.
  if (candidates.length === 0)
    return 'No uploaded node meets this mode’s confirmed prerequisites.'
  if (cpuTeeIds.length > 0 && candidates.every((report) =>
    cpuTeeIds.every((id) => report.checks[id as keyof NodePrecheck['checks']]?.status === 'no')))
    return 'No required CPU TEE is available on the uploaded nodes.'
  return null
}

export function unavailableVendorReason(vendor: VendorCatalog, reports: NodePrecheck[]): string | null {
  if (!reports.length) return null
  if (vendor.hardwareFamilies.some((family) =>
    family.availability === 'available' && !unavailableFamilyReason(family, reports))) return null
  if (vendor.runtime.shims.some((shim) =>
    (vendor.hardwareFamilies.length === 0 || shim.userSelectable) && !unavailableShimReason(shim, reports))) return null
  return 'No uploaded node supports this deployment path.'
}

function reportsMatchingChecks(reports: NodePrecheck[], checks: RequestedCheck[], gpuModels: string[]) {
  const tees = checks.filter((check) => check !== 'gpu')
  const requiredModels = checks.includes('gpu') ? gpuModels.filter((model) => model !== ANY_GPU_MODEL) : []
  return reports.filter((report) =>
    report.checks.kvm.status !== 'no' &&
    tees.every((tee) => report.checks[tee].status !== 'no') &&
    (!checks.includes('gpu') || (
      report.gpus.nvidia.status !== 'no' &&
      (requiredModels.length === 0 || report.gpus.devices.length === 0 ||
        requiredModels.some((model) => hasGpuModel(report, model))))))
}

export function unavailableFamilyForChecks(
  family: HardwareFamilyCatalog,
  reports: NodePrecheck[],
  checks: RequestedCheck[],
  gpuModels: string[],
): string | null {
  if (needsGpuType(checks, gpuModels)) return 'Select a GPU type to check node readiness.'
  const tees = checks.filter((check) => check !== 'gpu')
  const requiredModels = checks.includes('gpu') ? gpuModels.filter((model) => model !== ANY_GPU_MODEL) : []
  if (requiredModels.length > 0 && !family.models.some((model) => requiredModels.includes(model)))
    return 'This GPU family does not match the selected models.'
  if (tees.length > 0 && !family.modes.some((mode) => mode.supportedCpuTeeIds.includes(tees[0])))
    return 'This GPU family does not support the selected CPU TEE.'
  const candidates = reportsMatchingChecks(reports, checks, gpuModels)
  if (reports.length > 0 && candidates.length === 0)
    return 'No uploaded node meets all selected checks.'
  return unavailableFamilyReason(family, candidates)
}

export function unavailableModeForChecks(
  mode: { id: string; supportedCpuTeeIds: string[] },
  family: HardwareFamilyCatalog,
  reports: NodePrecheck[],
  checks: RequestedCheck[],
  gpuModels: string[],
): string | null {
  const tee = checks.find((check) => check !== 'gpu')
  if (tee && !mode.supportedCpuTeeIds.includes(tee))
    return 'This mode does not use the selected CPU TEE.'
  const familyReason = unavailableFamilyForChecks(family, reports, checks, gpuModels)
  if (familyReason) return familyReason
  return unavailableModeReason(mode.id, reportsMatchingChecks(reports, checks, gpuModels),
    tee ? [tee] : mode.supportedCpuTeeIds, family)
}

export function unavailableVendorForChecks(
  vendor: VendorCatalog,
  reports: NodePrecheck[],
  checks: RequestedCheck[],
  gpuModels: string[],
): string | null {
  if (checks.length === 0) return unavailableVendorReason(vendor, reports)
  if (needsGpuType(checks, gpuModels)) return 'Select a GPU type to check node readiness.'
  const tees = checks.filter((check) => check !== 'gpu')
  const requiredModels = checks.includes('gpu') ? gpuModels.filter((model) => model !== ANY_GPU_MODEL) : []
  if (tees.length > 1) return 'Selected CPU TEEs cannot run on the same node.'
  if (checks.includes('gpu') && vendor.hardwareFamilies.length === 0)
    return 'This path does not configure NVIDIA GPUs.'
  if (tees.length > 0 && !checks.includes('gpu') && vendor.id !== 'nvidia' &&
      !vendor.runtime.shims.some(({ id }) => id.split('-').includes(tees[0])))
    return `This path does not configure ${tees[0].toUpperCase()}.`

  const candidates = reportsMatchingChecks(reports, checks, gpuModels)
  if (reports.length > 0 && candidates.length === 0)
    return 'No uploaded node meets all selected checks.'

  if (vendor.id === 'nvidia' || (checks.includes('gpu') && vendor.hardwareFamilies.length > 0)) {
    const families = vendor.hardwareFamilies.filter((family) =>
      family.availability === 'available' &&
      (requiredModels.length === 0 || family.models.some((model) => requiredModels.includes(model))) &&
      (tees.length === 0 || family.modes.some((mode) => mode.supportedCpuTeeIds.includes(tees[0]))))
    if (families.length === 0) return 'No NVIDIA GPU path matches the selected checks and models.'
    if (reports.length > 0 && !families.some((family) =>
      !unavailableFamilyForChecks(family, candidates, checks, gpuModels) &&
      (tees.length === 0 || family.modes.some((mode) =>
        mode.supportedCpuTeeIds.includes(tees[0]) &&
        !unavailableModeForChecks(mode, family, candidates, checks, gpuModels)))))
      return 'No uploaded node supports a matching NVIDIA GPU path.'
    return null
  }
  return unavailableVendorReason(vendor, candidates)
}
