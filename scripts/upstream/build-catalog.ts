import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { syncChartDependencies } from '../sync-chart-dependencies.ts'
import { syncChartImages } from '../sync-chart-images.ts'
import { resolveImageLock, syncPrecheck } from '../sync-precheck.ts'
import type { syncReleaseVersion } from '../sync-release-version.ts'
import { blobUrl, requireValue, type loadSources } from './sources.ts'
import { teeVendorShims, type loadPolicies } from './policy.ts'
import type { loadInputs } from './inputs.ts'

const chartRepositories = {
  nfd: 'oci://registry.k8s.io/nfd/charts',
  devicePlugin: 'oci://ghcr.io/kata-containers/kata-device-plugin-charts',
  provisioner: 'oci://ghcr.io/kata-containers/kata-device-provisioner-charts',
}

type ImageValues = {
  reference?: string
  repository?: string
  tag?: string | null
}

const resolveImage = <T extends ImageValues>(
  image: T,
  fallbackTag: string,
  label: string,
) => {
  const reference = image.reference ?? image.repository
  const tag = image.tag?.trim() || fallbackTag.trim()
  requireValue(reference, `${label} image reference is missing`)
  requireValue(tag, `${label} image tag is missing`)
  if (tag === 'latest') {
    throw new Error(`${label} image must not use the moving latest tag`)
  }
  return { ...image, tag }
}

