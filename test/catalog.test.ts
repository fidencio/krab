import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import {
  buildCustomRuntimeClass,
  buildInstallScript,
  buildValuesFileName,
  buildValuesBundle,
  createAdvancedConfiguration,
  customRuntimeSnapshotter,
  type ExplorerCatalog,
  validateCustomRuntimes,
} from '../src/lib/artifacts.ts'

const root = resolve(import.meta.dirname, '..')

const loadJson = async <T>(path: string) =>
  JSON.parse(await readFile(resolve(root, path), 'utf8')) as T

test('generated catalog carries accurate upstream chart data', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const vendor = catalog.vendors.find(({ id }) => id === 'nvidia')!
  const local = catalog.vendors.find(({ id }) => id === 'local')!

  assert.deepEqual(
    catalog.vendors.map(({ id }) => id),
    ['nvidia', 'local', 'amd', 'ibm', 'intel'],
  )
  assert.equal(vendor.displayName, 'NVIDIA')
  assert.equal(local.displayName, 'Local')
  assert.equal(local.hardwareFamilies.length, 0)
  assert.deepEqual(
    local.runtime.shims.map(({ id }) => id),
    [
      'clh-runtime-rs',
      'clh-azure-runtime-rs',
      'dragonball',
      'qemu-runtime-rs',
      'qemu-nvidia-cpu-runtime-rs',
      'qemu-coco-dev-runtime-rs',
      'openvmm-azure-runtime-rs',
    ],
  )
  const nvidiaCpuRuntime = local.runtime.shims.find(
    ({ id }) => id === 'qemu-nvidia-cpu-runtime-rs',
  )!
  assert.equal(nvidiaCpuRuntime.snapshotter, 'erofs')
  assert.deepEqual(nvidiaCpuRuntime.snapshotterConfiguration, {
    erofsSnapshotterMode: 'memory',
    erofsDmverity: true,
    containerdUserDropIn:
      "[plugins.'io.containerd.snapshotter.v1.erofs']\n  enable_fsverity = false\n",
  })
  assert.deepEqual(
    catalog.vendors
      .filter(({ id }) => ['amd', 'ibm', 'intel'].includes(id))
      .map(({ id, runtime }) => ({
        id,
        shimId: runtime.shims[0]?.id,
        arches: runtime.shims[0]?.supportedArches,
        snapshotter: runtime.shims[0]?.snapshotter,
      })),
    [
      {
        id: 'amd',
        shimId: 'qemu-snp-runtime-rs',
        arches: ['amd64'],
        snapshotter: 'nydus',
      },
      {
        id: 'ibm',
        shimId: 'qemu-se-runtime-rs',
        arches: ['s390x'],
        snapshotter: 'nydus',
      },
      {
        id: 'intel',
        shimId: 'qemu-tdx-runtime-rs',
        arches: ['amd64'],
        snapshotter: 'nydus',
      },
    ],
  )
  assert.match(vendor.sourceUrl, /^https:\/\/github\.com\/kata-containers\//)
  assert.equal(vendor.runtime.chart.version, '4.2.0')
  assert.equal(
    vendor.runtime.chart.ociReference,
    'oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy',
  )
  assert.equal(vendor.workload.resourceName, 'nvidia.com/gpu')
  assert.equal(catalog.plannedArchitecture.charts.nfd.required, true)
  assert.equal(catalog.plannedArchitecture.charts.nfd.version, '0.19.0')
  assert.equal(catalog.plannedArchitecture.charts.nfd.appVersion, 'v0.19.0')
  assert.deepEqual(catalog.plannedArchitecture.charts.nfd.image, {
    repository: 'registry.k8s.io/nfd/node-feature-discovery',
    pullPolicy: 'IfNotPresent',
    tag: 'v0.19.0',
  })
  assert.equal(catalog.plannedArchitecture.charts.kataDeploy.version, '4.2.0')
  assert.equal(
    catalog.plannedArchitecture.charts.devicePlugin.version,
    '0.2.0-rc.0',
  )
  assert.equal(
    catalog.plannedArchitecture.charts.provisioner.version,
    '0.1.0-alpha.1',
  )
  assert.equal(
    catalog.plannedArchitecture.charts.krab.version,
    '0.1.0-alpha.3',
  )
  const dependencies = catalog.plannedArchitecture.charts.krab.dependencies
  assert.equal(dependencies.nfdRequired, true)
  assert.equal(dependencies.runtimeRequired, true)
  assert.equal(dependencies.devicePluginRequired, false)
  assert.deepEqual(dependencies.devicePluginRequiredBy, ['nvidia'])
  assert.equal(dependencies.provisionerRequired, false)
  assert.deepEqual(dependencies.provisionerRequiredBy, ['nvidia'])
  assert.deepEqual(
    catalog.plannedArchitecture.cluster.distributions.map(({ id }) => id),
    ['kubeadm', 'k0s', 'k3s', 'microk8s', 'rke2'],
  )
  assert.deepEqual(
    vendor.hardwareFamilies.map(({ id }) => id),
    ['grace-blackwell', 'blackwell', 'hopper', 'pcie-gpu'],
  )
  const graceBlackwell = vendor.hardwareFamilies.find(
    ({ id }) => id === 'grace-blackwell',
  )
  assert.deepEqual(graceBlackwell?.supportedArches, ['arm64'])
  assert.equal(graceBlackwell?.availability, 'pending')
  assert.equal(
    graceBlackwell?.availabilityReason,
    'Kata Containers support pending',
  )
  assert.deepEqual(
    vendor.hardwareFamilies.map(({ modes }) => modes.map(({ id }) => id)),
    [['off'], ['off', 'on'], ['off', 'ppcie'], ['off', 'on']],
  )
  assert.deepEqual(
    vendor.hardwareFamilies.map(({ modes }) =>
      modes.map(({ supportedCpuTeeIds }) => supportedCpuTeeIds),
    ),
    [[[]], [[], ['snp', 'tdx']], [[], ['tdx']], [[], ['snp', 'tdx']]],
  )
  assert.ok(vendor.runtime.shims.every(({ id }) => id.endsWith('-runtime-rs')))
  assert.deepEqual(
    vendor.runtime.cpuTees.map(({ id }) => id),
    ['snp', 'tdx'],
  )
})

