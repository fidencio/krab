import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { parse } from 'yaml'

type Source = {
  id: string
  repository: string
  ref: string
  release?: string
  pullRequest?: number
  draft?: boolean
  path: string
  cache: string
  sha256: string
  url?: string
  sourceUrl?: string
}

type LockFile = {
  schemaVersion: number
  sources: Source[]
}

const root = resolve(import.meta.dirname, '..')
const cacheRoot = resolve(root, 'upstream/cache')
const lockPath = resolve(root, 'upstream/sources.lock.yaml')
const plannedArchitecturePath = resolve(root, 'upstream/planned-architecture.yaml')
const krabChartPath = resolve(root, 'charts/krab/Chart.yaml')
const krabValuesPath = resolve(root, 'charts/krab/values.yaml')
const krabSchemaPath = resolve(root, 'charts/krab/values.schema.json')
const generatedRoot = resolve(root, 'src/generated')
const shouldFetch = process.argv.includes('--fetch')

const sha256 = (content: string) =>
  createHash('sha256').update(content).digest('hex')

const rawUrl = (source: Source) =>
  source.url ??
  `https://raw.githubusercontent.com/${source.repository}/${source.ref}/${source.path}`

const blobUrl = (source: Source) =>
  source.sourceUrl ??
  `https://github.com/${source.repository}/blob/${source.ref}/${source.path}`

const requireValue = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined || value === '') {
    throw new Error(message)
  }
  return value
}

const readYaml = async (path: string) => parse(await readFile(path, 'utf8'))

