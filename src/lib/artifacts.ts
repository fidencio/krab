import { parse, stringify } from 'yaml'
import Ajv from 'ajv'
import valuesSchema from '../../charts/krab/values.schema.json' with { type: 'json' }
import { erofsUtilsImage } from './erofs-image'

export type ModeCatalog = {
  id: string
  supportedCpuTeeIds: string[]
  displayName: string
  badge: string | null
  label: string
  description: string
  values: Record<string, unknown>
  profileName: string
  sourcePath: string
  sourceUrl: string
}

export type HardwareFamilyCatalog = {
  id: string
  displayName: string
  upstreamName: string
  models: string[]
  modelAliases?: Record<string, string[]>
  supportedArches: string[]
  availability: 'available' | 'pending'
  availabilityReason: string | null
  evidenceUrls?: string[]
  defaultModeId: string
  modes: ModeCatalog[]
  sourceUrl: string
  experimental: boolean
}

export type VendorCatalog = {
  id: string
  displayName: string
  tagline: string
  description: string
  logo: string
  capabilities: Array<{
    id: string
    resourceName?: string
    modes?: string[]
  }>
  sourceUrl: string
  hardwareFamilies: HardwareFamilyCatalog[]
  runtime: {
    chart: {
      name: string
      version: string
      appVersion: string
      ociReference: string
      namespace: string
      valuesFileName: string
      values: Record<string, unknown>
      sourceUrl: string
    }
    shims: Array<{
      id: string
      runtimeClass: string
      userSelectable?: boolean
      selectionGroup?: 'cpu' | 'gpu'
      snapshotter: string
      snapshotterConfiguration?: {
        erofsSnapshotterMode: 'memory' | 'disk'
        erofsDmverity: boolean
        containerdUserDropIn: string
      }
      supportedArches: string[]
      nodeSelector: Record<string, string>
      sourceUrl: string
    }>
    cpuTees: Array<{
      id: string
      displayName: string
      shimId: string
      runtimeClass: string
      documentedRuntimeClass: string
      nodeSelector: Record<string, string>
      sourceUrl: string
    }>
  }
  provisioner: {
    chart: {
      name: string
      version: string
      appVersion: string
      namespace: string
      repository: string
      ref: string
      pullRequest?: number
      chartPath: string
      sourceUrl: string
      experimental: boolean
    }
    values: {
      image: { reference: string; tag: string }
      job: {
        dispatcherImage: { reference: string; tag: string }
      }
    }
  }
  devicePlugin: {
    chart: {
      chartName: string
      version: string
      appVersion: string
      required: true
      sourceUrl: string
    }
    values: Record<string, unknown>
    sourceUrl: string
  }
  workload: {
    resourceName: string
    nvSwitchResourceName: string
    resourceNaming: string
    sourceUrl: string
  }
}

export type ExplorerCatalog = {
  schemaVersion: number
  plannedArchitecture: {
    schemaVersion: number
    status: 'prerelease' | 'stable'
    notice: string
    namespace: string
    cluster: {
      distributions: Array<{
        id: string
        displayName: string
        kataDeployValue: string
        defaultConfigurationOnly: boolean
        sourceUrl: string
      }>
      selinuxValuesPath: string
      selinuxSourceUrl: string
    }
    attestation: {
      trustee: {
        displayName: string
        repository: string
        commit: string
        sourceUrl: string
        documentationUrl: string
        kataSourceUrl: string
      }
    }
    charts: {
      krab: {
        repository: string
        chartName: string
        version: string
        appVersion: string
        releaseName: string
        ociReference: string
        valuesFileName: string
        dependencies: {
          nvidiaValuesKey: string
          runtimeValuesKey: string
          runtimeRequired: true
          devicePluginValuesKey: string
          devicePluginRequired: boolean
          devicePluginRequiredBy: string[]
          provisionerValuesKey: string
          provisionerRequired: boolean
          provisionerRequiredBy: string[]
          nfdValuesKey: string
          nfdRequired: true
        }
      }
      provisioner: {
        chartName: string
        version: string
        appVersion: string
        required: boolean
        sourceUrl: string
      }
      nfd: {
        chartName: string
        version: string
        appVersion: string
        repository: string
        valuesKey: string
        required: true
        image: {
          repository: string
          tag: string
          pullPolicy?: string
        }
        sourceUrl: string
      }
      kataDeploy: {
        chartName: string
        version: string
        required: true
        sourceUrl: string
      }
      devicePlugin: {
        chartName: string
        version: string
        appVersion: string
        required: true
        sourceUrl: string
      }
    }
  }
  vendors: VendorCatalog[]
}

export type FamilySelections = Record<
  string,
  { enabled?: boolean; modeId: string | null; cpuTeeIds: string[] }
>

export type ClusterConfiguration = {
  distributionId: string | null
  selinuxEnabled: boolean
  architectures?: string[]
}

export type RuntimeConfiguration = {
  selectedShimIds: string[]
  runtimeHttpsProxy: string
  runtimeNoProxy: string
  nvidiaDcgmEnabled: boolean
}

export type RuntimeToleration = {
  key: string
  operator: 'Exists' | 'Equal'
  value: string
  effect: '' | 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
}

export type RuntimeNodeAffinity = {
  key: string
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'
  values: string[]
}

export type ChartImageConfiguration = {
  pullPolicy: '' | 'Always' | 'IfNotPresent' | 'Never'
  pullSecrets: string[]
  reference: string
  tag: string
  dispatcherReference: string
  dispatcherTag: string
}

export type CustomRuntimeConfiguration = {
  name: string
  baseConfig: string
  dropIn: string
  runtimeClass: string
}

export type CustomRuntimeValidationError = {
  index: number
  field: 'name' | 'baseConfig'
  message: string
}