test('local artifacts install only the selected upstream RuntimeClasses', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const local = catalog.vendors.find(({ id }) => id === 'local')!
  const defaultAdvanced = createAdvancedConfiguration()
  assert.equal(defaultAdvanced.erofsDiskSize, '256M')
  assert.equal(defaultAdvanced.scheduledReconcileEnabled, false)
  assert.equal(defaultAdvanced.scheduledReconcileSchedule, '*/15 * * * *')
  const generatedValues = parse(
    buildValuesBundle(
      catalog,
      local,
      {},
      { distributionId: 'kubeadm', selinuxEnabled: false },
      {
        selectedShimIds: ['qemu-runtime-rs', 'qemu-nvidia-cpu-runtime-rs'],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: true,
      },
      createAdvancedConfiguration(),
    ),
  )
  const shims = generatedValues['kata-deploy'].shims

  assert.equal(generatedValues.nvidia.enabled, false)
  assert.equal(generatedValues['kata-device-plugin'], undefined)
  assert.equal(generatedValues['kata-device-provisioner'], undefined)
  assert.deepEqual(Object.keys(shims), [
    'disableAll',
    'qemu-runtime-rs',
    'qemu-nvidia-cpu-runtime-rs',
  ])
  assert.equal(shims['qemu-runtime-rs'].enabled, true)
  assert.equal(shims['qemu-runtime-rs'].nvrc, undefined)
  assert.equal(shims['qemu-nvidia-cpu-runtime-rs'].enabled, true)
  assert.deepEqual(generatedValues['kata-deploy'].defaultShim, {
    amd64: 'qemu-runtime-rs',
    arm64: 'qemu-runtime-rs',
    s390x: 'qemu-runtime-rs',
    ppc64le: 'qemu-runtime-rs',
  })
  assert.deepEqual(generatedValues['kata-deploy'].image, {
    reference: 'quay.io/kata-containers/kata-deploy',
    tag: '4.2.0',
  })
  assert.deepEqual(generatedValues['kata-deploy'].kubectlImage, {
    reference: 'quay.io/kata-containers/kubectl',
    tag: 'v1.37.0',
  })
  assert.deepEqual(generatedValues['kata-deploy'].job, {
    dispatcherImage: {
      reference: 'ghcr.io/kata-containers/k8s-job-dispatcher',
      tag: '0.3.0',
    },
  })
  assert.deepEqual(generatedValues['node-feature-discovery'].image, {
    repository: 'registry.k8s.io/nfd/node-feature-discovery',
    pullPolicy: 'IfNotPresent',
    tag: 'v0.19.0',
  })
  assert.doesNotMatch(JSON.stringify(generatedValues), /latest/)
  assert.equal(
    shims['qemu-nvidia-cpu-runtime-rs'].containerd.snapshotter,
    'erofs',
  )
  assert.deepEqual(generatedValues['kata-deploy'].snapshotter, {
    setup: ['erofs'],
    erofsSnapshotterMode: 'memory',
    erofsDmverity: true,
  })
  assert.equal(
    generatedValues['kata-deploy'].containerd.userDropIn,
    "[plugins.'io.containerd.snapshotter.v1.erofs']\n  enable_fsverity = false\n",
  )

  const configuredValues = parse(
    buildValuesBundle(
      catalog,
      local,
      {},
      { distributionId: 'kubeadm', selinuxEnabled: false },
      {
        selectedShimIds: ['qemu-nvidia-cpu-runtime-rs'],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      {
        ...createAdvancedConfiguration(),
        shimDropIns: {
          'qemu-runtime-rs': '',
          'qemu-nvidia-cpu-runtime-rs':
            '[agent.kata]\ndial_timeout = 999\n',
          'unselected-runtime': '[agent.kata]\ndebug_console = true\n',
        },
        containerdUserDropIn:
          '[plugins."io.containerd.grpc.v1.cri"]\n  disable_tcp_service = true\n',
        erofsSnapshotterMode: 'disk',
        erofsDiskSize: '24G',
        erofsDmverity: false,
        erofsEnableFsverity: true,
      },
    ),
  )
  assert.deepEqual(configuredValues['kata-deploy'].snapshotter, {
    setup: ['erofs'],
    erofsSnapshotterMode: 'disk',
    erofsDmverity: false,
  })
  assert.equal(
    configuredValues['kata-deploy'].containerd.userDropIn,
    "[plugins.'io.containerd.snapshotter.v1.erofs']\n" +
      '  enable_fsverity = true\n  default_size = "24G"\n\n' +
      '[plugins."io.containerd.grpc.v1.cri"]\n' +
      '  disable_tcp_service = true\n',
  )
  assert.equal(
    configuredValues['kata-deploy'].shims['qemu-nvidia-cpu-runtime-rs'].dropIn,
    '[agent.kata]\ndial_timeout = 999\n',
  )
  assert.equal(
    configuredValues['kata-deploy'].shims['unselected-runtime'],
    undefined,
  )
  assert.deepEqual(configuredValues['kata-deploy'].defaultShim, {
    amd64: 'qemu-nvidia-cpu-runtime-rs',
    arm64: 'qemu-nvidia-cpu-runtime-rs',
  })

  const cocoDevValues = parse(
    buildValuesBundle(
      catalog,
      local,
      {},
      { distributionId: 'kubeadm', selinuxEnabled: false },
      {
        selectedShimIds: ['qemu-coco-dev-runtime-rs'],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      {
        ...createAdvancedConfiguration(),
        containerdUserDropIn: '[debug]\n  level = "debug"\n',
      },
    ),
  )
  assert.deepEqual(Object.keys(cocoDevValues['kata-deploy'].shims), [
    'disableAll',
    'qemu-coco-dev-runtime-rs',
  ])
  assert.deepEqual(cocoDevValues['kata-deploy'].snapshotter, {
    setup: ['nydus'],
  })
  assert.deepEqual(cocoDevValues['kata-deploy'].defaultShim, {
    amd64: 'qemu-coco-dev-runtime-rs',
    arm64: 'qemu-coco-dev-runtime-rs',
    s390x: 'qemu-coco-dev-runtime-rs',
  })
  assert.equal(
    cocoDevValues['kata-deploy'].containerd.userDropIn,
    '[debug]\n  level = "debug"\n',
  )
})

test('NVIDIA artifacts pin every component image version', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const vendor = catalog.vendors.find(({ id }) => id === 'nvidia')!
  const generatedValues = parse(
    buildValuesBundle(
      catalog,
      vendor,
      {
        hopper: { modeId: 'off', cpuTeeIds: [] },
      },
      { distributionId: 'kubeadm', selinuxEnabled: false },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      createAdvancedConfiguration(),
    ),
  )

  assert.deepEqual(generatedValues['kata-device-plugin'].image, {
    repository: 'ghcr.io/kata-containers/kata-device-plugin',
    tag: 'v0.2.0-rc.0',
    pullPolicy: 'IfNotPresent',
  })
  assert.deepEqual(generatedValues['kata-device-provisioner'].image, {
    reference: 'ghcr.io/kata-containers/kata-device-provisioner',
    tag: '0.1.0-alpha.1',
  })
  assert.deepEqual(
    generatedValues['kata-device-provisioner'].job.dispatcherImage,
    {
      reference: 'ghcr.io/kata-containers/k8s-job-dispatcher',
      tag: '0.4.0',
    },
  )
  assert.doesNotMatch(JSON.stringify(generatedValues), /latest/)
  assert.deepEqual(generatedValues['kata-deploy'].defaultShim, {
    amd64: 'qemu-nvidia-gpu-runtime-rs',
  })

  const tdxValues = parse(
    buildValuesBundle(
      catalog,
      vendor,
      {
        hopper: { modeId: 'ppcie', cpuTeeIds: ['tdx'] },
      },
      { distributionId: 'kubeadm', selinuxEnabled: false },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      createAdvancedConfiguration(),
    ),
  )
  assert.deepEqual(tdxValues['kata-deploy'].shims, {
    disableAll: true,
    'qemu-nvidia-gpu-tdx-runtime-rs': {
      ...vendor.runtime.chart.values.shims[
        'qemu-nvidia-gpu-tdx-runtime-rs'
      ],
      enabled: true,
      agent: { httpsProxy: '', noProxy: '' },
      nvrc: { enableDCGM: false },
    },
  })
  assert.deepEqual(tdxValues['kata-deploy'].defaultShim, {
    amd64: 'qemu-nvidia-gpu-tdx-runtime-rs',
  })
})