const firstComment = (content: string) =>
  content
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => line.replace(/^#\s?/, '').trim())
    .find(Boolean) ?? ''

async function main() {
  const lock = (await readYaml(lockPath)) as LockFile
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources)) {
    throw new Error('Unsupported upstream source lock schema')
  }

  const sourceById = new Map(lock.sources.map((source) => [source.id, source]))
  if (sourceById.size !== lock.sources.length) {
    throw new Error('Every upstream source id must be unique')
  }

  for (const source of lock.sources) {
    const cachePath = resolve(cacheRoot, source.cache)
    let content: string | undefined
    if (!shouldFetch) {
      try {
        content = await readFile(cachePath, 'utf8')
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error
        }
      }
    }

    if (shouldFetch || content === undefined) {
      const response = await fetch(rawUrl(source))
      if (!response.ok) {
        throw new Error(`Unable to fetch ${source.id}: HTTP ${response.status}`)
      }
      content = await response.text()
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, content)
    }

    const actualChecksum = sha256(content)
    if (actualChecksum !== source.sha256) {
      throw new Error(
        `${source.id} checksum mismatch: expected ${source.sha256}, got ${actualChecksum}`,
      )
    }
  }

  const source = (id: string) =>
    requireValue(sourceById.get(id), `Missing locked source: ${id}`)
  const cachePath = (id: string) => resolve(cacheRoot, source(id).cache)
  const sourceLink = (id: string) => blobUrl(source(id))

  const kataChart = await readYaml(cachePath('kata-chart'))
  const plannedArchitecture = await readYaml(plannedArchitecturePath)
  const krabChart = await readYaml(krabChartPath)
  const krabValues = await readYaml(krabValuesPath)
  const krabSchema = JSON.parse(await readFile(krabSchemaPath, 'utf8'))
  const kataValuesRaw = await readFile(cachePath('kata-values'), 'utf8')
  const kataValues = parse(kataValuesRaw)
  const kataProfileRaw = await readFile(cachePath('kata-nvidia-profile'), 'utf8')
  const kataProfile = await readYaml(cachePath('kata-nvidia-profile'))
  const provisionerChart = await readYaml(cachePath('provisioner-chart'))
  const devicePluginChart = await readYaml(cachePath('device-plugin-chart'))
  const provisionerReadme = await readFile(cachePath('provisioner-profiles'), 'utf8')
  const pluginCode = await readFile(cachePath('device-plugin-code'), 'utf8')
  const pluginValues = await readYaml(cachePath('device-plugin-values'))
  const nvidiaValues = await readYaml(cachePath('nvidia-operator-values'))
  const nvidiaSupportedPlatforms = await readFile(
    cachePath('nvidia-supported-platforms'),
    'utf8',
  )
  const nvidiaCcModes = await readFile(cachePath('nvidia-cc-modes'), 'utf8')
  const nvidiaWorkloads = await readFile(cachePath('nvidia-workloads'), 'utf8')
  const kataChartReference = requireValue(
    kataProfileRaw.match(/helm install \S+ (oci:\/\/\S+)/)?.[1],
    'Unable to derive the Kata chart OCI reference',
  )
  const provisionerNamespace = requireValue(
    provisionerReadme.match(/--namespace\s+(\S+)/)?.[1],
    'Unable to derive the provisioner namespace',
  )

  requireValue(kataChart.version, 'Kata chart version is missing')
  if (krabChart.name !== 'krab' || krabChart.type !== 'application') {
    throw new Error('charts/krab/Chart.yaml is not a KRAB application chart')
  }
  const krabDependencies = new Map(
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
    krabDependencies.get('node-feature-discovery').condition ||
    krabDependencies.get('kata-deploy').condition
  ) {
    throw new Error('NFD and kata-deploy must be unconditional KRAB dependencies')
  }
  for (const name of ['kata-device-plugin', 'kata-device-provisioner']) {
    const expectedCondition = `${plannedDependencies.nvidiaValuesKey}.enabled`
    if (krabDependencies.get(name).condition !== expectedCondition) {
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
  if (plannedArchitecture.status !== 'planned') {
    throw new Error('Planned architecture must remain explicitly marked as planned')
  }
  requireValue(plannedArchitecture.charts?.krab?.ociReference, 'Missing planned KRAB chart')
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
  const nfdDependency = requireValue(
    kataChart.dependencies?.find(
      (dependency: { name?: string }) =>
        dependency.name === plannedArchitecture.charts.krab.dependencies.nfdValuesKey,
    ),
    'Unable to derive the required NFD dependency from the Kata chart',
  )
  plannedArchitecture.charts.nfd = {
    chartName: nfdDependency.name,
    version: nfdDependency.version,
    repository: nfdDependency.repository,
    valuesKey: plannedArchitecture.charts.krab.dependencies.nfdValuesKey,
    required: plannedArchitecture.charts.krab.dependencies.nfdRequired,
    sourceUrl: sourceLink('kata-chart'),
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
  const supportedGpuModels = [
    ...new Set(
      [...nvidiaSupportedPlatforms.matchAll(/<td><p>NVIDIA ([HB]\d+)/g)].map(
        ([, model]) => model,
      ),
    ),
  ]
  const amdCpuPlatforms = requireValue(
    nvidiaSupportedPlatforms.match(/<td><p>AMD ([^<]+)<\/p><\/td>/)?.[1],
    'Unable to parse NVIDIA-supported AMD CPU platforms',
  )
  const intelCpuPlatforms = requireValue(
    nvidiaSupportedPlatforms.match(/<td><p>Intel ([^<]+)<\/p><\/td>/)?.[1],
    'Unable to parse NVIDIA-supported Intel CPU platforms',
  )
  if (
    !nvidiaCcModes.includes('only supported on NVIDIA Hopper GPUs') ||
    !nvidiaCcModes.includes('Use <code class="docutils literal notranslate"><span class="pre">on</span></code> mode for Blackwell') ||
    !nvidiaWorkloads.includes('kata-qemu-nvidia-gpu-snp') ||
    !nvidiaWorkloads.includes('kata-qemu-nvidia-gpu-tdx')
  ) {
    throw new Error('NVIDIA confidential-container support documentation changed')
  }

  const nvidiaShims = Object.entries(kataProfile.shims)
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

  if (nvidiaShims.length === 0) {
    throw new Error('No enabled NVIDIA Kata shims found')
  }
  const runtimeRsShims = nvidiaShims.filter(({ id }) => id.endsWith('-runtime-rs'))
  const cpuTees = runtimeRsShims.flatMap((shim) => {
    if (shim.id.includes('-snp-')) {
      return [{
        id: 'snp',
        displayName: 'AMD SEV-SNP',
        shimId: shim.id,
        runtimeClass: shim.runtimeClass,
        documentedRuntimeClass: shim.runtimeClass.replace('-runtime-rs', ''),
        supportedCpuPlatforms: amdCpuPlatforms,
        nodeSelector: shim.nodeSelector,
        sourceUrl: shim.sourceUrl,
        supportSourceUrl: sourceLink('nvidia-workloads'),
      }]
    }
    if (shim.id.includes('-tdx-')) {
      return [{
        id: 'tdx',
        displayName: 'Intel TDX',
        shimId: shim.id,
        runtimeClass: shim.runtimeClass,
        documentedRuntimeClass: shim.runtimeClass.replace('-runtime-rs', ''),
        supportedCpuPlatforms: intelCpuPlatforms,
        nodeSelector: shim.nodeSelector,
        sourceUrl: shim.sourceUrl,
        supportSourceUrl: sourceLink('nvidia-workloads'),
      }]
    }
    return []
  })

  if (runtimeRsShims.length !== 3 || cpuTees.length !== 2) {
    throw new Error('Expected base, SNP, and TDX NVIDIA runtime-rs shims')
  }

  const localShims = Object.entries(
    requireValue(kataValues.shims, 'Kata values are missing shims'),
  )
    .filter(([name, config]) =>
      name !== 'disableAll' &&
      !name.includes('nvidia-gpu') &&
      !name.includes('coco-dev') &&
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
            snapshotterConfiguration: {
              erofsSnapshotterMode: 'memory',
              erofsDmverity: true,
              containerdUserDropIn:
                "[plugins.'io.containerd.snapshotter.v1.erofs']\n  enable_fsverity = false\n",
            },
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
    snapshotter: kataValues.snapshotter,
    shims: {
      disableAll: true,
      ...localShimValues,
    },
    defaultShim: kataValues.defaultShim,
    runtimeClasses: kataValues.runtimeClasses,
    'node-feature-discovery': kataValues['node-feature-discovery'],
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

  const profileSources: Record<
    string,
    { sourceId: string; familyId: string }
  > = {
    'HGX-Hx00': { sourceId: 'hopper-passthrough', familyId: 'hopper' },
    'HGX-Hx00-PPCIE': {
      sourceId: 'hopper-confidential',
      familyId: 'hopper',
    },
    'HGX-Bx00': { sourceId: 'blackwell-passthrough', familyId: 'blackwell' },
    'HGX-Bx00-CC': {
      sourceId: 'blackwell-confidential',
      familyId: 'blackwell',
    },
    'PCIE-GPU': {
      sourceId: 'pcie-gpu-passthrough',
      familyId: 'pcie-gpu',
    },
    'PCIE-GPU-CC': {
      sourceId: 'pcie-gpu-confidential',
      familyId: 'pcie-gpu',
    },
    GBx00: {
      sourceId: 'grace-blackwell-passthrough',
      familyId: 'grace-blackwell',
    },
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

  const familyDisplayNames: Record<string, string> = {
    'grace-blackwell': 'NVIDIA GBx00',
    blackwell: 'NVIDIA HGX Bx00',
    hopper: 'NVIDIA HGX Hx00',
    'pcie-gpu': 'NVIDIA PCIe GPUs',
  }

  const families = Object.keys(familyDisplayNames).map((generation) => {
    const profiles = profileRecords.filter((profile) => profile.generation === generation)
    const passthrough = requireValue(
      profiles.find((profile) => profile.ccMode === 'off'),
      `Missing ${generation} passthrough profile`,
    )
    const models = passthrough.nodes.match(/\(([^)]+)\)/)?.[1]
      ?.split(',')
      .map((model) => model.trim()) ?? []

    return {
      id: generation,
      displayName: familyDisplayNames[generation],
      upstreamName: passthrough.nodes.replace(/\s*\([^)]+\)/, ''),
      models,
      nvidiaValidatedModels: models.filter((model) =>
        supportedGpuModels.includes(model),
      ),
      modelsNotInNvidiaMatrix: models.filter(
        (model) => !supportedGpuModels.includes(model),
      ),
      supportSourceUrl: sourceLink('nvidia-supported-platforms'),
      defaultModeId: 'off',
      modes: profiles.map((profile) => ({
        id: String(profile.ccMode),
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
        id: 'local',
        displayName: 'Local',
        logo: 'local.svg',
        capabilities: [
          { id: 'runtime-classes' },
          { id: 'local-hypervisors' },
        ],
        sourceUrl: sourceLink('kata-chart'),
        hardwareFamilies: [],
        runtime: {
          chart: {
            name: kataChart.name,
            version: String(kataChart.version),
            appVersion: String(kataChart.appVersion),
            ociReference: kataChartReference,
            namespace: plannedArchitecture.namespace,
            valuesFileName: 'kata-local.values.yaml',
            values: localRuntimeValues,
            sourceUrl: sourceLink('kata-chart'),
          },
          shims: localShims,
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
        integration: {
          sandboxWorkloads: {},
          defaultCcMode: '',
          sourceUrl: sourceLink('kata-values'),
          officialSupport: {
            documentationVersion: String(kataChart.version),
            supportedGpuModels: [],
            supportedPlatformsUrl: sourceLink('kata-values'),
            ccModesUrl: sourceLink('kata-values'),
            workloadsUrl: sourceLink('kata-values'),
            runtimeRsStatus: 'RuntimeClasses are derived from pinned kata-deploy values.',
          },
        },
      },
      {
        id: 'nvidia',
        displayName: source('nvidia-operator-values').repository.split('/')[0],
        logo: 'nvidia.svg',
        capabilities: [
          { id: 'gpu', resourceName: gpuResource },
          { id: 'nvswitch', resourceName: nvSwitchResource },
          { id: 'confidential-computing', modes: [...new Set(profileRecords.map((p) => p.ccMode))] },
        ],
        sourceUrl:
          'https://docs.nvidia.com/datacenter/cloud-native/confidential-containers/latest/',
        hardwareFamilies: families,
        runtime: {
          chart: {
            name: kataChart.name,
            version: String(kataChart.version),
            appVersion: String(kataChart.appVersion),
            ociReference: kataChartReference,
            namespace: provisionerNamespace,
            valuesFileName: 'kata-nvidia.values.yaml',
            values: kataProfile,
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
        },
        devicePlugin: {
          chart: plannedArchitecture.charts.devicePlugin,
          values: pluginValues,
          sourceUrl: sourceLink('device-plugin-chart'),
        },
        workload: {
          resourceName: gpuResource,
          nvSwitchResourceName: nvSwitchResource,
          resourceNaming: pluginValues.resourceNaming,
          sourceUrl: sourceLink('device-plugin-code'),
        },
        integration: {
          sandboxWorkloads: nvidiaValues.sandboxWorkloads,
          defaultCcMode: nvidiaValues.ccManager?.defaultMode,
          sourceUrl: sourceLink('nvidia-operator-values'),
          officialSupport: {
            documentationVersion: source('nvidia-supported-platforms').ref,
            supportedGpuModels,
            supportedPlatformsUrl: sourceLink('nvidia-supported-platforms'),
            ccModesUrl: sourceLink('nvidia-cc-modes'),
            workloadsUrl: sourceLink('nvidia-workloads'),
            runtimeRsStatus:
              'Kata runtime-rs target; NVIDIA documentation names the corresponding QEMU runtime classes.',
          },
        },
      },
    ],
  }
  const vendorOrder = ['nvidia', 'local']
  catalog.vendors.sort(
    (left, right) =>
      vendorOrder.indexOf(left.id) - vendorOrder.indexOf(right.id),
  )

  const provenance = {
    schemaVersion: 1,
    plannedContract: {
      path: 'upstream/planned-architecture.yaml',
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

  await mkdir(generatedRoot, { recursive: true })
  await writeFile(
    resolve(generatedRoot, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  )
  await writeFile(
    resolve(generatedRoot, 'provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )

  const generationSummary = [
    `${families.length} hardware families`,
    `${runtimeRsShims.length} NVIDIA runtime-rs classes`,
    `${localShims.length} local RuntimeClasses`,
    `${provenance.generatedFrom.length} provenance records`,
  ].join(', ')
  console.log(`Generated ${generationSummary}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
