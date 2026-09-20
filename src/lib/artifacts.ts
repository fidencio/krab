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

const yaml = (value: unknown) =>
  stringify(value, { lineWidth: 0 }).trim()

export function buildValuesBundle(
  catalog: ExplorerCatalog,
  vendor: VendorCatalog,
  selections: FamilySelections,
  cluster: ClusterConfiguration,
) {
  const architecture = catalog.plannedArchitecture
  const profiles: Record<string, unknown> = {}
  const runtimeValues = structuredClone(vendor.runtime.chart.values) as {
    shims?: Record<string, { enabled?: boolean } | boolean>
    defaultShim?: unknown
    'node-feature-discovery'?: { enabled?: boolean }
    snapshotter?: {
      setup?: string[]
      erofsSnapshotterMode?: string
      erofsDmverity?: boolean
    }
    containerd?: unknown
    k8sDistribution?: string
    selinux?: { enabled?: boolean }
  }
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
  const selectedShims: Record<string, { enabled?: boolean } | boolean> = {
    disableAll: true,
  }
  for (const shimId of enabledShims) {
    const shimConfig = sourceShims[shimId]
    if (shimConfig && typeof shimConfig !== 'boolean') {
      selectedShims[shimId] = { ...shimConfig, enabled: true }
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
  if (requiredSnapshotters.size === 0) {
    delete runtimeValues.snapshotter
    delete runtimeValues.containerd
  } else if (runtimeValues.snapshotter) {
    runtimeValues.snapshotter.setup = (
      runtimeValues.snapshotter.setup ?? []
    ).filter((snapshotter) => requiredSnapshotters.has(snapshotter))
    if (!requiredSnapshotters.has('erofs')) {
      delete runtimeValues.snapshotter.erofsSnapshotterMode
      delete runtimeValues.snapshotter.erofsDmverity
      delete runtimeValues.containerd
    }
  }
  delete runtimeValues.defaultShim
  if (runtimeValues['node-feature-discovery']) {
    runtimeValues['node-feature-discovery'].enabled = false
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

  return `# ${architecture.notice}\n${yaml({
    [dependencies.nvidiaValuesKey]: {
      enabled: includeDevicePlugin || includeProvisioner,
    },
    [dependencies.nfdValuesKey]: {},
    [dependencies.runtimeValuesKey]: orderedRuntimeValues,
    ...(includeDevicePlugin
      ? { [dependencies.devicePluginValuesKey]: vendor.devicePlugin.values }
      : {}),
    ...(includeProvisioner
      ? {
          [dependencies.provisionerValuesKey]: {
            'node-feature-discovery': { enabled: false },
            profiles,
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