test('custom runtimes generate independent RuntimeClasses and snapshotters', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const local = catalog.vendors.find(({ id }) => id === 'local')!
  const runtimeClass = buildCustomRuntimeClass('my-runtime')
  const customRuntime = {
    name: 'my-runtime',
    baseConfig: 'qemu-nvidia-cpu-runtime-rs',
    dropIn: '[hypervisor.qemu]\ndefault_memory = 1024\n',
    runtimeClass,
  }

  assert.deepEqual(validateCustomRuntimes(local, [customRuntime]), [])
  assert.equal(customRuntimeSnapshotter(local, customRuntime), 'erofs')
  assert.equal(
    customRuntimeSnapshotter(local, {
      ...customRuntime,
      baseConfig: 'qemu-runtime-rs',
    }),
    '',
  )
  assert.deepEqual(
    validateCustomRuntimes(local, [
      { ...customRuntime, runtimeClass: 'passed through as-is' },
    ]),
    [],
  )

  const generated = parse(
    buildValuesBundle(
      catalog,
      local,
      {},
      { distributionId: 'kubeadm', selinuxEnabled: false },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      {
        ...createAdvancedConfiguration(),
        customRuntimes: [customRuntime],
      },
    ),
  )

  assert.deepEqual(generated['kata-deploy'].shims, { disableAll: true })
  assert.equal(generated['kata-deploy'].defaultShim, undefined)
  assert.deepEqual(generated['kata-deploy'].customRuntimes, {
    enabled: true,
    runtimes: {
      'my-runtime': {
        baseConfig: 'qemu-nvidia-cpu-runtime-rs',
        dropIn: '[hypervisor.qemu]\ndefault_memory = 1024\n',
        runtimeClass,
        containerd: { snapshotter: 'erofs' },
      },
    },
  })
  assert.deepEqual(generated['kata-deploy'].snapshotter, {
    setup: ['erofs'],
    erofsSnapshotterMode: 'memory',
    erofsDmverity: true,
  })
  assert.equal(
    generated['kata-deploy'].containerd.userDropIn,
    "[plugins.'io.containerd.snapshotter.v1.erofs']\n" +
      '  enable_fsverity = false\n',
  )

  const validationErrors = validateCustomRuntimes(local, [
    customRuntime,
    {
      ...customRuntime,
      baseConfig: 'missing-runtime',
    },
  ])
  assert.ok(validationErrors.some(({ field }) => field === 'name'))
  assert.ok(validationErrors.some(({ field }) => field === 'baseConfig'))
})