export type AdvancedConfiguration = {
  containerdConfigDir: string
  containerdRuntimeSocket: string
  containerdConfigFileName: string
  containerdUserDropIn: string
  shimDropIns: Record<string, string>
  customRuntimes: CustomRuntimeConfiguration[]
  erofsSnapshotterMode: 'memory' | 'disk'
  erofsDiskSize: string
  erofsDmverity: boolean
  erofsEnableFsverity: boolean
  installErofsUtils: boolean
  erofsUtilsImage: string
  nodeSelector: Array<{ key: string; value: string }>
  nodeAffinity: RuntimeNodeAffinity[]
  tolerations: RuntimeToleration[]
  scheduledReconcileEnabled: boolean
  scheduledReconcileSchedule: string
  images: Record<
    'kataDeploy' | 'nfd' | 'devicePlugin' | 'provisioner',
    ChartImageConfiguration
  > & {
    kataDeploy: ChartImageConfiguration & {
      kubectlReference: string
      kubectlTag: string
    }
  }
  debug: boolean
}

export type ImportedValuesConfiguration = {
  vendorId: string
  selections: FamilySelections
  cluster: ClusterConfiguration
  runtime: RuntimeConfiguration
  advanced: AdvancedConfiguration
  deploymentName: string
  warnings: string[]
}

const valuesFormatVersion = 1
const validateValues = new Ajv({ allErrors: true }).compile(valuesSchema)

const createChartImageConfiguration = (): ChartImageConfiguration => ({
  pullPolicy: '',
  pullSecrets: [],
  reference: '',
  tag: '',
  dispatcherReference: '',
  dispatcherTag: '',
})

export const createAdvancedConfiguration = (): AdvancedConfiguration => ({
  containerdConfigDir: '',
  containerdRuntimeSocket: '',
  containerdConfigFileName: '',
  containerdUserDropIn: '',
  shimDropIns: {},
  customRuntimes: [],
  erofsSnapshotterMode: 'memory',
  erofsDiskSize: '256M',
  erofsDmverity: true,
  erofsEnableFsverity: false,
  installErofsUtils: false,
  erofsUtilsImage: '',
  nodeSelector: [],
  nodeAffinity: [],
  tolerations: [],
  scheduledReconcileEnabled: false,
  scheduledReconcileSchedule: '*/15 * * * *',
  images: {
    kataDeploy: {
      ...createChartImageConfiguration(),
      kubectlReference: '',
      kubectlTag: '',
    },
    nfd: createChartImageConfiguration(),
    devicePlugin: createChartImageConfiguration(),
    provisioner: createChartImageConfiguration(),
  },
  debug: false,
})

const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}

const imageConfiguration = (
  image: unknown,
  pullPolicy: unknown,
  pullSecrets: unknown,
  dispatcherImage?: unknown,
): ChartImageConfiguration => {
  const configuredImage = asRecord(image)
  const configuredDispatcher = asRecord(dispatcherImage)
  return {
    reference: String(
      configuredImage.reference ?? configuredImage.repository ?? '',
    ),
    tag: String(configuredImage.tag ?? ''),
    pullPolicy: ['Always', 'IfNotPresent', 'Never'].includes(String(pullPolicy))
      ? pullPolicy as ChartImageConfiguration['pullPolicy']
      : ['Always', 'IfNotPresent', 'Never'].includes(
            String(configuredImage.pullPolicy),
          )
        ? configuredImage.pullPolicy
        : '',
    pullSecrets: Array.isArray(pullSecrets)
      ? pullSecrets.flatMap((entry) => {
          const name = asRecord(entry).name
          return typeof name === 'string' ? [name] : []
        })
      : [],
    dispatcherReference: String(configuredDispatcher.reference ?? ''),
    dispatcherTag: String(configuredDispatcher.tag ?? ''),
  }
}

const deploymentNameFromFile = (
  catalog: ExplorerCatalog,
  fileName: string,
  sourceVersion = catalog.plannedArchitecture.charts.krab.version,
) => {
  const suffix = `-${sourceVersion}-${catalog.plannedArchitecture.charts.krab.valuesFileName}`
  return fileName.endsWith(suffix) ? fileName.slice(0, -suffix.length) : ''
}

