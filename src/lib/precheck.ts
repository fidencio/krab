import type { HardwareFamilyCatalog, VendorCatalog } from './artifacts'

export type ProbeStatus = 'yes' | 'no' | 'unknown' | 'review'
export type RequestedCheck = 'tdx' | 'snp' | 'se' | 'gpu'
type Probe = { status: ProbeStatus; reason: string }

export type NodePrecheck = {
  schemaVersion: 1
  kind: 'krab-node-precheck'
  node: { architecture: string; kernel: string }
  checks: Record<'kvm' | 'tdx' | 'snp' | 'se' | 'iommufd' | 'erofs', Probe>
  gpus: {
    present: Probe
    nvidia: Probe
    cc: Probe
    ppcie: Probe
    nvswitch: Probe
    devices: Array<{ name: string; pciBusId: string; chip?: string | null }>
  }
}

const probeStatuses: ProbeStatus[] = ['yes', 'no', 'unknown', 'review']
const isProbe = (value: unknown): value is Probe =>
  typeof value === 'object' && value !== null &&
  'status' in value && probeStatuses.includes(value.status as ProbeStatus) &&
  'reason' in value && typeof value.reason === 'string'

export function parseNodePrecheck(text: string): NodePrecheck {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null) throw new Error('Invalid node report.')
  const report = data as NodePrecheck
  if (report.kind !== 'krab-node-precheck' || report.schemaVersion !== 1 ||
      !report.node || typeof report.node.architecture !== 'string' ||
      typeof report.node.kernel !== 'string' || !report.checks || !report.gpus ||
      !Array.isArray(report.gpus.devices) ||
      !['kvm', 'tdx', 'snp', 'se', 'iommufd', 'erofs'].every((key) =>
        isProbe(report.checks[key as keyof NodePrecheck['checks']])) ||
      !['present', 'nvidia', 'cc', 'ppcie', 'nvswitch'].every((key) =>
        isProbe(report.gpus[key as keyof Pick<NodePrecheck['gpus'], 'present' | 'nvidia' | 'cc' | 'ppcie' | 'nvswitch'>]))) {
    throw new Error('This is not a supported KRAB node pre-check report.')
  }
  return report
}

export function parsePrecheckUpload(text: string, filename: string): Array<{ name: string; report: NodePrecheck }> {
  const data: unknown = JSON.parse(text)
  if (typeof data === 'object' && data !== null && 'kind' in data && data.kind === 'krab-cluster-precheck') {
    const collection = data as { schemaVersion?: unknown; nodes?: unknown }
    if (collection.schemaVersion !== 1 || !Array.isArray(collection.nodes) || collection.nodes.length === 0)
      throw new Error('Invalid KRAB cluster pre-check collection.')
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
  const wanted = model.trim().replace(/\s+/g, ' ')
  if (!wanted) return true
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i')
  return report.gpus.devices.some(({ name, chip }) =>
    chip?.toLowerCase() === wanted.toLowerCase() || pattern.test(name.replace(/\s+/g, ' ')))
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
      !family.models.some((model) => report.gpus.devices.some(({ name }) =>
        name.toLowerCase().includes(model.toLowerCase())))) return false
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
  const names = reports.flatMap(({ gpus }) => gpus.devices.map(({ name }) => name.toLowerCase()))
  if (names.length > 0 && family.id !== 'pcie-gpu') {
    const matches = family.models.some((model) => names.some((name) => name.includes(model.toLowerCase())))
    if (!matches) return `No ${family.displayName} GPU was found in the uploaded reports.`
  }
  if (!reports.some((report) => possibleFamilyOnNode(family, report)))
    return 'No uploaded node meets this GPU family’s confirmed prerequisites.'
  return null
}

export function unavailableModeReason(modeId: string, reports: NodePrecheck[], cpuTeeIds: string[] = [], family?: HardwareFamilyCatalog): string | null {
  if (!reports.length || modeId === 'off') return null
  const candidates = family ? reports.filter((report) => possibleFamilyOnNode(family, report)) : reports
  if (candidates.every(({ gpus }) => gpus.cc.status === 'no'))
    return 'NVIDIA reports no CC capable GPU on these nodes.'
  if (modeId === 'ppcie' && candidates.every(({ gpus }) => gpus.ppcie.status === 'no'))
    return 'No uploaded node supports this PPCIE path.'
  if (cpuTeeIds.length > 0 && candidates.every((report) =>
    cpuTeeIds.every((id) => report.checks[id as keyof NodePrecheck['checks']]?.status === 'no')))
    return 'No required CPU TEE is available on the uploaded nodes.'
  if (!candidates.some((report) => report.gpus.cc.status !== 'no' &&
      (modeId !== 'ppcie' || report.gpus.ppcie.status !== 'no') &&
      (cpuTeeIds.length === 0 || cpuTeeIds.some((id) =>
        report.checks[id as keyof NodePrecheck['checks']]?.status !== 'no'))))
    return 'No uploaded node meets this mode’s confirmed prerequisites.'
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
  const requiredModels = checks.includes('gpu') ? gpuModels : []
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
  const tees = checks.filter((check) => check !== 'gpu')
  const requiredModels = checks.includes('gpu') ? gpuModels : []
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
  const tees = checks.filter((check) => check !== 'gpu')
  const requiredModels = checks.includes('gpu') ? gpuModels : []
  if (tees.length > 1) return 'Selected CPU TEEs cannot run on the same node.'
  if (checks.includes('gpu') && vendor.id !== 'nvidia')
    return 'This path does not configure NVIDIA GPUs.'
  if (tees.length > 0 && vendor.id !== 'nvidia' &&
      !vendor.runtime.shims.some(({ id }) => id.split('-').includes(tees[0])))
    return `This path does not configure ${tees[0].toUpperCase()}.`

  const candidates = reportsMatchingChecks(reports, checks, gpuModels)
  if (reports.length > 0 && candidates.length === 0)
    return 'No uploaded node meets all selected checks.'

  if (vendor.id === 'nvidia') {
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
