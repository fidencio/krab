import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { parse } from 'yaml'
import { syncChartDependencies } from './sync-chart-dependencies.ts'
import { syncChartImages } from './sync-chart-images.ts'
import { resolveImageLock, syncPrecheck } from './sync-precheck.ts'
import { syncReleaseVersion } from './sync-release-version.ts'
import { inspectErofsImage, validateErofsImageLock, type ErofsImageLock } from './erofs-image.ts'

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
const architecturePath = resolve(root, 'upstream/architecture.yaml')
const krabChartPath = resolve(root, 'charts/krab/Chart.yaml')
const krabValuesPath = resolve(root, 'charts/krab/values.yaml')
const krabSchemaPath = resolve(root, 'charts/krab/values.schema.json')
const precheckImageLockPath = resolve(root, 'upstream/precheck-image.lock.json')
const erofsImageLockPath = resolve(root, 'upstream/erofs-utils-image.lock.json')
const precheckDockerfilePath = resolve(root, 'Dockerfile.precheck')
const precheckValuesPath = resolve(root, 'charts/precheck/values.yaml')
const generatedRoot = resolve(root, 'src/generated')
const shouldFetch = process.argv.includes('--fetch')
const chartRepositories = {
  nfd: 'oci://registry.k8s.io/nfd/charts',
  devicePlugin: 'oci://ghcr.io/kata-containers/kata-device-plugin-charts',
  provisioner: 'oci://ghcr.io/kata-containers/kata-device-provisioner-charts',
}

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

const readYaml = async (path: string) => parse(await readFile(path, 'utf8'))