export function importValuesBundle(
  catalog: ExplorerCatalog,
  source: string,
  fileName = '',
): ImportedValuesConfiguration {
  const format = source.match(/^# KRAB values format: (.+)$/m)?.[1]
  const sourceVersion = source.match(/^# KRAB chart version: (.+)$/m)?.[1]
  if (format && format !== String(valuesFormatVersion)) {
    throw new Error(`Unsupported KRAB values format ${format}.`)
  }
  if (Boolean(format) !== Boolean(sourceVersion)) {
    throw new Error('The KRAB values file has incomplete version information.')
  }
  const warnings: string[] = []
  if (!format) {
    warnings.push('This file has no KRAB version marker. Its fields were checked against the current chart; review the generated values before deploying.')
  } else if (sourceVersion !== catalog.plannedArchitecture.charts.krab.version) {
    warnings.push(`This file was made for KRAB ${sourceVersion}; this builder uses ${catalog.plannedArchitecture.charts.krab.version}. Review the generated values before deploying.`)
  }
  const parsed = parse(source)
  const root = asRecord(parsed)
  if (Object.keys(root).length === 0) {
    throw new Error('The selected file does not contain Helm values.')
  }
  if (!validateValues(root)) {
    const error = validateValues.errors?.[0]
    throw new Error(`This file does not match the current KRAB chart: ${error?.instancePath || 'root'} ${error?.message ?? 'is invalid'}.`)
  }

  const dependencies = catalog.plannedArchitecture.charts.krab.dependencies
  const runtimeValues = asRecord(root[dependencies.runtimeValuesKey])
  const configuredShims = asRecord(runtimeValues.shims)
  const enabledShimIds = Object.entries(configuredShims).flatMap(
    ([id, configuration]) =>
      id !== 'disableAll' && asRecord(configuration).enabled === true ? [id] : [],
  )
  const supportedShimIds = new Set(catalog.vendors.flatMap((candidate) =>
    candidate.runtime.shims.map(({ id }) => id)))
  for (const id of Object.keys(configuredShims)) {
    if (id !== 'disableAll' && !supportedShimIds.has(id)) {
      throw new Error(`The imported RuntimeClass ${id} is not available in this KRAB release.`)
    }
  }
  const provisionerValues = asRecord(root[dependencies.provisionerValuesKey])
  const configuredProfiles = asRecord(provisionerValues.profiles)
  const supportedProfiles = new Map(catalog.vendors.flatMap((candidate) =>
    candidate.hardwareFamilies.flatMap((family) => family.modes.flatMap((mode) =>
      (mode.supportedCpuTeeIds.length ? mode.supportedCpuTeeIds : ['']).map((tee) => [
        tee ? `${mode.profileName}-${tee.toUpperCase()}` : mode.profileName,
        mode.id,
      ] as const)))))
  for (const [name, configuration] of Object.entries(configuredProfiles)) {
    const expectedMode = supportedProfiles.get(name)
    if (!expectedMode) {
      throw new Error(`The imported provisioner profile ${name} is not available in this KRAB release.`)
    }
    if (asRecord(configuration).ccMode !== expectedMode) {
      throw new Error(`The imported provisioner profile ${name} has a different mode in this KRAB release.`)
    }
  }
  const nvidiaEnabled = asRecord(root[dependencies.nvidiaValuesKey]).enabled === true
  if (!nvidiaEnabled && Object.values(configuredProfiles).some((profile) =>
    asRecord(profile).enabled === true)) {
    throw new Error('The file enables a provisioner profile while NVIDIA dependencies are disabled.')
  }
  const embeddedSelection = source.match(/^# KRAB selection: (.+)$/m)?.[1]
  const selectedVendor = catalog.vendors.find(({ id }) => id === embeddedSelection)
  if (embeddedSelection && !selectedVendor) {
    throw new Error(`The imported vendor ${embeddedSelection} is not available in this KRAB release.`)
  }
  const detectedVendor = catalog.vendors
        .filter(({ id }) => id !== 'nvidia')
        .map((candidate) => ({
          candidate,
          score: candidate.runtime.shims.filter(({ id }) =>
            enabledShimIds.includes(id),
          ).length,
        }))
        .sort((left, right) => right.score - left.score)[0]
  const customVendor = catalog.vendors.find(({ id }) => id === 'custom')
  const hasCustomOnlyShim = customVendor?.runtime.shims.some(({ id }) =>
    enabledShimIds.includes(id) &&
    !catalog.vendors.find(({ id: vendorId }) => vendorId === 'nvidia')?.runtime.shims.some((shim) => shim.id === id),
  )
  const vendor = selectedVendor ?? (nvidiaEnabled && hasCustomOnlyShim
    ? customVendor
    : nvidiaEnabled
    ? catalog.vendors.find(({ id }) => id === 'nvidia')
    : detectedVendor?.score
      ? detectedVendor.candidate
      : undefined)

  if (!vendor || enabledShimIds.length === 0) {
    throw new Error('KRAB could not identify a supported vendor or RuntimeClass.')
  }

  const selections = initialFamilySelections(vendor)
  if (vendor.hardwareFamilies.length > 0) {
    for (const family of vendor.hardwareFamilies) {
      for (const mode of family.modes) {
        if (mode.id === 'off' && asRecord(configuredProfiles[mode.profileName]).enabled) {
          selections[family.id] = {
            enabled: true,
            modeId: mode.id,
            cpuTeeIds: [],
          }
          break
        }
        const cpuTeeIds = mode.supportedCpuTeeIds.filter((cpuTeeId) =>
          asRecord(
            configuredProfiles[`${mode.profileName}-${cpuTeeId.toUpperCase()}`],
          ).enabled === true,
        )
        if (cpuTeeIds.length > 0) {
          selections[family.id] = { enabled: true, modeId: mode.id, cpuTeeIds }
          break
        }
      }
    }
  }

  const distribution = catalog.plannedArchitecture.cluster.distributions.find(
    ({ kataDeployValue }) => kataDeployValue === runtimeValues.k8sDistribution,
  )
  if (runtimeValues.k8sDistribution && !distribution) {
    throw new Error(`The imported Kubernetes distribution ${runtimeValues.k8sDistribution} is not available in this KRAB release.`)
  }
  const selectedShimConfigs = enabledShimIds.map((id) =>
    asRecord(configuredShims[id]),
  )
  const firstAgent = selectedShimConfigs
    .map(({ agent }) => asRecord(agent))
    .find((agent) => Object.keys(agent).length > 0) ?? {}
  const runtime: RuntimeConfiguration = {
    selectedShimIds:
      vendor.hardwareFamilies.length === 0 || vendor.id === 'custom'
        ? enabledShimIds.filter((id) =>
            vendor.runtime.shims.some((shim) => shim.id === id && !id.includes('nvidia-gpu')),
          )
        : enabledShimIds.filter((id) =>
            vendor.runtime.shims.some(
              (shim) => shim.id === id && shim.userSelectable,
            ),
          ),
    runtimeHttpsProxy: String(firstAgent.httpsProxy ?? ''),
    runtimeNoProxy: String(firstAgent.noProxy ?? ''),
    nvidiaDcgmEnabled: selectedShimConfigs.some(
      ({ nvrc }) => asRecord(nvrc).enableDCGM === true,
    ),
  }

  const advanced = createAdvancedConfiguration()
  advanced.debug = runtimeValues.debug === true
  advanced.shimDropIns = Object.fromEntries(
    enabledShimIds.flatMap((id) => {
      const dropIn = asRecord(configuredShims[id]).dropIn
      return typeof dropIn === 'string' ? [[id, dropIn]] : []
    }),
  )
  const customRuntimes = asRecord(runtimeValues.customRuntimes)
  advanced.customRuntimes = Object.entries(
    asRecord(customRuntimes.runtimes),
  ).map(([name, configuration]) => {
    const runtimeConfiguration = asRecord(configuration)
    return {
      name,
      baseConfig: String(runtimeConfiguration.baseConfig ?? ''),
      dropIn: String(runtimeConfiguration.dropIn ?? ''),
      runtimeClass:
        typeof runtimeConfiguration.runtimeClass === 'string'
          ? runtimeConfiguration.runtimeClass
          : stringify(runtimeConfiguration.runtimeClass ?? {}).trim(),
    }
  })

  const snapshotter = asRecord(runtimeValues.snapshotter)
  advanced.erofsSnapshotterMode =
    snapshotter.erofsSnapshotterMode === 'disk' ? 'disk' : 'memory'
  advanced.erofsDmverity = snapshotter.erofsDmverity !== false
  const containerd = asRecord(runtimeValues.containerd)
  advanced.containerdConfigDir = String(containerd.configDir ?? '')
  advanced.containerdRuntimeSocket = String(containerd.runtimeSocket ?? '')
  advanced.containerdConfigFileName = String(containerd.configFileName ?? '')
  const containerdDropIn = String(containerd.userDropIn ?? '')
  const erofsBlock = containerdDropIn.match(
    /^\[plugins\.'io\.containerd\.snapshotter\.v1\.erofs'\]\n(?:  (?:enable_fsverity|default_size) = .+\n?){1,2}/,
  )?.[0] ?? ''
  advanced.erofsEnableFsverity = /enable_fsverity = true/.test(erofsBlock)
  advanced.erofsDiskSize =
    erofsBlock.match(/default_size = "([^"]+)"/)?.[1] ?? '256M'
  advanced.containerdUserDropIn = erofsBlock
    ? containerdDropIn.slice(erofsBlock.length).trimStart()
    : containerdDropIn
  const erofsUtils = asRecord(asRecord(runtimeValues.nodeBinaries)['erofs-utils'])
  advanced.installErofsUtils = Object.keys(erofsUtils).length > 0
  advanced.erofsUtilsImage = String(erofsUtils.image ?? '')
  advanced.nodeSelector = Object.entries(asRecord(runtimeValues.nodeSelector)).map(
    ([key, value]) => ({ key, value: String(value) }),
  )
  const affinityTerms = asRecord(
    asRecord(asRecord(runtimeValues.affinity).nodeAffinity)
      .requiredDuringSchedulingIgnoredDuringExecution,
  ).nodeSelectorTerms
  const expressions = Array.isArray(affinityTerms)
    ? asRecord(affinityTerms[0]).matchExpressions
    : []
  advanced.nodeAffinity = Array.isArray(expressions)
    ? expressions.flatMap((expression) => {
        const value = asRecord(expression)
        const operator = String(value.operator)
        if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(operator)) return []
        return [{
          key: String(value.key ?? ''),
          operator: operator as RuntimeNodeAffinity['operator'],
          values: Array.isArray(value.values) ? value.values.map(String) : [],
        }]
      })
    : []
  advanced.tolerations = Array.isArray(runtimeValues.tolerations)
    ? runtimeValues.tolerations.flatMap((entry: unknown) => {
        const value = asRecord(entry)
        const operator = value.operator === 'Equal' ? 'Equal' : 'Exists'
        const effect = ['', 'NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(
          String(value.effect ?? ''),
        ) ? String(value.effect ?? '') : ''
        return [{
          key: String(value.key ?? ''),
          operator,
          value: String(value.value ?? ''),
          effect: effect as RuntimeToleration['effect'],
        }]
      })
    : []
  const reconcile = asRecord(asRecord(runtimeValues.job).reconcile)
  advanced.scheduledReconcileEnabled = reconcile.enabled === true
  advanced.scheduledReconcileSchedule = String(
    reconcile.schedule ?? advanced.scheduledReconcileSchedule,
  )

  const kataDeployImages = imageConfiguration(
    runtimeValues.image,
    runtimeValues.imagePullPolicy,
    runtimeValues.imagePullSecrets,
    asRecord(runtimeValues.job).dispatcherImage,
  ) as AdvancedConfiguration['images']['kataDeploy']
  const kubectlImage = asRecord(runtimeValues.kubectlImage)
  kataDeployImages.kubectlReference = String(kubectlImage.reference ?? '')
  kataDeployImages.kubectlTag = String(kubectlImage.tag ?? '')
  advanced.images.kataDeploy = kataDeployImages
  const nfdValues = asRecord(root[dependencies.nfdValuesKey])
  advanced.images.nfd = imageConfiguration(
    nfdValues.image,
    asRecord(nfdValues.image).pullPolicy,
    nfdValues.imagePullSecrets,
  )
  const devicePluginValues = asRecord(root[dependencies.devicePluginValuesKey])
  advanced.images.devicePlugin = imageConfiguration(
    devicePluginValues.image,
    asRecord(devicePluginValues.image).pullPolicy,
    devicePluginValues.imagePullSecrets,
  )
  advanced.images.provisioner = imageConfiguration(
    provisionerValues.image,
    provisionerValues.imagePullPolicy,
    provisionerValues.imagePullSecrets,
    asRecord(provisionerValues.job).dispatcherImage,
  )

  return {
    vendorId: vendor.id,
    selections,
    cluster: {
      distributionId: distribution?.id ?? null,
      selinuxEnabled: asRecord(runtimeValues.selinux).enabled === true,
      ...(vendor.id === 'custom'
        ? { architectures: Object.keys(asRecord(runtimeValues.defaultShim)).length > 0
          ? Object.keys(asRecord(runtimeValues.defaultShim))
          : [...new Set(vendor.runtime.shims
            .filter(({ id }) => enabledShimIds.includes(id))
            .flatMap(({ supportedArches }) => supportedArches))] }
        : {}),
    },
    runtime,
    advanced,
    deploymentName: deploymentNameFromFile(catalog, fileName, sourceVersion),
    warnings,
  }
}

const initialFamilySelections = (vendor: VendorCatalog): FamilySelections =>
  Object.fromEntries(
    vendor.hardwareFamilies.map((family) => [
      family.id,
      { enabled: false, modeId: null, cpuTeeIds: [] },
    ]),
  )

const yaml = (value: unknown) =>
  stringify(value, { lineWidth: 0 }).trim()

const runtimeNamePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/

export const buildCustomRuntimeClass = (name: string) => {
  const runtimeName = name.trim() || 'custom-runtime'
  const handler = `kata-${runtimeName}`
  return `${yaml({
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: {
      name: handler,
      labels: { 'app.kubernetes.io/managed-by': 'kata-deploy' },
    },
    handler,
  })}\n`
}

export function customRuntimeClassName(runtime: CustomRuntimeConfiguration) {
  try {
    const manifest = parse(runtime.runtimeClass) as {
      metadata?: { name?: unknown }
    } | null
    return typeof manifest?.metadata?.name === 'string'
      ? manifest.metadata.name
      : `kata-${runtime.name.trim() || 'custom-runtime'}`
  } catch {
    return `kata-${runtime.name.trim() || 'custom-runtime'}`
  }
}

export function customRuntimeSnapshotter(
  vendor: VendorCatalog,
  runtime: CustomRuntimeConfiguration,
) {
  const snapshotter = vendor.runtime.shims.find(
    ({ id }) => id === runtime.baseConfig,
  )?.snapshotter
  return !snapshotter || snapshotter === 'default' ? '' : snapshotter
}

export function validateCustomRuntimes(
  vendor: VendorCatalog,
  runtimes: CustomRuntimeConfiguration[],
) {
  const errors: CustomRuntimeValidationError[] = []
  const names = new Map<string, number[]>()

  runtimes.forEach((runtime, index) => {
    const name = runtime.name.trim()
    names.set(name, [...(names.get(name) ?? []), index])
    if (!name || name.length > 63 || !runtimeNamePattern.test(name)) {
      errors.push({
        index,
        field: 'name',
        message:
          'Use 1–63 lowercase letters, numbers, or hyphens; start and end with a letter or number.',
      })
    }
    if (!vendor.runtime.shims.some(({ id }) => id === runtime.baseConfig)) {
      errors.push({
        index,
        field: 'baseConfig',
        message: 'Select a base runtime from this vendor.',
      })
    }

  })

  for (const [name, indexes] of names) {
    if (name && indexes.length > 1) {
      for (const index of indexes) {
        errors.push({
          index,
          field: 'name',
          message: `Runtime name ${name} must be unique.`,
        })
      }
    }
  }
  return errors
}

export function resolveRuntimeShimIds(
  vendor: VendorCatalog,
  selections: FamilySelections,
  runtime: RuntimeConfiguration,
) {
  const enabledShims = new Set(
    runtime.selectedShimIds.filter((shimId) =>
      vendor.runtime.shims.some(({ id }) => id === shimId),
    ),
  )
  const baseRuntimeShim = vendor.runtime.shims.find(({ id }) =>
    id === 'qemu-nvidia-gpu-runtime-rs') ?? vendor.runtime.shims.find(
    ({ id }) => !id.includes('-snp-') && !id.includes('-tdx-'),
  )

  for (const family of vendor.hardwareFamilies) {
    if (family.availability !== 'available') continue
    const selection = selections[family.id]
    const mode = family.modes.find(
      (candidate) => candidate.id === selection?.modeId,
    )
    if (!mode) continue

    if (mode.id === 'off' && baseRuntimeShim) {
      enabledShims.add(baseRuntimeShim.id)
      continue
    }
    for (const cpuTeeId of selection.cpuTeeIds) {
      if (!mode.supportedCpuTeeIds.includes(cpuTeeId)) continue
      const tee = vendor.runtime.cpuTees.find(({ id }) => id === cpuTeeId)
      if (tee) enabledShims.add(tee.shimId)
    }
  }

  return [...enabledShims]
}

export function usesConfidentialComputing(
  vendor: VendorCatalog,
  selections: FamilySelections,
  runtime: RuntimeConfiguration,
  customRuntimes: CustomRuntimeConfiguration[] = [],
) {
  const selectedShimIds = new Set([
    ...resolveRuntimeShimIds(vendor, selections, runtime),
    ...customRuntimes.map(({ baseConfig }) => baseConfig),
  ])
  if (selectedShimIds.size === 0) return false

  const vendorIsConfidentialOnly =
    vendor.hardwareFamilies.length === 0 &&
    vendor.capabilities.some(({ id }) => id === 'confidential-computing')
  if (vendorIsConfidentialOnly) return true

  const teeShimIds = new Set(vendor.runtime.cpuTees.map(({ shimId }) => shimId))
  return [...selectedShimIds].some(
    (shimId) =>
      teeShimIds.has(shimId) ||
      /(?:^|-)(?:coco|snp|tdx|se)(?:-|$)/.test(shimId),
  )
}

export function buildValuesBundle(
  catalog: ExplorerCatalog,
  vendor: VendorCatalog,
  selections: FamilySelections,
  cluster: ClusterConfiguration,
  runtime: RuntimeConfiguration,
  advanced: AdvancedConfiguration,
) {
  const architecture = catalog.plannedArchitecture
  const profiles: Record<string, unknown> = {}
  const runtimeValues = structuredClone(vendor.runtime.chart.values) as {
    shims?: Record<
      string,
      {
        enabled?: boolean
        dropIn?: string
        agent?: { httpsProxy?: string; noProxy?: string }
        nvrc?: { enableDCGM?: boolean }
      } | boolean
    >
    defaultShim?: Record<string, string>
    customRuntimes?: {
      enabled: boolean
      runtimes: Record<string, unknown>
    }
    'node-feature-discovery'?: { enabled?: boolean }
    snapshotter?: {
      setup?: string[]
      erofsMergeMode?: string
      erofsSnapshotterMode?: string
      erofsDmverity?: boolean
    }
    containerd?: Record<string, unknown>
    deploymentMode?: string
    debug?: boolean
    nodeSelector?: Record<string, string>
    affinity?: Record<string, unknown>
    tolerations?: Array<Record<string, unknown>>
    imagePullPolicy?: string
    imagePullSecrets?: Array<{ name: string }>
    image?: { reference?: string; tag?: string }
    kubectlImage?: { reference?: string; tag?: string }
    job?: {
      dispatcherImage?: { reference?: string; tag?: string }
      reconcile?: { enabled: boolean; schedule: string }
    }
    nodeBinaries?: Record<
      string,
      { image: string; binaries: string[]; pullPolicy?: string }
    >
    k8sDistribution?: string
    selinux?: { enabled?: boolean }
  }
  runtimeValues.deploymentMode = 'job'
  runtimeValues.debug = advanced.debug
  const distribution = architecture.cluster.distributions.find(
    ({ id }) => id === cluster.distributionId,
  )
  if (distribution) {
    runtimeValues.k8sDistribution = distribution.kataDeployValue
  }
  runtimeValues.selinux = {
    ...(runtimeValues.selinux ?? {}),
    enabled: cluster.selinuxEnabled,
  }
  const enabledShims = new Set(
    resolveRuntimeShimIds(vendor, selections, runtime),
  )

  for (const family of vendor.hardwareFamilies) {
    if (family.availability !== 'available') continue
    const selection = selections[family.id]
    const mode = family.modes.find(
      (candidate) => candidate.id === selection?.modeId,
    )
    if (mode) {
      if (mode.id === 'off') {
        profiles[mode.profileName] = {
          enabled: true,
          ...structuredClone(mode.values),
        }
      } else {
        for (const cpuTeeId of selection.cpuTeeIds) {
          if (!mode.supportedCpuTeeIds.includes(cpuTeeId)) continue
          const tee = vendor.runtime.cpuTees.find(({ id }) => id === cpuTeeId)
          if (!tee) continue
          const cpuNodeSelector = Object.fromEntries(
            Object.entries(tee.nodeSelector).filter(
              ([key]) => key !== 'nvidia.com/cc.ready.state',
            ),
          )
          profiles[`${mode.profileName}-${tee.id.toUpperCase()}`] = {
            enabled: true,
            ...structuredClone(mode.values),
            nodeSelector: {
              ...(mode.values.nodeSelector as Record<string, string>),
              ...cpuNodeSelector,
            },
          }
        }
      }
    }
  }

  const sourceShims = runtimeValues.shims ?? {}
  const selectedShims: NonNullable<typeof runtimeValues.shims> = {
    disableAll: true,
  }
  for (const shimId of enabledShims) {
    const shimConfig = sourceShims[shimId]
    if (shimConfig && typeof shimConfig !== 'boolean') {
      const selectedShim = { ...shimConfig, enabled: true }
      const dropIn = advanced.shimDropIns[shimId]
      if (dropIn?.trim()) {
        selectedShim.dropIn = dropIn
      }
      if (selectedShim.agent) {
        selectedShim.agent = {
          ...selectedShim.agent,
          httpsProxy: runtime.runtimeHttpsProxy.trim(),
          noProxy: runtime.runtimeNoProxy.trim(),
        }
      }
      if (shimId.includes('nvidia-')) {
        selectedShim.nvrc = {
          ...(selectedShim.nvrc ?? {}),
          enableDCGM: runtime.nvidiaDcgmEnabled,
        }
      }
      selectedShims[shimId] = selectedShim
    }
  }
  runtimeValues.shims = selectedShims
  const sourceDefaultShims = runtimeValues.defaultShim ?? {}
  const selectedShimCatalog = [...enabledShims]
    .filter((shimId) => typeof selectedShims[shimId] === 'object')
    .map((shimId) => vendor.runtime.shims.find(({ id }) => id === shimId))
    .filter(
      (shim): shim is VendorCatalog['runtime']['shims'][number] => Boolean(shim),
    )
  const supportedArchitectures = new Set(
    vendor.id === 'custom' && cluster.architectures
      ? cluster.architectures
      : selectedShimCatalog.flatMap(({ supportedArches }) => supportedArches),
  )
  const defaultShims = Object.fromEntries(
    [...supportedArchitectures].map((architecture) => {
      const candidates = selectedShimCatalog.filter(({ supportedArches }) =>
        supportedArches.includes(architecture),
      )
      const configuredDefault = sourceDefaultShims[architecture]
      const generalCandidates = vendor.id === 'custom'
        ? candidates.filter(({ id }) => !/(?:^|-)(?:snp|tdx|se)(?:-|$)/.test(id) && !id.includes('nvidia-gpu'))
        : candidates
      const selectedDefault =
        generalCandidates.find(({ id }) => id === configuredDefault) ?? generalCandidates[0]
      return selectedDefault ? [architecture, selectedDefault.id] : null
    }).filter((entry): entry is string[] => entry !== null),
  )
  if (Object.keys(defaultShims).length > 0) {
    runtimeValues.defaultShim = defaultShims
  } else {
    delete runtimeValues.defaultShim
  }
  if (advanced.customRuntimes.length > 0) {
    runtimeValues.customRuntimes = {
      enabled: true,
      runtimes: Object.fromEntries(
        advanced.customRuntimes.map((customRuntime) => [
          customRuntime.name.trim(),
          {
            baseConfig: customRuntime.baseConfig,
            ...(customRuntime.dropIn.trim()
              ? { dropIn: customRuntime.dropIn }
              : {}),
            runtimeClass: customRuntime.runtimeClass,
            containerd: {
              snapshotter: customRuntimeSnapshotter(vendor, customRuntime),
            },
          },
        ]),
      ),
    }
  } else {
    delete runtimeValues.customRuntimes
  }
  const requiredSnapshotters = new Set(
    [
      ...[...enabledShims].map((shimId) =>
        vendor.runtime.shims.find(({ id }) => id === shimId)?.snapshotter,
      ),
      ...advanced.customRuntimes.map((customRuntime) =>
        customRuntimeSnapshotter(vendor, customRuntime),
      ),
    ]
      .filter(
        (snapshotter): snapshotter is string =>
          Boolean(snapshotter) && snapshotter !== 'default',
      ),
  )
  if (advanced.installErofsUtils && requiredSnapshotters.has('erofs')) {
    runtimeValues.nodeBinaries = {
      ...(runtimeValues.nodeBinaries ?? {}),
      'erofs-utils': {
        image:
          advanced.erofsUtilsImage.trim() ||
          erofsUtilsImage,
        binaries: ['mkfs.erofs'],
        pullPolicy: 'IfNotPresent',
      },
    }
  }
  if (requiredSnapshotters.size === 0) {
    delete runtimeValues.snapshotter
    delete runtimeValues.containerd
  } else if (runtimeValues.snapshotter) {
    runtimeValues.snapshotter.setup = [...requiredSnapshotters]
    if (requiredSnapshotters.has('erofs')) {
      delete runtimeValues.snapshotter.erofsMergeMode
      runtimeValues.snapshotter.erofsSnapshotterMode =
        advanced.erofsSnapshotterMode
      runtimeValues.snapshotter.erofsDmverity =
        advanced.erofsDmverity
      runtimeValues.containerd = {
        ...(runtimeValues.containerd ?? {}),
        userDropIn:
          "[plugins.'io.containerd.snapshotter.v1.erofs']\n" +
          `  enable_fsverity = ${advanced.erofsEnableFsverity}\n` +
          (advanced.erofsSnapshotterMode === 'disk'
            ? `  default_size = "${advanced.erofsDiskSize.trim() || '256M'}"\n`
            : ''),
      }
    } else if (!requiredSnapshotters.has('erofs')) {
      delete runtimeValues.snapshotter.erofsMergeMode
      delete runtimeValues.snapshotter.erofsSnapshotterMode
      delete runtimeValues.snapshotter.erofsDmverity
      delete runtimeValues.containerd
    }
  }
  if (runtimeValues['node-feature-discovery']) {
    runtimeValues['node-feature-discovery'].enabled = false
  }
  const generatedContainerdDropIn = runtimeValues.containerd?.userDropIn
  const customContainerdDropIn = advanced.containerdUserDropIn
  const containerdUserDropIn =
    typeof generatedContainerdDropIn === 'string' && customContainerdDropIn.trim()
      ? `${generatedContainerdDropIn.trimEnd()}\n\n${customContainerdDropIn}`
      : customContainerdDropIn.trim()
        ? customContainerdDropIn
        : generatedContainerdDropIn
  const customContainerd =
    cluster.distributionId === 'kubeadm'
      ? {
          ...(advanced.containerdConfigDir.trim()
            ? { configDir: advanced.containerdConfigDir.trim() }
            : {}),
          ...(advanced.containerdRuntimeSocket.trim()
            ? { runtimeSocket: advanced.containerdRuntimeSocket.trim() }
            : {}),
          ...(advanced.containerdConfigFileName.trim()
            ? { configFileName: advanced.containerdConfigFileName.trim() }
            : {}),
          ...(containerdUserDropIn
            ? { userDropIn: containerdUserDropIn }
            : {}),
        }
      : {}
  if (Object.keys(customContainerd).length > 0) {
    runtimeValues.containerd = {
      ...((runtimeValues.containerd as Record<string, unknown> | undefined) ?? {}),
      ...customContainerd,
    }
  }
  const nodeSelector = Object.fromEntries(
    advanced.nodeSelector
      .map(({ key, value }) => [key.trim(), value.trim()])
      .filter(([key]) => key.length > 0),
  )
  if (Object.keys(nodeSelector).length > 0) {
    runtimeValues.nodeSelector = nodeSelector
  }
  const nodeAffinity = advanced.nodeAffinity
    .filter(({ key }) => key.trim().length > 0)
    .map(({ key, operator, values }) => ({
      key: key.trim(),
      operator,
      ...(['In', 'NotIn'].includes(operator)
        ? {
            values: values.map((value) => value.trim()).filter(Boolean),
          }
        : {}),
    }))
  if (nodeAffinity.length > 0) {
    runtimeValues.affinity = {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [{ matchExpressions: nodeAffinity }],
        },
      },
    }
  }
  const tolerations = advanced.tolerations
    .filter(({ key }) => key.trim().length > 0)
    .map(({ key, operator, value, effect }) => ({
      key: key.trim(),
      operator,
      ...(operator === 'Equal' ? { value: value.trim() } : {}),
      ...(effect ? { effect } : {}),
    }))
  if (tolerations.length > 0) {
    runtimeValues.tolerations = tolerations
  }
  if (advanced.scheduledReconcileEnabled) {
    runtimeValues.job = {
      ...(runtimeValues.job ?? {}),
      reconcile: {
        enabled: true,
        schedule: advanced.scheduledReconcileSchedule.trim() || '*/15 * * * *',
      },
    }
  }
  const kataDeployImages = advanced.images.kataDeploy
  if (kataDeployImages.pullPolicy) {
    runtimeValues.imagePullPolicy = kataDeployImages.pullPolicy
  }
  const pullSecrets = (configuration: ChartImageConfiguration) =>
    configuration.pullSecrets
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }))
  const kataDeployPullSecrets = pullSecrets(kataDeployImages)
  if (kataDeployPullSecrets.length > 0) {
    runtimeValues.imagePullSecrets = kataDeployPullSecrets
  }
  const applyImageOverride = (
    current: { reference?: string; tag?: string } | undefined,
    reference: string,
    tag: string,
  ) => {
    const trimmedReference = reference.trim()
    const trimmedTag = tag.trim()
    if (!trimmedReference && !trimmedTag) return current
    return {
      ...(current ?? {}),
      ...(trimmedReference ? { reference: trimmedReference } : {}),
      ...(trimmedTag ? { tag: trimmedTag } : {}),
    }
  }
  runtimeValues.image = applyImageOverride(
    runtimeValues.image,
    kataDeployImages.reference,
    kataDeployImages.tag,
  )
  runtimeValues.kubectlImage = applyImageOverride(
    runtimeValues.kubectlImage,
    kataDeployImages.kubectlReference,
    kataDeployImages.kubectlTag,
  )
  const dispatcherImage = applyImageOverride(
    runtimeValues.job?.dispatcherImage,
    kataDeployImages.dispatcherReference,
    kataDeployImages.dispatcherTag,
  )
  if (dispatcherImage) {
    runtimeValues.job = {
      ...(runtimeValues.job ?? {}),
      dispatcherImage,
    }
  }
  const {
    k8sDistribution,
    selinux,
    ...remainingRuntimeValues
  } = runtimeValues
  const orderedRuntimeValues = {
    ...(k8sDistribution ? { k8sDistribution } : {}),
    selinux,
    ...remainingRuntimeValues,
  }
  const dependencies = architecture.charts.krab.dependencies
  const gpuPlatformSelected = vendor.hardwareFamilies.some((family) =>
    family.availability === 'available' &&
    family.modes.some(({ id }) => id === selections[family.id]?.modeId))
  const includeDevicePlugin =
    dependencies.devicePluginRequired || gpuPlatformSelected
  const includeProvisioner =
    dependencies.provisionerRequired || gpuPlatformSelected
  const nfdImages = advanced.images.nfd
  const nfdValues = {
    image: {
      ...architecture.charts.nfd.image,
      ...(nfdImages.reference.trim()
        ? { repository: nfdImages.reference.trim() }
        : {}),
      ...(nfdImages.tag.trim() ? { tag: nfdImages.tag.trim() } : {}),
      ...(nfdImages.pullPolicy
        ? { pullPolicy: nfdImages.pullPolicy }
        : {}),
    },
    ...(pullSecrets(nfdImages).length > 0
      ? { imagePullSecrets: pullSecrets(nfdImages) }
      : {}),
  }
  const devicePluginImages = advanced.images.devicePlugin
  const devicePluginValues = structuredClone(vendor.devicePlugin.values) as {
    image?: { repository?: string; tag?: string; pullPolicy?: string }
    imagePullSecrets?: Array<{ name: string }>
  }
  if (
    devicePluginImages.reference.trim() ||
    devicePluginImages.tag.trim() ||
    devicePluginImages.pullPolicy
  ) {
    devicePluginValues.image = {
      ...(devicePluginValues.image ?? {}),
      ...(devicePluginImages.reference.trim()
        ? { repository: devicePluginImages.reference.trim() }
        : {}),
      ...(devicePluginImages.tag.trim()
        ? { tag: devicePluginImages.tag.trim() }
        : {}),
      ...(devicePluginImages.pullPolicy
        ? { pullPolicy: devicePluginImages.pullPolicy }
        : {}),
    }
  }
  const devicePluginPullSecrets = pullSecrets(devicePluginImages)
  if (devicePluginPullSecrets.length > 0) {
    devicePluginValues.imagePullSecrets = devicePluginPullSecrets
  }
  const provisionerImages = advanced.images.provisioner
  const provisionerValues = structuredClone(vendor.provisioner.values)
  const provisionerImage = applyImageOverride(
    provisionerValues.image,
    provisionerImages.reference,
    provisionerImages.tag,
  )
  const provisionerDispatcherImage = applyImageOverride(
    provisionerValues.job.dispatcherImage,
    provisionerImages.dispatcherReference,
    provisionerImages.dispatcherTag,
  )

  return `# ${architecture.notice}\n# KRAB values format: ${valuesFormatVersion}\n# KRAB chart version: ${architecture.charts.krab.version}\n# KRAB selection: ${vendor.id}\n${yaml({
    [dependencies.nvidiaValuesKey]: {
      enabled: includeDevicePlugin || includeProvisioner,
    },
    [dependencies.nfdValuesKey]: nfdValues,
    [dependencies.runtimeValuesKey]: orderedRuntimeValues,
    ...(includeDevicePlugin
      ? { [dependencies.devicePluginValuesKey]: devicePluginValues }
      : {}),
    ...(includeProvisioner
      ? {
          [dependencies.provisionerValuesKey]: {
            ...provisionerValues,
            'node-feature-discovery': { enabled: false },
            profiles,
            ...(provisionerImage ? { image: provisionerImage } : {}),
            ...(provisionerImages.pullPolicy
              ? { imagePullPolicy: provisionerImages.pullPolicy }
              : {}),
            ...(pullSecrets(provisionerImages).length > 0
              ? { imagePullSecrets: pullSecrets(provisionerImages) }
              : {}),
            ...(provisionerDispatcherImage
              ? {
                  job: {
                    ...provisionerValues.job,
                    dispatcherImage: provisionerDispatcherImage,
                  },
                }
              : {}),
          },
        }
      : {}),
  })}`
}

export function normalizeDeploymentName(
  name: string,
  fallback = 'krab',
) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 53)
    .replace(/-+$/g, '')
  return normalized || fallback
}

export function buildValuesFileName(
  catalog: ExplorerCatalog,
  deploymentName = '',
) {
  const { krab } = catalog.plannedArchitecture.charts
  const releaseName = normalizeDeploymentName(deploymentName, krab.releaseName)
  const valuesStem = krab.valuesFileName.replace(/\.ya?ml$/i, '')
  return `${releaseName}-${krab.version}-${valuesStem}.yaml`
}

export function buildInstallScript(
  catalog: ExplorerCatalog,
  deploymentName = '',
) {
  const { krab } = catalog.plannedArchitecture.charts
  const { namespace } = catalog.plannedArchitecture
  const releaseName = normalizeDeploymentName(deploymentName, krab.releaseName)
  const valuesFileName = buildValuesFileName(catalog, deploymentName)
  return `helm upgrade --install ${releaseName} ${krab.ociReference} --version ${krab.version} --namespace ${namespace} --create-namespace --values ${valuesFileName}`
}