test('artifacts wrap upstream profiles in the KRAB parent chart', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const vendor = catalog.vendors.find(({ id }) => id === 'nvidia')!
  const selections = {
    'grace-blackwell': { modeId: 'off', cpuTeeIds: [] },
    hopper: { modeId: 'ppcie', cpuTeeIds: ['snp', 'tdx'] },
    blackwell: { modeId: 'on', cpuTeeIds: ['tdx'] },
  }
  const values = buildValuesBundle(catalog, vendor, selections, {
    distributionId: 'rke2',
    selinuxEnabled: true,
  }, {
    selectedShimIds: [],
    runtimeHttpsProxy: ' https://proxy.example.com:8443 ',
    runtimeNoProxy: ' registry.internal,.svc ',
    nvidiaDcgmEnabled: true,
  }, {
    ...createAdvancedConfiguration(),
    installErofsUtils: true,
    nodeSelector: [{ key: ' workload.example.com/kata ', value: ' true ' }],
    nodeAffinity: [
      {
        key: ' topology.kubernetes.io/zone ',
        operator: 'In',
        values: [' zone-a ', ' zone-b '],
      },
    ],
    tolerations: [
      {
        key: ' kata.example.com/runtime ',
        operator: 'Equal',
        value: ' enabled ',
        effect: 'NoSchedule',
      },
    ],
    scheduledReconcileEnabled: true,
    scheduledReconcileSchedule: ' 0 */2 * * * ',
    images: {
      kataDeploy: {
        ...createAdvancedConfiguration().images.kataDeploy,
        pullPolicy: 'IfNotPresent',
        pullSecrets: [' registry-secret '],
        reference: 'registry.example.com/kata-deploy',
        tag: '4.2.0',
        kubectlReference: 'registry.example.com/kubectl',
        dispatcherReference: 'registry.example.com/dispatcher',
      },
      nfd: {
        ...createAdvancedConfiguration().images.nfd,
        pullPolicy: 'IfNotPresent',
        pullSecrets: [' nfd-secret '],
        reference: 'registry.example.com/node-feature-discovery',
        tag: '0.19.0',
      },
      devicePlugin: {
        ...createAdvancedConfiguration().images.devicePlugin,
        pullPolicy: 'Always',
        pullSecrets: [' plugin-secret '],
        reference: 'registry.example.com/kata-device-plugin',
        tag: '0.1.0',
      },
      provisioner: {
        ...createAdvancedConfiguration().images.provisioner,
        pullPolicy: 'IfNotPresent',
        pullSecrets: [' provisioner-secret '],
        reference: 'registry.example.com/kata-device-provisioner',
        tag: '0.1.0',
        dispatcherReference: 'registry.example.com/provisioner-dispatcher',
      },
    },
    debug: true,
  })
  const install = buildInstallScript(catalog)
  const generatedValues = parse(values)
  const shims = generatedValues['kata-deploy'].shims

  assert.doesNotMatch(values, /qemu-nvidia-gpu-snp-runtime-rs:/)
  assert.doesNotMatch(values, /qemuNvidiaGpu/)
  assert.doesNotMatch(values, /gpuCount/)
  assert.match(values, /node-feature-discovery:/)
  assert.match(values, /nvidia:\n  enabled: true/)
  assert.match(values, /kata-deploy:/)
  assert.match(values, /kata-device-plugin:/)
  assert.match(values, /kata-device-provisioner:/)
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Bx00-CC-TDX']
      .ccMode,
    'on',
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'],
    undefined,
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles.GBx00,
    undefined,
  )
  assert.ok(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'],
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX']
      .nodeSelector['intel.feature.node.kubernetes.io/tdx'],
    'true',
  )
  assert.equal(shims['qemu-nvidia-gpu'], undefined)
  assert.equal(shims['qemu-nvidia-gpu-runtime-rs'], undefined)
  assert.equal(shims['qemu-nvidia-gpu-snp-runtime-rs'], undefined)
  assert.equal(shims['qemu-nvidia-gpu-tdx-runtime-rs'].enabled, true)
  assert.equal(
    shims['qemu-nvidia-gpu-tdx-runtime-rs'].nvrc.enableDCGM,
    true,
  )
  assert.deepEqual(shims['qemu-nvidia-gpu-tdx-runtime-rs'].agent, {
    httpsProxy: 'https://proxy.example.com:8443',
    noProxy: 'registry.internal,.svc',
  })
  assert.equal(generatedValues['kata-deploy'].k8sDistribution, 'rke2')
  assert.equal(generatedValues['kata-deploy'].selinux.enabled, true)
  assert.equal(generatedValues['kata-deploy'].deploymentMode, 'job')
  assert.equal(generatedValues['kata-deploy'].debug, true)
  assert.deepEqual(generatedValues['kata-deploy'].nodeSelector, {
    'workload.example.com/kata': 'true',
  })
  assert.deepEqual(
    generatedValues['kata-deploy'].affinity.nodeAffinity
      .requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms,
    [
      {
        matchExpressions: [
          {
            key: 'topology.kubernetes.io/zone',
            operator: 'In',
            values: ['zone-a', 'zone-b'],
          },
        ],
      },
    ],
  )
  assert.deepEqual(generatedValues['kata-deploy'].tolerations, [
    {
      key: 'kata.example.com/runtime',
      operator: 'Equal',
      value: 'enabled',
      effect: 'NoSchedule',
    },
  ])
  assert.equal(generatedValues['kata-deploy'].imagePullPolicy, 'IfNotPresent')
  assert.deepEqual(generatedValues['kata-deploy'].imagePullSecrets, [
    { name: 'registry-secret' },
  ])
  assert.equal(
    generatedValues['kata-deploy'].image.reference,
    'registry.example.com/kata-deploy',
  )
  assert.equal(
    generatedValues['kata-deploy'].kubectlImage.reference,
    'registry.example.com/kubectl',
  )
  assert.equal(
    generatedValues['kata-deploy'].job.dispatcherImage.reference,
    'registry.example.com/dispatcher',
  )
  assert.deepEqual(generatedValues['kata-deploy'].job.reconcile, {
    enabled: true,
    schedule: '0 */2 * * *',
  })
  assert.deepEqual(generatedValues['node-feature-discovery'].imagePullSecrets, [
    { name: 'nfd-secret' },
  ])
  assert.equal(
    generatedValues['node-feature-discovery'].image.repository,
    'registry.example.com/node-feature-discovery',
  )
  assert.equal(
    generatedValues['kata-device-plugin'].image.repository,
    'registry.example.com/kata-device-plugin',
  )
  assert.equal(
    generatedValues['kata-device-plugin'].image.pullPolicy,
    'Always',
  )
  assert.deepEqual(generatedValues['kata-device-plugin'].imagePullSecrets, [
    { name: 'plugin-secret' },
  ])
  assert.deepEqual(
    generatedValues['kata-device-provisioner'].imagePullSecrets,
    [{ name: 'provisioner-secret' }],
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].image.reference,
    'registry.example.com/kata-device-provisioner',
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].job.dispatcherImage.reference,
    'registry.example.com/provisioner-dispatcher',
  )
  assert.deepEqual(generatedValues['kata-deploy'].snapshotter.setup, ['nydus'])
  assert.equal(generatedValues['kata-deploy'].nodeBinaries, undefined)
  assert.equal(
    generatedValues['kata-deploy'].snapshotter.erofsSnapshotterMode,
    undefined,
  )
  assert.equal(generatedValues['kata-deploy'].containerd?.userDropIn, undefined)
  assert.equal(
    install,
    'helm upgrade --install krab oci://ghcr.io/fidencio/krab --version 0.1.0-alpha.3 --namespace kata-system --create-namespace --values krab-0.1.0-alpha.3-values.yaml',
  )
  assert.equal(
    buildInstallScript(catalog, 'My production/Kata'),
    'helm upgrade --install my-production-kata oci://ghcr.io/fidencio/krab --version 0.1.0-alpha.3 --namespace kata-system --create-namespace --values my-production-kata-0.1.0-alpha.3-values.yaml',
  )
  assert.equal(
    buildValuesFileName(catalog, ''),
    'krab-0.1.0-alpha.3-values.yaml',
  )

  const passthroughValues = parse(
    buildValuesBundle(
      catalog,
      vendor,
      {
        hopper: { modeId: 'off', cpuTeeIds: [] },
        blackwell: { modeId: null, cpuTeeIds: [] },
      },
      {
        distributionId: 'kubeadm',
        selinuxEnabled: false,
      },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      {
        ...createAdvancedConfiguration(),
        containerdConfigDir: ' /opt/containerd ',
        containerdRuntimeSocket: ' unix:///run/custom-containerd.sock ',
        containerdConfigFileName: ' custom.toml ',
        installErofsUtils: true,
        erofsUtilsImage: ' registry.example.com/erofs-utils:1.9.3 ',
      },
    ),
  )
  assert.deepEqual(passthroughValues['kata-deploy'].snapshotter.setup, ['erofs'])
  assert.ok(passthroughValues['kata-deploy'].containerd)
  assert.equal(
    passthroughValues['kata-deploy'].containerd.configDir,
    '/opt/containerd',
  )
  assert.equal(
    passthroughValues['kata-deploy'].containerd.runtimeSocket,
    'unix:///run/custom-containerd.sock',
  )
  assert.equal(
    passthroughValues['kata-deploy'].containerd.configFileName,
    'custom.toml',
  )
  assert.deepEqual(
    passthroughValues['kata-deploy'].nodeBinaries['erofs-utils'],
    {
      image: 'registry.example.com/erofs-utils:1.9.3',
      binaries: ['mkfs.erofs'],
      pullPolicy: 'IfNotPresent',
    },
  )
  assert.equal(passthroughValues['kata-deploy'].k8sDistribution, 'k8s')

  const emptyValues = parse(
    buildValuesBundle(
      catalog,
      vendor,
      {
        hopper: { modeId: null, cpuTeeIds: [] },
        blackwell: { modeId: null, cpuTeeIds: [] },
      },
      {
        distributionId: 'k3s',
        selinuxEnabled: false,
      },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      {
        ...createAdvancedConfiguration(),
        containerdUserDropIn: '[debug]\n  level = "debug"\n',
      },
    ),
  )
  assert.equal(emptyValues['kata-deploy'].snapshotter, undefined)
  assert.equal(emptyValues['kata-deploy'].containerd, undefined)
  assert.equal(emptyValues['kata-deploy'].k8sDistribution, 'k3s')

  const nonNvidiaValues = parse(
    buildValuesBundle(
      catalog,
      { ...vendor, id: 'other-vendor' },
      {},
      {
        distributionId: 'kubeadm',
        selinuxEnabled: false,
      },
      {
        selectedShimIds: [],
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      createAdvancedConfiguration(),
    ),
  )
  assert.ok(nonNvidiaValues['node-feature-discovery'])
  assert.ok(nonNvidiaValues['kata-deploy'])
  assert.equal(nonNvidiaValues['kata-device-plugin'], undefined)
  assert.equal(nonNvidiaValues['kata-device-provisioner'], undefined)
})

test('App contains no product catalog constants', async () => {
  const app = await readFile(resolve(root, 'src/App.tsx'), 'utf8')

  for (const forbidden of [
    'H100',
    'H200',
    'B200',
    'B300',
    'ppcie',
    'nvidia.com/gpu',
    'qemu-nvidia',
    'kata-deploy-charts',
  ]) {
    assert.equal(app.includes(forbidden), false, `App.tsx contains ${forbidden}`)
  }
})

test('every generated item retains pinned provenance', async () => {
  const provenance = await loadJson<{
    generatedFrom: Array<{ ref: string; sha256: string; sourceUrl: string }>
  }>('src/generated/provenance.json')

  assert.ok(provenance.generatedFrom.length > 0)
  for (const source of provenance.generatedFrom) {
    assert.match(source.ref, /^(?:[a-f0-9]{40}|v?\d+\.\d+\.\d+)$/)
    assert.match(source.sha256, /^[a-f0-9]{64}$/)
    assert.match(source.sourceUrl, /^https:\/\/github\.com\//)
  }
})
