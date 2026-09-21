import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import {
  buildInstallScript,
  buildValuesBundle,
  createAdvancedConfiguration,
  type ExplorerCatalog,
} from '../src/lib/artifacts.ts'

const root = resolve(import.meta.dirname, '..')

const loadJson = async <T>(path: string) =>
  JSON.parse(await readFile(resolve(root, path), 'utf8')) as T

test('generated catalog carries accurate upstream chart data', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const vendor = catalog.vendors[0]

  assert.equal(vendor.displayName, 'NVIDIA')
  assert.equal(
    vendor.sourceUrl,
    'https://docs.nvidia.com/datacenter/cloud-native/confidential-containers/latest/',
  )
  assert.equal(vendor.runtime.chart.version, '4.2.0')
  assert.equal(
    vendor.runtime.chart.ociReference,
    'oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy',
  )
  assert.equal(vendor.workload.resourceName, 'nvidia.com/gpu')
  assert.equal(catalog.plannedArchitecture.charts.nfd.required, true)
  assert.equal(catalog.plannedArchitecture.charts.nfd.version, '0.19.0')
  assert.equal(catalog.plannedArchitecture.charts.kataDeploy.version, '4.2.0')
  assert.equal(catalog.plannedArchitecture.charts.devicePlugin.version, '0.1.0')
  assert.equal(catalog.plannedArchitecture.charts.provisioner.version, '0.1.0')
  assert.equal(catalog.plannedArchitecture.charts.krab.version, '0.1.0')
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
  assert.deepEqual(
    vendor.hardwareFamilies.map(({ modes }) => modes.map(({ id }) => id)),
    [['off'], ['off', 'on'], ['off', 'ppcie'], ['off', 'on']],
  )
  assert.ok(vendor.runtime.shims.every(({ id }) => id.endsWith('-runtime-rs')))
  assert.deepEqual(
    vendor.runtime.cpuTees.map(({ id }) => id),
    ['snp', 'tdx'],
  )
  assert.deepEqual(
    vendor.integration.officialSupport.supportedGpuModels,
    ['H100', 'H200', 'B200'],
  )
  const hopper = vendor.hardwareFamilies.find(({ id }) => id === 'hopper')
  assert.deepEqual(hopper?.nvidiaValidatedModels, ['H100', 'H200'])
  assert.deepEqual(hopper?.modelsNotInNvidiaMatrix, ['H800', 'H20'])
})

test('artifacts wrap upstream profiles in the planned KRAB parent chart', async () => {
  const catalog = await loadJson<ExplorerCatalog>('src/generated/catalog.json')
  const vendor = catalog.vendors[0]
  const selections = {
    hopper: { modeId: 'ppcie', cpuTeeIds: ['snp', 'tdx'] },
    blackwell: { modeId: 'on', cpuTeeIds: ['tdx'] },
  }
  const values = buildValuesBundle(catalog, vendor, selections, {
    distributionId: 'rke2',
    selinuxEnabled: true,
  }, {
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

  assert.match(values, /qemu-nvidia-gpu-snp-runtime-rs:/)
  assert.doesNotMatch(values, /qemuNvidiaGpu/)
  assert.doesNotMatch(values, /gpuCount/)
  assert.match(values, /node-feature-discovery:/)
  assert.match(values, /nvidia:\n  enabled: true/)
  assert.match(values, /kata-deploy:/)
  assert.match(values, /kata-device-plugin:/)
  assert.match(values, /kata-device-provisioner:/)
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP']
      .ccMode,
    'ppcie',
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Bx00-CC-TDX']
      .ccMode,
    'on',
  )
  assert.ok(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP'],
  )
  assert.ok(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX'],
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-SNP']
      .nodeSelector['amd.feature.node.kubernetes.io/snp'],
    'true',
  )
  assert.equal(
    generatedValues['kata-device-provisioner'].profiles['HGX-Hx00-PPCIE-TDX']
      .nodeSelector['intel.feature.node.kubernetes.io/tdx'],
    'true',
  )
  assert.equal(shims['qemu-nvidia-gpu'], undefined)
  assert.equal(shims['qemu-nvidia-gpu-runtime-rs'], undefined)
  assert.equal(shims['qemu-nvidia-gpu-snp-runtime-rs'].enabled, true)
  assert.equal(shims['qemu-nvidia-gpu-tdx-runtime-rs'].enabled, true)
  assert.equal(
    shims['qemu-nvidia-gpu-snp-runtime-rs'].nvrc.enableDCGM,
    true,
  )
  assert.equal(
    shims['qemu-nvidia-gpu-tdx-runtime-rs'].nvrc.enableDCGM,
    true,
  )
  assert.deepEqual(shims['qemu-nvidia-gpu-snp-runtime-rs'].agent, {
    httpsProxy: 'https://proxy.example.com:8443',
    noProxy: 'registry.internal,.svc',
  })
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
    'helm upgrade --install krab oci://ghcr.io/fidencio/krab --namespace kata-system --create-namespace --values values.yaml',
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
        runtimeHttpsProxy: '',
        runtimeNoProxy: '',
        nvidiaDcgmEnabled: false,
      },
      createAdvancedConfiguration(),
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
    assert.match(source.ref, /^(?:[a-f0-9]{40}|\d+\.\d+\.\d+)$/)
    assert.match(source.sha256, /^[a-f0-9]{64}$/)
    assert.match(source.sourceUrl, /^https:\/\/(?:github\.com|docs\.nvidia\.com)\//)
  }
})