const firstComment = (content: string) =>
  content
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => line.replace(/^#\s?/, '').trim())
    .find(Boolean) ?? ''

export async function buildCatalog({ root, shouldFetch, sources, policies, inputs, release }: {
  root: string
  shouldFetch: boolean
  sources: Awaited<ReturnType<typeof loadSources>>
  policies: Awaited<ReturnType<typeof loadPolicies>>
  inputs: Awaited<ReturnType<typeof loadInputs>>
  release: Awaited<ReturnType<typeof syncReleaseVersion>>
}) {
  const { lock, source, sourceById, cachePath, sourceLink } = sources
  const { compatibility, presentation, presentationFor } = policies
  const {
    kataChart, kataVersions, nfdChart, nfdValues, plannedArchitecture,
    krabChart, krabValues, krabSchema, kataValuesRaw, kataValues,
    kataProfile, provisionerChart, provisionerValues, devicePluginChart,
    provisionerReadme, pluginCode, pluginValues, kataChartReference,
    provisionerNamespace,
  } = inputs
  const krabChartPath = resolve(root, 'charts/krab/Chart.yaml')
  const krabValuesPath = resolve(root, 'charts/krab/values.yaml')
  const precheckDockerfilePath = resolve(root, 'Dockerfile.precheck')
  const precheckValuesPath = resolve(root, 'charts/precheck/values.yaml')

  requireValue(kataChart.version, 'Kata chart version is missing')
  const trustee = requireValue(
    kataVersions.externals?.['coco-trustee'],
    'Kata Trustee version is missing',
  )
  const trusteeRepository = requireValue(
    trustee.url,
    'Kata Trustee repository is missing',
  ).replace(/\.git$/, '')
  const trusteeCommit = requireValue(
    trustee.version,
    'Kata Trustee commit is missing',
  )
  if (!/^[0-9a-f]{40}$/.test(trusteeCommit)) {
    throw new Error(`Kata Trustee reference is not a full commit: ${trusteeCommit}`)
  }
  plannedArchitecture.attestation = {
    trustee: {
      displayName: 'Trustee',
      repository: trusteeRepository,
      commit: trusteeCommit,
      sourceUrl: `${trusteeRepository}/commit/${trusteeCommit}`,
      documentationUrl: `${trusteeRepository}/blob/${trusteeCommit}/README.md`,
      kataSourceUrl: sourceLink('kata-versions'),
    },
  }
  if (krabChart.name !== 'krab' || krabChart.type !== 'application') {
    throw new Error('charts/krab/Chart.yaml is not a KRAB application chart')
  }
  const krabDependencies = new Map<string, { name: string; condition?: string }>(
    (krabChart.dependencies ?? []).map(
      (dependency: { name: string; condition?: string }) => [
        dependency.name,
        dependency,
      ] as const,
    ),
  )
  for (const name of [
    'node-feature-discovery',
    'kata-deploy',
    'kata-device-plugin',
    'kata-device-provisioner',
  ]) {
    requireValue(krabDependencies.get(name), `KRAB chart dependency is missing: ${name}`)
  }
  const plannedDependencies = plannedArchitecture.charts.krab.dependencies
  const expectedValuesKeys = {
    'node-feature-discovery': plannedDependencies.nfdValuesKey,
    'kata-deploy': plannedDependencies.runtimeValuesKey,
    'kata-device-plugin': plannedDependencies.devicePluginValuesKey,
    'kata-device-provisioner': plannedDependencies.provisionerValuesKey,
  }
  for (const [dependencyName, valuesKey] of Object.entries(expectedValuesKeys)) {
    if (dependencyName !== valuesKey) {
      throw new Error(
        `KRAB dependency ${dependencyName} does not match values key ${valuesKey}`,
      )
    }
  }
  if (
    requireValue(krabDependencies.get('node-feature-discovery'), 'Missing NFD dependency').condition ||
    requireValue(krabDependencies.get('kata-deploy'), 'Missing Kata dependency').condition
  ) {
    throw new Error('NFD and kata-deploy must be unconditional KRAB dependencies')
  }
  for (const name of ['kata-device-plugin', 'kata-device-provisioner']) {
    const expectedCondition = `${plannedDependencies.nvidiaValuesKey}.enabled`
    if (requireValue(krabDependencies.get(name), `Missing ${name} dependency`).condition !== expectedCondition) {
      throw new Error(`${name} must be gated by nvidia.enabled`)
    }
  }
  if (
    krabValues['kata-deploy']?.['node-feature-discovery']?.enabled !== false
  ) {
    throw new Error('KRAB values must disable kata-deploy nested NFD')
  }
  requireValue(krabValues['kata-device-provisioner']?.profiles, 'KRAB provisioner profiles are missing')
  for (const property of [
    'nvidia',
    'node-feature-discovery',
    'kata-deploy',
    'kata-device-plugin',
    'kata-device-provisioner',
  ]) {
    requireValue(krabSchema.properties?.[property], `KRAB values schema is missing ${property}`)
  }
  plannedArchitecture.charts.krab.version = String(krabChart.version)
  plannedArchitecture.charts.krab.appVersion = String(krabChart.appVersion)
  if (plannedArchitecture.status !== (release.prerelease ? 'prerelease' : 'stable')) {
    throw new Error('KRAB architecture status does not match package.json version')
  }
  requireValue(plannedArchitecture.charts?.krab?.ociReference, 'Missing KRAB chart OCI reference')
  const upstreamDistributions = requireValue(
    kataValuesRaw.match(/k8sDistribution:[^#]+#\s*([^\n]+)/)?.[1],
    'Unable to derive supported Kubernetes distributions from Kata values',
  )
    .split(',')
    .map((distribution) => distribution.trim())
  for (const distribution of plannedArchitecture.cluster.distributions) {
    if (!upstreamDistributions.includes(distribution.kataDeployValue)) {
      throw new Error(
        `Unsupported Kata Kubernetes distribution: ${distribution.kataDeployValue}`,
      )
    }
    distribution.sourceUrl = sourceLink('kata-values')
  }
  plannedArchitecture.cluster.selinuxSourceUrl = sourceLink('kata-values')
  const nfdRelease = requireValue(source('nfd-chart').release, 'NFD release is missing')
  if (
    !/^v\d+\.\d+\.\d+$/.test(nfdRelease) ||
    source('nfd-values').release !== nfdRelease ||
    source('nfd-values').ref !== source('nfd-chart').ref ||
    nfdChart.name !== plannedArchitecture.charts.krab.dependencies.nfdValuesKey ||
    String(nfdChart.appVersion) !== nfdRelease
  ) {
    throw new Error('Pinned NFD files must come from the same release')
  }
  const nfdVersion = nfdRelease.slice(1)
  if (
    kataChart.name !== 'kata-deploy' ||
    devicePluginChart.name !== 'kata-device-plugin' ||
    provisionerChart.name !== 'kata-device-provisioner' ||
    !kataChartReference.endsWith(`/${kataChart.name}`)
  ) {
    throw new Error('Pinned chart names do not match KRAB dependencies')
  }
  const updatedChart = syncChartDependencies(
    await readFile(krabChartPath, 'utf8'),
    {
      'node-feature-discovery': {
        version: nfdVersion,
        repository: chartRepositories.nfd,
      },
      'kata-deploy': {
        version: String(kataChart.version),
        repository: kataChartReference.slice(0, -`/${kataChart.name}`.length),
      },
      'kata-device-plugin': {
        version: String(requireValue(devicePluginChart.version, 'Device plugin chart version is missing')),
        repository: chartRepositories.devicePlugin,
      },
      'kata-device-provisioner': {
        version: String(requireValue(provisionerChart.version, 'Provisioner chart version is missing')),
        repository: chartRepositories.provisioner,
      },
    },
  )
  plannedArchitecture.charts.nfd = {
    chartName: nfdChart.name,
    version: nfdVersion,
    appVersion: String(nfdChart.appVersion),
    repository: chartRepositories.nfd,
    valuesKey: plannedArchitecture.charts.krab.dependencies.nfdValuesKey,
    required: plannedArchitecture.charts.krab.dependencies.nfdRequired,
    image: resolveImage(
      nfdValues.image,
      String(nfdChart.appVersion),
      'node-feature-discovery',
    ),
    sourceUrl: sourceLink('nfd-chart'),
  }
  plannedArchitecture.charts.kataDeploy = {
    chartName: kataChart.name,
    version: String(kataChart.version),
    required: plannedArchitecture.charts.krab.dependencies.runtimeRequired,
    sourceUrl: sourceLink('kata-chart'),
  }
  plannedArchitecture.charts.devicePlugin = {
    chartName: devicePluginChart.name,
    version: String(devicePluginChart.version),
    appVersion: String(devicePluginChart.appVersion),
    required: plannedArchitecture.charts.krab.dependencies.devicePluginRequired,
    sourceUrl: sourceLink('device-plugin-chart'),
  }
  plannedArchitecture.charts.provisioner = {
    chartName: provisionerChart.name,
    version: String(provisionerChart.version),
    appVersion: String(provisionerChart.appVersion),
    required: plannedArchitecture.charts.krab.dependencies.provisionerRequired,
    sourceUrl: sourceLink('provisioner-chart'),
  }
  requireValue(kataProfile.shims, 'Kata NVIDIA shim profile is missing shims')
  requireValue(provisionerChart.version, 'Provisioner chart version is missing')
  requireValue(devicePluginChart.version, 'Device plugin chart version is missing')
  const kataDeployImage = resolveImage(
    kataValues.image,
    String(kataChart.appVersion),
    'kata-deploy',
  )
  const kataKubectlImage = resolveImage(
    plannedArchitecture.images.kubectl,
    '',
    'kata-deploy kubectl',
  )
  const kataDispatcherImage = resolveImage(
    kataValues.job?.dispatcherImage,
    '',
    'kata-deploy dispatcher',
  )
  const devicePluginImage = resolveImage(
    {
      ...pluginValues.image,
      ...plannedArchitecture.images.devicePlugin,
    },
    '',
    'kata-device-plugin',
  )
  if (devicePluginImage.repository !== pluginValues.image?.repository) {
    throw new Error(
      'Kata device plugin image repository does not match the pinned chart',
    )
  }
  const provisionerImage = resolveImage(
    provisionerValues.image,
    String(provisionerChart.appVersion),
    'kata-device-provisioner',
  )
  const provisionerDispatcherImage = resolveImage(
    provisionerValues.job?.dispatcherImage,
    '',
    'kata-device-provisioner dispatcher',
  )
  const precheckImage = {
    reference: requireValue(
      provisionerImage.reference ?? provisionerImage.repository,
      'Provisioner image reference is missing',
    ),
    tag: provisionerImage.tag,
  }
  const precheckDispatcher = {
    reference: requireValue(
      provisionerDispatcherImage.reference ?? provisionerDispatcherImage.repository,
      'Provisioner dispatcher reference is missing',
    ),
    tag: provisionerDispatcherImage.tag,
  }
  if (precheckImage.tag !== String(provisionerChart.appVersion)) {
    throw new Error('Provisioner image tag and chart appVersion must agree')
  }
  const precheckImageLock = shouldFetch
    ? await resolveImageLock(precheckImage.reference, precheckImage.tag)
    : JSON.parse(await readFile(resolve(root, 'upstream/precheck-image.lock.json'), 'utf8'))
  const updatedPrecheck = syncPrecheck(
    await readFile(precheckDockerfilePath, 'utf8'),
    await readFile(precheckValuesPath, 'utf8'),
    precheckImageLock,
    precheckImage,
    precheckDispatcher,
  )
  const updatedValues = syncChartImages(
    await readFile(krabValuesPath, 'utf8'),
    {
      nfd: plannedArchitecture.charts.nfd.image,
      kataDeploy: kataDeployImage,
      kubectl: kataKubectlImage,
      kataDispatcher: kataDispatcherImage,
      devicePlugin: devicePluginImage,
      provisioner: provisionerImage,
      provisionerDispatcher: provisionerDispatcherImage,
    },
  )
  const nvidiaGpuShims = Object.entries(kataProfile.shims)
    .filter(([name, config]) =>
      name.startsWith('qemu-nvidia-gpu') &&
      typeof config === 'object' &&
      config !== null &&
      (config as { enabled?: boolean }).enabled,
    )
    .map(([name, config]) => ({
      id: name,
      runtimeClass: `kata-${name}`,
      supportedArches:
        (config as { supportedArches?: string[] }).supportedArches ?? [],
      snapshotter:
        (config as { containerd?: { snapshotter?: string } }).containerd?.snapshotter ||
        'default',
      nodeSelector:
        (config as { runtimeClass?: { nodeSelector?: Record<string, string> } })
          .runtimeClass?.nodeSelector ?? {},
      sourceUrl: sourceLink('kata-nvidia-profile'),
    }))

  if (nvidiaGpuShims.length === 0) {
    throw new Error('No enabled NVIDIA Kata shims found')
  }
  const nvidiaGpuRuntimeRsShims = nvidiaGpuShims.filter(({ id }) =>
    id.endsWith('-runtime-rs'),
  ).map((shim) => ({ ...shim, selectionGroup: 'gpu' }))
  const cpuTees = nvidiaGpuRuntimeRsShims.flatMap((shim) => {
    if (shim.id.includes('-snp-')) {
      return [{
        id: 'snp',
        displayName: 'AMD SEV-SNP',
        shimId: shim.id,
        runtimeClass: shim.runtimeClass,
        documentedRuntimeClass: shim.runtimeClass.replace('-runtime-rs', ''),
        nodeSelector: shim.nodeSelector,
        sourceUrl: shim.sourceUrl,
      }]
    }
    if (shim.id.includes('-tdx-')) {
      return [{
        id: 'tdx',
        displayName: 'Intel TDX',
        shimId: shim.id,
        runtimeClass: shim.runtimeClass,
        documentedRuntimeClass: shim.runtimeClass.replace('-runtime-rs', ''),
        nodeSelector: shim.nodeSelector,
        sourceUrl: shim.sourceUrl,
      }]
    }
    return []
  })

  if (nvidiaGpuRuntimeRsShims.length !== 3 || cpuTees.length !== 2) {
    throw new Error('Expected base, SNP, and TDX NVIDIA runtime-rs shims')
  }

  const nvidiaCpuShimId = 'qemu-nvidia-cpu-runtime-rs'
  const nvidiaCpuSnapshotterConfiguration = {
    erofsSnapshotterMode: 'memory' as const,
    erofsDmverity: true,
    containerdUserDropIn:
      "[plugins.'io.containerd.snapshotter.v1.erofs']\n  enable_fsverity = false\n",
  }
  const nvidiaCpuShimEntries = Object.entries(
    requireValue(kataValues.shims, 'Kata values are missing shims'),
  )
    .filter(([name, config]) =>
      name.startsWith('qemu-nvidia-cpu') &&
      name.endsWith('-runtime-rs') &&
      typeof config === 'object' &&
      config !== null &&
      (config as { enabled?: boolean | null }).enabled !== false,
    )
  const nvidiaCpuShimValues = Object.fromEntries(
    nvidiaCpuShimEntries.map(([name, config]) => {
      const shimConfig = structuredClone(config) as {
        containerd?: { snapshotter?: string }
      }
      if (name === nvidiaCpuShimId) {
        shimConfig.containerd = {
          ...shimConfig.containerd,
          snapshotter: 'erofs',
        }
      }
      return [name, shimConfig]
    }),
  )
  const nvidiaCpuShims = nvidiaCpuShimEntries.map(([name, config]) => {
    const shimConfig = structuredClone(config) as {
      supportedArches?: string[]
      containerd?: { snapshotter?: string }
      runtimeClass?: { nodeSelector?: Record<string, string> }
    }
    const snapshotter =
      name === nvidiaCpuShimId
        ? 'erofs'
        : shimConfig.containerd?.snapshotter || 'default'
    return {
      id: name,
      runtimeClass: `kata-${name}`,
      userSelectable: true,
      selectionGroup: 'cpu' as const,
      supportedArches: shimConfig.supportedArches ?? [],
      snapshotter,
      ...(snapshotter === 'erofs'
        ? { snapshotterConfiguration: nvidiaCpuSnapshotterConfiguration }
        : {}),
      nodeSelector: shimConfig.runtimeClass?.nodeSelector ?? {},
      sourceUrl: sourceLink('kata-values'),
    }
  })

  if (!nvidiaCpuShims.some(({ id }) => id === nvidiaCpuShimId)) {
    throw new Error(`Kata values are missing ${nvidiaCpuShimId}`)
  }

  const runtimeRsShims = [...nvidiaGpuRuntimeRsShims, ...nvidiaCpuShims]

  const localShims = Object.entries(
    requireValue(kataValues.shims, 'Kata values are missing shims'),
  )
    .filter(([name, config]) =>
      name !== 'disableAll' &&
      !name.includes('nvidia-gpu') &&
      !/(?:^|-)(?:snp|tdx|se)(?:-|$)/.test(name) &&
      (name.endsWith('-runtime-rs') || name === 'dragonball') &&
      typeof config === 'object' &&
      config !== null &&
      (config as { enabled?: boolean | null }).enabled !== false,
    )
    .map(([name, config]) => ({
      id: name,
      runtimeClass: `kata-${name}`,
      supportedArches:
        (config as { supportedArches?: string[] }).supportedArches ?? [],
      snapshotter:
        name === 'qemu-nvidia-cpu-runtime-rs'
          ? 'erofs'
          : (config as { containerd?: { snapshotter?: string } }).containerd
              ?.snapshotter || 'default',
      ...(name === 'qemu-nvidia-cpu-runtime-rs'
        ? {
            snapshotterConfiguration: nvidiaCpuSnapshotterConfiguration,
          }
        : {}),
      nodeSelector:
        (config as { runtimeClass?: { nodeSelector?: Record<string, string> } })
          .runtimeClass?.nodeSelector ?? {},
      sourceUrl: sourceLink('kata-values'),
    }))

  if (localShims.length === 0) {
    throw new Error('No local Kata runtime shims found')
  }

  const localShimValues = Object.fromEntries(
    localShims.map(({ id, snapshotter }) => {
      const config = structuredClone(kataValues.shims[id])
      if (snapshotter !== 'default') {
        config.containerd = {
          ...(config.containerd ?? {}),
          snapshotter,
        }
      }
      return [id, config]
    }),
  )
  const localRuntimeValues = {
    debug: kataValues.debug,
    deploymentMode: kataValues.deploymentMode,
    image: kataDeployImage,
    kubectlImage: kataKubectlImage,
    job: {
      dispatcherImage: kataDispatcherImage,
    },
    snapshotter: kataValues.snapshotter,
    shims: {
      disableAll: true,
      ...localShimValues,
    },
    defaultShim: kataValues.defaultShim,
    runtimeClasses: kataValues.runtimeClasses,
    'node-feature-discovery': kataValues['node-feature-discovery'],
  }

  const teeVendors = Object.entries(teeVendorShims).map(([id, shimId]) => {
    const config = requireValue(
      kataValues.shims[shimId],
      `Kata values are missing ${shimId}`,
    )
    const shim = {
      id: shimId,
      runtimeClass: `kata-${shimId}`,
      supportedArches:
        (config as { supportedArches?: string[] }).supportedArches ?? [],
      snapshotter:
        (config as { containerd?: { snapshotter?: string } }).containerd
          ?.snapshotter || 'default',
      nodeSelector:
        (config as { runtimeClass?: { nodeSelector?: Record<string, string> } })
          .runtimeClass?.nodeSelector ?? {},
      sourceUrl: sourceLink('kata-values'),
    }
    return {
      id,
      ...presentationFor(id),
      capabilities: [{ id: 'confidential-computing' }],
      sourceUrl: sourceLink('kata-values'),
      hardwareFamilies: [],
      runtime: {
        chart: {
          name: kataChart.name,
          version: String(kataChart.version),
          appVersion: String(kataChart.appVersion),
          ociReference: kataChartReference,
          namespace: plannedArchitecture.namespace,
          valuesFileName: `kata-${id}.values.yaml`,
          values: {
            ...localRuntimeValues,
            shims: {
              disableAll: true,
              [shimId]: config,
            },
          },
          sourceUrl: sourceLink('kata-chart'),
        },
        shims: [shim],
        cpuTees: [],
      },
      provisioner: {
        chart: {
          name: provisionerChart.name,
          version: String(provisionerChart.version),
          appVersion: String(provisionerChart.appVersion),
          namespace: plannedArchitecture.namespace,
          repository: source('provisioner-chart').repository,
          ref: source('provisioner-chart').ref,
          pullRequest: source('provisioner-chart').pullRequest,
          chartPath: dirname(source('provisioner-chart').path),
          sourceUrl: sourceLink('provisioner-chart'),
          experimental: true,
        },
        values: {
          image: provisionerImage,
          job: { dispatcherImage: provisionerDispatcherImage },
        },
      },
      devicePlugin: {
        chart: plannedArchitecture.charts.devicePlugin,
        values: {},
        sourceUrl: sourceLink('device-plugin-chart'),
      },
      workload: {
        resourceName: '',
        nvSwitchResourceName: '',
        resourceNaming: '',
        sourceUrl: sourceLink('kata-values'),
      },
    }
  })

  const customTeeNodeSelectors = compatibility.teeSelectors
  const kataRule = await readFile(cachePath('kata-node-feature-rule'), 'utf8')
  const provisionerRule = await readFile(cachePath('provisioner-node-feature-rule'), 'utf8')
  const nfdLabels = await readFile(cachePath('nfd-feature-labels'), 'utf8')
  for (const [shimId, selector] of Object.entries(customTeeNodeSelectors)) {
    requireValue(kataValues.shims[shimId], `Missing Kata shim ${shimId}`)
    requireValue(compatibility.teeSelectorEvidence[shimId], `Missing selector evidence for ${shimId}`)
    for (const [label, value] of Object.entries(selector)) {
      const produced = shimId === 'qemu-se-runtime-rs'
        ? label === 'feature.node.kubernetes.io/cpu-security.se.enabled' &&
          nfdLabels.includes('feature.node.kubernetes.io/<feature>') &&
          nfdLabels.includes('`cpu-security.se.enabled`')
        : kataRule.includes(`"${label}": "${value}"`)
      if (value !== 'true' || !produced) {
        throw new Error(`${shimId} selector ${label} is not backed by pinned NFD/Kata data`)
      }
    }
  }
  const customTeeShims = teeVendors.map(({ runtime }) => ({
    ...runtime.shims[0],
    nodeSelector: customTeeNodeSelectors[runtime.shims[0].id],
  }))
  const customRuntimeShims = [
    ...localShims,
    ...customTeeShims,
    ...nvidiaGpuRuntimeRsShims,
  ]
  const customRuntimeValues = {
    ...localRuntimeValues,
    shims: {
      ...localRuntimeValues.shims,
      ...Object.fromEntries(customTeeShims.map(({ id, nodeSelector }) => [id, {
        ...structuredClone(kataValues.shims[id]),
        runtimeClass: { nodeSelector },
      }])),
      ...Object.fromEntries(nvidiaGpuRuntimeRsShims.map(({ id }) => [id,
        structuredClone(kataProfile.shims[id]),
      ])),
    },
  }

  const gpuResource = requireValue(
    pluginCode.match(/name:\s*"(nvidia\.com\/gpu)"/)?.[1],
    'Unable to find the NVIDIA GPU resource name',
  )
  const nvSwitchResource = requireValue(
    pluginCode.match(/name:\s*"(nvidia\.com\/nvswitch)"/)?.[1],
    'Unable to find the NVIDIA NVSwitch resource name',
  )

  const tableRows = provisionerReadme
    .split('\n')
    .map((line) => line.match(/^\| \[`([^`]+)`\]\(([^)]+)\) \| ([^|]+) \| ([^|]+) \|$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))

  const profileSources = Object.fromEntries(Object.entries(compatibility.families)
    .flatMap(([familyId, definition]) => Object.entries(definition.profiles)
      .map(([name, policy]) => [name, { ...policy, familyId }]))) as Record<string, {
        sourceId: string; familyId: string; mode: string; cpuTees: string[]
      }>
  if (Object.keys(profileSources).length !== Object.values(compatibility.families)
    .reduce((count, family) => count + Object.keys(family.profiles).length, 0)) {
    throw new Error('A provisioner profile belongs to more than one family')
  }
  const documentedProfiles = new Set(tableRows.map((row) => row[1]))
  for (const name of Object.keys(profileSources)) {
    if (!documentedProfiles.has(name)) throw new Error(`Reviewed profile ${name} is missing upstream`)
    for (const tee of profileSources[name].cpuTees) {
      if (!cpuTees.some(({ id }) => id === tee)) {
        throw new Error(`${name} refers to unsupported CPU TEE ${tee}`)
      }
    }
  }

  const profileRecords = await Promise.all(
    tableRows
      .filter((row) => profileSources[row[1]])
      .map(async (row) => {
        const [profileName, nodes, modeText] = [row[1], row[3].trim(), row[4].trim()]
        const { sourceId, familyId } = profileSources[profileName]
        const raw = await readFile(cachePath(sourceId), 'utf8')
        const profileFile = parse(raw)
        const configuredProfile = requireValue(
          profileFile.profiles?.[profileName],
          `${profileName} values file has no profiles.${profileName}`,
        )
        if (configuredProfile.enabled !== true) {
          throw new Error(`${profileName} must be enabled in its values file`)
        }
        const { enabled: _enabled, ...values } = configuredProfile
        const ccMode = requireValue(values.ccMode, `${profileName} has no ccMode`)
        if (ccMode !== profileSources[profileName].mode) {
          throw new Error(`${profileName} mode differs from the reviewed matrix`)
        }
        for (const label of Object.keys(values.nodeSelector ?? {})) {
          if (!provisionerRule.includes(`"${label}": "true"`)) {
            throw new Error(`${profileName} selects ${label}, but the pinned provisioner rule does not produce it`)
          }
        }
        return {
          profileName,
          nodes,
          modeText,
          ccMode,
          generation: familyId,
          description: firstComment(raw),
          values,
          sourceId,
          sourceUrl: sourceLink(sourceId),
          sourcePath: source(sourceId).path,
        }
      }),
  )

  const familyDefinitions = compatibility.families

  const families = Object.entries(familyDefinitions).map(([generation, definition]) => {
    const profiles = profileRecords.filter((profile) => profile.generation === generation)
    const passthrough = requireValue(
      profiles.find((profile) => profile.ccMode === 'off'),
      `Missing ${generation} passthrough profile`,
    )
    const models = passthrough.nodes.match(/\(([^)]+)\)/)?.[1]
      ?.split(',')
      .map((model) => model.trim()) ?? []
    if (definition.evidence.length === 0 || definition.evidence.some((id) => !sourceById.has(id))) {
      throw new Error(`${generation} has missing compatibility evidence`)
    }
    if (definition.supportedArches.length === 0) {
      throw new Error(`${generation} support decision needs review`)
    }
    if (definition.availability === 'available' && !definition.supportedArches.every((arch) =>
      nvidiaGpuRuntimeRsShims[0].supportedArches.includes(arch))) {
      throw new Error(`${generation} claims an architecture unsupported by Kata's GPU runtime`)
    }

    return {
      id: generation,
      displayName: definition.displayName,
      upstreamName: passthrough.nodes.replace(/\s*\([^)]+\)/, ''),
      models,
      modelAliases: Object.fromEntries(models.filter((model) => compatibility.modelAliases[model])
        .map((model) => [model, compatibility.modelAliases[model]])),
      supportedArches: definition.supportedArches,
      availability: definition.availability,
      availabilityReason: definition.availabilityReason,
      evidenceUrls: definition.evidence.map(sourceLink),
      defaultModeId: 'off',
      modes: profiles.map((profile) => ({
        id: String(profile.ccMode),
        supportedCpuTeeIds: profileSources[profile.profileName].cpuTees,
        displayName:
          profile.ccMode === 'off'
            ? 'Passthrough'
            : profile.ccMode === 'ppcie'
              ? 'Confidential computing · Protected PCIe'
              : 'Confidential computing',
        badge:
          profile.ccMode === 'off'
            ? null
            : String(profile.ccMode).toUpperCase(),
        label: profile.modeText,
        description: profile.description,
        values: profile.values,
        profileName: profile.profileName,
        sourcePath: profile.sourcePath,
        sourceUrl: profile.sourceUrl,
      })),
      sourceUrl: sourceLink('provisioner-profiles'),
      experimental: true,
    }
  })

  const catalog = {
    schemaVersion: 1,
    plannedArchitecture,
    vendors: [
      {
        id: 'custom',
        ...presentationFor('custom'),
        capabilities: [
          { id: 'general-purpose' },
          { id: 'multiple-hypervisors' },
          { id: 'confidential-computing' },
          { id: 'gpu', resourceName: gpuResource },
        ],
        sourceUrl: sourceLink('kata-chart'),
        hardwareFamilies: families,
        runtime: {
          chart: {
            name: kataChart.name,
            version: String(kataChart.version),
            appVersion: String(kataChart.appVersion),
            ociReference: kataChartReference,
            namespace: plannedArchitecture.namespace,
            valuesFileName: 'kata-custom.values.yaml',
            values: customRuntimeValues,
            sourceUrl: sourceLink('kata-chart'),
          },
          shims: customRuntimeShims,
          cpuTees,
        },
        provisioner: {
          chart: {
            name: provisionerChart.name,
            version: String(provisionerChart.version),
            appVersion: String(provisionerChart.appVersion),
            namespace: plannedArchitecture.namespace,
            repository: source('provisioner-chart').repository,
            ref: source('provisioner-chart').ref,
            pullRequest: source('provisioner-chart').pullRequest,
            chartPath: dirname(source('provisioner-chart').path),
            sourceUrl: sourceLink('provisioner-chart'),
            experimental: true,
          },
          values: {
            image: provisionerImage,
            job: { dispatcherImage: provisionerDispatcherImage },
          },
        },
        devicePlugin: {
          chart: plannedArchitecture.charts.devicePlugin,
          values: {
            ...pluginValues,
            image: devicePluginImage,
          },
          sourceUrl: sourceLink('device-plugin-chart'),
        },
        workload: {
          resourceName: gpuResource,
          nvSwitchResourceName: nvSwitchResource,
          resourceNaming: pluginValues.resourceNaming,
          sourceUrl: sourceLink('device-plugin-code'),
        },
      },
      {
        id: 'nvidia',
        ...presentationFor('nvidia'),
        capabilities: [
          { id: 'gpu', resourceName: gpuResource },
          { id: 'confidential-computing', modes: [...new Set(profileRecords.map((p) => p.ccMode))] },
        ],
        sourceUrl: sourceLink('kata-nvidia-profile'),
        hardwareFamilies: families,
        runtime: {
          chart: {
            name: kataChart.name,
            version: String(kataChart.version),
            appVersion: String(kataChart.appVersion),
            ociReference: kataChartReference,
            namespace: provisionerNamespace,
            valuesFileName: 'kata-nvidia.values.yaml',
            values: {
              ...kataProfile,
              shims: {
                ...kataProfile.shims,
                ...nvidiaCpuShimValues,
              },
              image: kataDeployImage,
              kubectlImage: kataKubectlImage,
              job: {
                ...(kataProfile.job ?? {}),
                dispatcherImage: kataDispatcherImage,
              },
            },
            sourceUrl: sourceLink('kata-chart'),
          },
          shims: runtimeRsShims,
          cpuTees,
        },
        provisioner: {
          chart: {
            name: provisionerChart.name,
            version: String(provisionerChart.version),
            appVersion: String(provisionerChart.appVersion),
            namespace: provisionerNamespace,
            repository: source('provisioner-chart').repository,
            ref: source('provisioner-chart').ref,
            pullRequest: source('provisioner-chart').pullRequest,
            chartPath: dirname(source('provisioner-chart').path),
            sourceUrl: sourceLink('provisioner-chart'),
            experimental: true,
          },
          values: {
            image: provisionerImage,
            job: { dispatcherImage: provisionerDispatcherImage },
          },
        },
        devicePlugin: {
          chart: plannedArchitecture.charts.devicePlugin,
          values: {
            ...pluginValues,
            image: devicePluginImage,
          },
          sourceUrl: sourceLink('device-plugin-chart'),
        },
        workload: {
          resourceName: gpuResource,
          nvSwitchResourceName: nvSwitchResource,
          resourceNaming: pluginValues.resourceNaming,
          sourceUrl: sourceLink('device-plugin-code'),
        },
      },
      ...teeVendors,
    ],
  }
  const vendorOrder = presentation.vendors.map(({ id }) => id)
  catalog.vendors.sort(
    (left, right) =>
      vendorOrder.indexOf(left.id) - vendorOrder.indexOf(right.id),
  )

  const provenance = {
    schemaVersion: 1,
    releaseContract: {
      path: 'upstream/architecture.yaml',
      status: plannedArchitecture.status,
      notice: plannedArchitecture.notice,
    },
    generatedFrom: lock.sources.map((item) => ({
      id: item.id,
      repository: item.repository,
      ref: item.ref,
      release: item.release,
      pullRequest: item.pullRequest,
      draft: item.draft ?? false,
      path: item.path,
      sha256: item.sha256,
      sourceUrl: blobUrl(item),
    })),
  }

  return {
    updatedChart, updatedValues, updatedPrecheck, precheckImageLock, catalog, provenance,
    familyCount: families.length,
    runtimeClassCount: runtimeRsShims.length,
    localShimCount: localShims.length,
  }
}