const firstComment = (content: string) =>
  content
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => line.replace(/^#\s?/, '').trim())
    .find(Boolean) ?? ''

async function main() {
  const erofsImageLock = JSON.parse(await readFile(erofsImageLockPath, 'utf8')) as ErofsImageLock
  validateErofsImageLock(erofsImageLock)
  if (shouldFetch) {
    const published = await inspectErofsImage(erofsImageLock.reference, erofsImageLock.tag)
    if (published.digest !== erofsImageLock.digest ||
        JSON.stringify(published.platforms) !== JSON.stringify(erofsImageLock.platforms)) {
      throw new Error('Published EROFS utility image differs from the pinned lock')
    }
  }
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

  const release = await syncReleaseVersion(root)

  const source = (id: string) =>
    requireValue(sourceById.get(id), `Missing locked source: ${id}`)
  const cachePath = (id: string) => resolve(cacheRoot, source(id).cache)
  const sourceLink = (id: string) => blobUrl(source(id))

  const kataChart = await readYaml(cachePath('kata-chart'))
  const kataVersions = await readYaml(cachePath('kata-versions'))
  const nfdChart = await readYaml(cachePath('nfd-chart'))
  const nfdValues = await readYaml(cachePath('nfd-values'))
  const plannedArchitecture = await readYaml(architecturePath)
  const krabChart = await readYaml(krabChartPath)
  const krabValues = await readYaml(krabValuesPath)
  const krabSchema = JSON.parse(await readFile(krabSchemaPath, 'utf8'))
  const kataValuesRaw = await readFile(cachePath('kata-values'), 'utf8')
  const kataValues = parse(kataValuesRaw)
  const kataProfileRaw = await readFile(cachePath('kata-nvidia-profile'), 'utf8')
  const kataProfile = await readYaml(cachePath('kata-nvidia-profile'))
  const provisionerChart = await readYaml(cachePath('provisioner-chart'))
  const provisionerValues = parse(
    await readFile(cachePath('provisioner-values'), 'utf8'),
    { uniqueKeys: false },
  )
  const devicePluginChart = await readYaml(cachePath('device-plugin-chart'))
  const provisionerReadme = await readFile(cachePath('provisioner-profiles'), 'utf8')
  const pluginCode = await readFile(cachePath('device-plugin-code'), 'utf8')
  const pluginValues = await readYaml(cachePath('device-plugin-values'))
  const kataChartReference = requireValue(
    kataProfileRaw.match(/helm install \S+ (oci:\/\/\S+)/)?.[1],
    'Unable to derive the Kata chart OCI reference',
  )
  const provisionerNamespace = requireValue(
    provisionerReadme.match(/--namespace\s+(\S+)/)?.[1],
    'Unable to derive the provisioner namespace',
  )

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
    : JSON.parse(await readFile(precheckImageLockPath, 'utf8'))
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

  const teeVendorDefinitions = [
    {
      id: 'amd',
      displayName: 'AMD',
      tagline: 'SEV-SNP',
      description: 'Run AMD SEV-SNP confidential workloads with Kata.',
      logo: 'amd.svg',
      shimId: 'qemu-snp-runtime-rs',
    },
    {
      id: 'ibm',
      displayName: 'IBM',
      tagline: 'Secure Execution for Linux',
      description:
        'Run IBM Z Secure Execution confidential workloads with Kata.',
      logo: 'ibm.png',
      shimId: 'qemu-se-runtime-rs',
    },
    {
      id: 'intel',
      displayName: 'Intel',
      tagline: 'TDX',
      description: 'Run Intel TDX confidential workloads with Kata.',
      logo: 'intel.png',
      shimId: 'qemu-tdx-runtime-rs',
    },
  ]
  const teeVendors = teeVendorDefinitions.map((definition) => {
    const config = requireValue(
      kataValues.shims[definition.shimId],
      `Kata values are missing ${definition.shimId}`,
    )
    const shim = {
      id: definition.shimId,
      runtimeClass: `kata-${definition.shimId}`,
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
      id: definition.id,
      displayName: definition.displayName,
      tagline: definition.tagline,
      description: definition.description,
      logo: definition.logo,
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
          valuesFileName: `kata-${definition.id}.values.yaml`,
          values: {
            ...localRuntimeValues,
            shims: {
              disableAll: true,
              [definition.shimId]: config,
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

  const customTeeNodeSelectors: Record<string, Record<string, string>> = {
    'qemu-snp-runtime-rs': { 'amd.feature.node.kubernetes.io/snp': 'true' },
    'qemu-tdx-runtime-rs': { 'intel.feature.node.kubernetes.io/tdx': 'true' },
    'qemu-se-runtime-rs': { 'feature.node.kubernetes.io/cpu-security.se.enabled': 'true' },
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

  const familyDefinitions = {
    'grace-blackwell': {
      displayName: 'NVIDIA GBx00',
      supportedArches: ['arm64'],
      availability: 'pending',
      availabilityReason: 'Kata Containers support pending',
    },
    blackwell: {
      displayName: 'NVIDIA HGX Bx00',
      supportedArches: ['amd64'],
      availability: 'available',
      availabilityReason: null,
    },
    hopper: {
      displayName: 'NVIDIA HGX Hx00',
      supportedArches: ['amd64'],
      availability: 'available',
      availabilityReason: null,
    },
    'pcie-gpu': {
      displayName: 'NVIDIA PCIe GPUs',
      supportedArches: ['amd64'],
      availability: 'available',
      availabilityReason: null,
    },
  }

  const families = Object.entries(familyDefinitions).map(([generation, definition]) => {
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
      displayName: definition.displayName,
      upstreamName: passthrough.nodes.replace(/\s*\([^)]+\)/, ''),
      models,
      supportedArches: definition.supportedArches,
      availability: definition.availability,
      availabilityReason: definition.availabilityReason,
      defaultModeId: 'off',
      modes: profiles.map((profile) => ({
        id: String(profile.ccMode),
        supportedCpuTeeIds:
          profile.ccMode === 'off'
            ? []
            : profile.ccMode === 'ppcie'
              ? ['tdx']
              : cpuTees.map(({ id }) => id),
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
        displayName: 'Custom',
        tagline: 'Custom Kata deployment',
        description:
          'Combine Kata runtimes for different node types in one deployment.',
        logo: 'custom.svg',
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
        displayName: 'NVIDIA',
        tagline: 'GPU and confidential computing',
        description:
          'Run GPU-accelerated workloads with Kata, from standard workloads to confidential ones.',
        logo: 'nvidia.svg',
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
  const vendorOrder = ['nvidia', 'custom', 'amd', 'ibm', 'intel']
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

  await writeFile(krabChartPath, updatedChart)
  await writeFile(krabValuesPath, updatedValues)
  await writeFile(precheckDockerfilePath, updatedPrecheck.dockerfile)
  await writeFile(precheckValuesPath, updatedPrecheck.values)
  if (shouldFetch) {
    await writeFile(precheckImageLockPath, `${JSON.stringify(precheckImageLock, null, 2)}\n`)
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
