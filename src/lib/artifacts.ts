import { stringify } from 'yaml'

export type ModeCatalog = {
  id: string
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
  nvidiaValidatedModels: string[]
  modelsNotInNvidiaMatrix: string[]
  supportSourceUrl: string
  defaultModeId: string
  modes: ModeCatalog[]
  sourceUrl: string
  experimental: boolean
}

export type VendorCatalog = {
  id: string
  displayName: string
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
      supportedCpuPlatforms: string
      nodeSelector: Record<string, string>
      sourceUrl: string
      supportSourceUrl: string
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
      pullRequest: number
      chartPath: string
      sourceUrl: string
      experimental: boolean
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
  integration: {
    sandboxWorkloads: Record<string, unknown>
    defaultCcMode: string
    sourceUrl: string
    officialSupport: {
      documentationVersion: string
      supportedGpuModels: string[]
      supportedPlatformsUrl: string
      ccModesUrl: string
      workloadsUrl: string
      runtimeRsStatus: string
    }
  }
}

export type ExplorerCatalog = {
  schemaVersion: number
  plannedArchitecture: {
    schemaVersion: number
    status: 'planned'
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
        repository: string
        valuesKey: string
        required: true
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
  { modeId: string | null; cpuTeeIds: string[] }
>

export type ClusterConfiguration = {
  distributionId: string | null
  selinuxEnabled: boolean
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

export type AdvancedConfiguration = {
  containerdConfigDir: string
  containerdRuntimeSocket: string
  containerdConfigFileName: string
  installErofsUtils: boolean
  erofsUtilsImage: string
  nodeSelector: Array<{ key: string; value: string }>
  nodeAffinity: RuntimeNodeAffinity[]
  tolerations: RuntimeToleration[]
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
  installErofsUtils: false,
  erofsUtilsImage: '',
  nodeSelector: [],
  nodeAffinity: [],
  tolerations: [],
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

const yaml = (value: unknown) =>
  stringify(value, { lineWidth: 0 }).trim()

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
        agent?: { httpsProxy?: string; noProxy?: string }
        nvrc?: { enableDCGM?: boolean }
      } | boolean
    >
    defaultShim?: unknown
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
  const enabledShims = new Set<string>()
  for (const shimId of runtime.selectedShimIds) {
    if (vendor.runtime.shims.some(({ id }) => id === shimId)) {
      enabledShims.add(shimId)
    }
  }
  const baseRuntimeShim = vendor.runtime.shims.find(
    ({ id }) => !id.includes('-snp-') && !id.includes('-tdx-'),
  )

  for (const family of vendor.hardwareFamilies) {
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
          enabledShims.add(tee.shimId)
        }
      }
      if (mode.id === 'off' && baseRuntimeShim) {
        enabledShims.add(baseRuntimeShim.id)
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
      if (selectedShim.agent) {
        selectedShim.agent = {
          ...selectedShim.agent,
          httpsProxy: runtime.runtimeHttpsProxy.trim(),
          noProxy: runtime.runtimeNoProxy.trim(),
        }
      }
      if (vendor.id === 'nvidia') {
        selectedShim.nvrc = {
          ...(selectedShim.nvrc ?? {}),
          enableDCGM: runtime.nvidiaDcgmEnabled,
        }
      }
      selectedShims[shimId] = selectedShim
    }
  }
  runtimeValues.shims = selectedShims
  const requiredSnapshotters = new Set(
    [...enabledShims]
      .map((shimId) =>
        vendor.runtime.shims.find(({ id }) => id === shimId)?.snapshotter,
      )
      .filter(
        (snapshotter): snapshotter is string =>
          Boolean(snapshotter) && snapshotter !== 'default',
      ),
  )
  const snapshotterConfiguration = [...enabledShims]
    .map(
      (shimId) =>
        vendor.runtime.shims.find(({ id }) => id === shimId)
          ?.snapshotterConfiguration,
    )
    .find(Boolean)
  if (advanced.installErofsUtils && requiredSnapshotters.has('erofs')) {
    runtimeValues.nodeBinaries = {
      ...(runtimeValues.nodeBinaries ?? {}),
      'erofs-utils': {
        image:
          advanced.erofsUtilsImage.trim() ||
          'quay.io/kata-containers/erofs-utils:1.9.3',
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
    if (snapshotterConfiguration) {
      delete runtimeValues.snapshotter.erofsMergeMode
      runtimeValues.snapshotter.erofsSnapshotterMode =
        snapshotterConfiguration.erofsSnapshotterMode
      runtimeValues.snapshotter.erofsDmverity =
        snapshotterConfiguration.erofsDmverity
      runtimeValues.containerd = {
        ...(runtimeValues.containerd ?? {}),
        userDropIn: snapshotterConfiguration.containerdUserDropIn,
      }
    } else if (!requiredSnapshotters.has('erofs')) {
      delete runtimeValues.snapshotter.erofsSnapshotterMode
      delete runtimeValues.snapshotter.erofsDmverity
      delete runtimeValues.containerd
    }
  }
  delete runtimeValues.defaultShim
  if (runtimeValues['node-feature-discovery']) {
    runtimeValues['node-feature-discovery'].enabled = false
  }
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
  const includeDevicePlugin =
    dependencies.devicePluginRequired ||
    dependencies.devicePluginRequiredBy.includes(vendor.id)
  const includeProvisioner =
    dependencies.provisionerRequired ||
    dependencies.provisionerRequiredBy.includes(vendor.id)
  const nfdImages = advanced.images.nfd
  const nfdValues = {
    ...((nfdImages.reference.trim() || nfdImages.tag.trim() || nfdImages.pullPolicy)
      ? {
          image: {
            ...(nfdImages.reference.trim()
              ? { repository: nfdImages.reference.trim() }
              : {}),
            ...(nfdImages.tag.trim() ? { tag: nfdImages.tag.trim() } : {}),
            ...(nfdImages.pullPolicy
              ? { pullPolicy: nfdImages.pullPolicy }
              : {}),
          },
        }
      : {}),
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
  const provisionerImage = applyImageOverride(
    undefined,
    provisionerImages.reference,
    provisionerImages.tag,
  )
  const provisionerDispatcherImage = applyImageOverride(
    undefined,
    provisionerImages.dispatcherReference,
    provisionerImages.dispatcherTag,
  )

  return `# ${architecture.notice}\n${yaml({
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
              ? { job: { dispatcherImage: provisionerDispatcherImage } }
              : {}),
          },
        }
      : {}),
  })}`
}

export function buildInstallScript(
  catalog: ExplorerCatalog,
) {
  const { krab } = catalog.plannedArchitecture.charts
  const { namespace } = catalog.plannedArchitecture
  return `helm upgrade --install ${krab.releaseName} ${krab.ociReference} --namespace ${namespace} --create-namespace --values ${krab.valuesFileName}`
}
