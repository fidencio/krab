import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  ExternalLink,
  FileCode2,
  Plus,
  Trash2,
} from 'lucide-react'
import catalogData from './generated/catalog.json'
import provenanceData from './generated/provenance.json'
import {
  buildInstallScript,
  buildValuesBundle,
  createAdvancedConfiguration,
  resolveRuntimeShimIds,
  type AdvancedConfiguration,
  type ChartImageConfiguration,
  type ClusterConfiguration,
  type ExplorerCatalog,
  type FamilySelections,
  type RuntimeConfiguration,
  type VendorCatalog,
} from './lib/artifacts'
import './App.css'

const catalog = catalogData as unknown as ExplorerCatalog
const brandLogos = import.meta.glob('./assets/brands/*.{svg,png}', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>

const logoFor = (vendor: { logo: string }) =>
  brandLogos[`./assets/brands/${vendor.logo}`]

const isRuntimeOnlyVendor = (vendor: VendorCatalog) =>
  vendor.hardwareFamilies.length === 0

const initialSelections = (vendor: VendorCatalog): FamilySelections =>
  Object.fromEntries(
    vendor.hardwareFamilies.map((family) => [
      family.id,
      { modeId: null, cpuTeeIds: [] },
    ]),
  )

const humanize = (value: string) =>
  value
    .replaceAll('`', '')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())

const runtimeTokenNames: Record<string, string> = {
  qemu: 'QEMU',
  clh: 'Cloud Hypervisor',
  openvmm: 'OpenVMM',
  nvidia: 'NVIDIA',
  gpu: 'GPU',
  cpu: 'CPU',
  coco: 'CoCo',
  dev: 'Dev',
  snp: 'SNP',
  tdx: 'TDX',
  se: 'Secure Execution',
}

const runtimeName = (id: string) =>
  id
    .replace(/-runtime-rs$/, '')
    .split('-')
    .map(
      (token) =>
        runtimeTokenNames[token] ??
        token.replace(/^\w/, (character) => character.toUpperCase()),
    )
    .join(' · ')

const runtimeUse = (id: string) => {
  const traits = new Set(id.replace(/-runtime-rs$/, '').split('-'))

  if (traits.has('coco') && traits.has('dev')) {
    return 'Development-only CoCo testing without a hardware TEE.'
  }
  if (traits.has('snp')) return 'Confidential workloads protected by AMD SEV-SNP.'
  if (traits.has('tdx')) return 'Confidential workloads protected by Intel TDX.'
  if (traits.has('se')) return 'IBM Z Secure Execution workloads.'
  if (traits.has('openvmm')) return 'Azure environments built around OpenVMM.'
  if (traits.has('dragonball')) {
    return 'An all-in-one shim and VMM for a smaller stack and fast startup.'
  }
  if (traits.has('nvidia') && traits.has('cpu')) {
    return 'A minimal, hardened QEMU and runtime stack.'
  }
  if (traits.has('azure')) return 'The Azure-tuned Cloud Hypervisor runtime.'
  if (traits.has('clh')) return 'A lightweight, modern alternative to QEMU.'
  return 'The broadly compatible default for general Kata workloads.'
}

const profileSummary = (
  vendor: VendorCatalog,
  selection: FamilySelections[string] | undefined,
) => {
  if (!selection?.modeId) return 'NOT PRESENT'
  if (selection.modeId === 'off') return 'PASSTHROUGH'
  const mode = selection.modeId === 'on' ? 'CC' : selection.modeId.toUpperCase()
  const tees = vendor.runtime.cpuTees
    .filter(({ id }) => selection.cpuTeeIds.includes(id))
    .map(({ displayName }) => displayName)
  return `${mode} · ${tees.length > 0 ? tees.join(' + ') : 'SELECT CPU'}`
}

const needsCpuSelection = (
  selection: FamilySelections[string] | undefined,
) =>
  Boolean(
    selection?.modeId &&
      selection.modeId !== 'off' &&
      selection.cpuTeeIds.length === 0,
  )

const imageChartOptions = [
  { id: 'kataDeploy', label: 'Kata deploy', pullSecrets: true },
  { id: 'nfd', label: 'Node Feature Discovery', pullSecrets: true },
  { id: 'devicePlugin', label: 'Kata device plugin', pullSecrets: false },
  { id: 'provisioner', label: 'Kata device provisioner', pullSecrets: true },
] as const

function App() {
  const [step, setStep] = useState<1 | 2>(1)
  const [selectedVendorId, setSelectedVendorId] = useState(catalog.vendors[0]?.id ?? '')
  const selectedVendor = catalog.vendors.find(({ id }) => id === selectedVendorId) ??
    catalog.vendors[0]
  const runtimeOnlyVendor = isRuntimeOnlyVendor(selectedVendor)
  const [copied, setCopied] = useState<'install' | 'values' | null>(null)
  const [selections, setSelections] = useState<FamilySelections>(() =>
    initialSelections(selectedVendor),
  )
  const [cluster, setCluster] = useState<ClusterConfiguration>({
    distributionId: null,
    selinuxEnabled: false,
  })
  const [runtime, setRuntime] = useState<RuntimeConfiguration>({
    selectedShimIds: [],
    runtimeHttpsProxy: '',
    runtimeNoProxy: '',
    nvidiaDcgmEnabled: false,
  })
  const [advanced, setAdvanced] = useState<AdvancedConfiguration>(
    createAdvancedConfiguration,
  )
  const artifacts = useMemo(() => ({
    values: buildValuesBundle(
      catalog,
      selectedVendor,
      selections,
      cluster,
      runtime,
      advanced,
    ),
    install: buildInstallScript(catalog),
  }), [advanced, cluster, runtime, selectedVendor, selections])
  const incompleteFamilies = selectedVendor.hardwareFamilies.filter((family) =>
    needsCpuSelection(selections[family.id]),
  )
  const selectedDistribution =
    catalog.plannedArchitecture.cluster.distributions.find(
      ({ id }) => id === cluster.distributionId,
    )
  const installedRuntimeClasses = useMemo(() => {
    const shimIds = resolveRuntimeShimIds(
      selectedVendor,
      selections,
      runtime,
    )
    const baseShim = selectedVendor.runtime.shims.find(
      ({ id }) => !id.includes('-snp-') && !id.includes('-tdx-'),
    )

    return shimIds.flatMap((shimId) => {
      const shim = selectedVendor.runtime.shims.find(({ id }) => id === shimId)
      if (!shim) return []
      const tee = selectedVendor.runtime.cpuTees.find(
        ({ shimId: teeShimId }) => teeShimId === shimId,
      )
      const contexts = selectedVendor.hardwareFamilies.flatMap((family) => {
        const selection = selections[family.id]
        const mode = family.modes.find(({ id }) => id === selection?.modeId)
        if (!mode) return []
        if (mode.id === 'off' && shim.id === baseShim?.id) {
          return [`${family.displayName} · ${mode.displayName}`]
        }
        if (tee && selection.cpuTeeIds.includes(tee.id)) {
          return [
            `${family.displayName} · ${mode.displayName} · ${tee.displayName}`,
          ]
        }
        return []
      })
      const purpose =
        selectedVendor.id === 'nvidia'
          ? tee
            ? `NVIDIA pod sandboxes using confidential GPUs on ${tee.displayName} hosts.`
            : 'NVIDIA pod sandboxes using direct GPU passthrough.'
          : runtimeUse(shim.id)

      return [{ ...shim, purpose, contexts }]
    })
  }, [runtime, selectedVendor, selections])
  const requiresErofs =
    selectedVendor.hardwareFamilies.some(
      (family) => selections[family.id]?.modeId === 'off',
    ) ||
    selectedVendor.runtime.shims.some(
      ({ id, snapshotter }) =>
        runtime.selectedShimIds.includes(id) && snapshotter === 'erofs',
    )
  const erofsDiskSizeMissing =
    requiresErofs &&
    advanced.erofsSnapshotterMode === 'disk' &&
    advanced.erofsDiskSize.trim().length === 0
  const valuesReady =
    cluster.distributionId !== null &&
    incompleteFamilies.length === 0 &&
    !erofsDiskSizeMissing &&
    (!runtimeOnlyVendor || runtime.selectedShimIds.length > 0)

  const selectVendor = (vendor: VendorCatalog) => {
    setSelectedVendorId(vendor.id)
    setSelections(initialSelections(vendor))
    setCluster({ distributionId: null, selinuxEnabled: false })
    setRuntime({
      selectedShimIds:
        isRuntimeOnlyVendor(vendor) && vendor.id !== 'local'
          ? vendor.runtime.shims.map(({ id }) => id)
          : [],
      runtimeHttpsProxy: '',
      runtimeNoProxy: '',
      nvidiaDcgmEnabled: false,
    })
    setAdvanced(createAdvancedConfiguration())
    setStep(2)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const selectMode = (familyId: string, modeId: string | null) => {
    setSelections((current) => ({
      ...current,
      [familyId]: {
        modeId,
        cpuTeeIds:
          modeId && modeId !== 'off'
            ? current[familyId]?.cpuTeeIds ?? []
            : [],
      },
    }))
  }

  const toggleCpuTee = (familyId: string, cpuTeeId: string) => {
    setSelections((current) => ({
      ...current,
      [familyId]: {
        modeId: current[familyId]?.modeId ?? null,
        cpuTeeIds: current[familyId]?.cpuTeeIds.includes(cpuTeeId)
          ? current[familyId].cpuTeeIds.filter((id) => id !== cpuTeeId)
          : [...(current[familyId]?.cpuTeeIds ?? []), cpuTeeId],
      },
    }))
  }

  const toggleRuntimeShim = (shimId: string) => {
    setRuntime((current) => ({
      ...current,
      selectedShimIds: current.selectedShimIds.includes(shimId)
        ? current.selectedShimIds.filter((id) => id !== shimId)
        : [...current.selectedShimIds, shimId],
    }))
  }

  const updateNodeSelector = (
    index: number,
    field: 'key' | 'value',
    value: string,
  ) => {
    setAdvanced((current) => ({
      ...current,
      nodeSelector: current.nodeSelector.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [field]: value } : entry,
      ),
    }))
  }

  const updateToleration = (
    index: number,
    field: keyof AdvancedConfiguration['tolerations'][number],
    value: string,
  ) => {
    setAdvanced((current) => ({
      ...current,
      tolerations: current.tolerations.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [field]: value } : entry,
      ),
    }))
  }

  const updateNodeAffinity = (
    index: number,
    changes: Partial<AdvancedConfiguration['nodeAffinity'][number]>,
  ) => {
    setAdvanced((current) => ({
      ...current,
      nodeAffinity: current.nodeAffinity.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...changes } : entry,
      ),
    }))
  }

  const updateImageConfiguration = (
    chart: keyof AdvancedConfiguration['images'],
    changes: Partial<ChartImageConfiguration> & {
      kubectlReference?: string
      kubectlTag?: string
    },
  ) => {
    setAdvanced((current) => ({
      ...current,
      images: {
        ...current.images,
        [chart]: { ...current.images[chart], ...changes },
      },
    }))
  }

  const copyCode = async (target: 'install' | 'values') => {
    if (target === 'values' && !valuesReady) return
    await navigator.clipboard.writeText(artifacts[target])
    setCopied(target)
    window.setTimeout(() => setCopied(null), 1600)
  }

  const restart = () => {
    setStep(1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <button className="brand" onClick={restart} aria-label="Kata Reference Architecture Builder home">
          <span className="header-krab-mark" aria-hidden="true" />
          <span className="brand-copy">
            <strong>KRAB</strong>
            <span className="brand-separator">·</span>
            <small>Kata Reference Architecture Builder</small>
          </span>
        </button>

        <nav aria-label="Main navigation">
          <a href="https://github.com/fidencio/krab" target="_blank" rel="noreferrer">
            View on GitHub
            <ExternalLink size={13} />
          </a>
        </nav>
      </header>

      <main>
        {step === 1 && (
          <section className="intro">
            <h1>
              Build your Kata
              <br />
              <span>reference architecture.</span>
            </h1>
            <p>
              KRAB assembles source-backed hardware profiles, runtime classes,
              and deployment artifacts into one reproducible path.
            </p>
          </section>
        )}

        <section className="explorer" aria-live="polite">
          {step === 1 ? (
            <div className="panel vendor-panel">
              <div className="panel-heading">
                <div>
                  <h2>Who powers your architecture?</h2>
                  <p>Choose the infrastructure KRAB should build around.</p>
                </div>
              </div>

              <div className="vendor-grid">
                {catalog.vendors.map((vendor) => (
                  <button
                    className="vendor-card selected"
                    key={vendor.id}
                    onClick={() => selectVendor(vendor)}
                  >
                    <div className="card-topline">
                      <span className="status-dot">Ready to build</span>
                      <span className="selected-check">
                        <Check size={16} strokeWidth={3} />
                      </span>
                    </div>
                    <div
                      className={`vendor-logo-wrap vendor-${vendor.id} ${
                        isRuntimeOnlyVendor(vendor) ? 'named-brand' : ''
                      }`}
                    >
                      <img
                        src={logoFor(vendor)}
                        alt={vendor.id === 'local' ? '' : vendor.displayName}
                      />
                      {vendor.id === 'local' && (
                        <span>
                          <strong>{vendor.displayName}</strong>
                          <small>{vendor.tagline}</small>
                        </span>
                      )}
                    </div>
                    <p>{vendor.description}</p>
                    <div className="capabilities">
                      {vendor.capabilities.map((capability) => (
                        <span key={capability.id}>
                          {capability.resourceName ?? humanize(capability.id)}
                        </span>
                      ))}
                    </div>
                    <div className="card-link">
                      Build with {vendor.displayName}
                      <ArrowRight size={18} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="install-builder">
              <div className="builder-toolbar">
                <button className="back-link" onClick={restart}>← Back to vendors</button>
                {runtimeOnlyVendor ? (
                  <span className="builder-vendor-context">
                    <span>Building for</span>
                    <span
                      className={`builder-vendor-mark named vendor-${selectedVendor.id}`}
                    >
                      <img src={logoFor(selectedVendor)} alt="" />
                      {selectedVendor.id === 'local' && (
                        <strong>{selectedVendor.displayName}</strong>
                      )}
                    </span>
                  </span>
                ) : (
                  <a href={selectedVendor.sourceUrl} target="_blank" rel="noreferrer">
                    <span>Building for</span>
                    <span className="builder-vendor-mark">
                      <img src={logoFor(selectedVendor)} alt={selectedVendor.displayName} />
                    </span>
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>

              <div className="source-strip">
                <a
                  href={selectedVendor.runtime.chart.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedVendor.runtime.chart.name} {selectedVendor.runtime.chart.version}
                </a>
                {selectedVendor.id === 'nvidia' && (
                  <a
                    href={selectedVendor.provisioner.chart.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Experimental provisioner · PR #{selectedVendor.provisioner.chart.pullRequest}
                  </a>
                )}
                <span>{provenanceData.generatedFrom.length} pinned source files</span>
              </div>

              <details className="architecture-details">
                <summary>
                  <span>
                    <strong>How KRAB assembles this architecture</strong>
                    <small>View chart dependencies and ownership</small>
                  </span>
                  <ChevronDown size={17} />
                </summary>
                <div className="architecture-chain">
                  <div className="architecture-node planned">
                    <small>Planned parent chart</small>
                    <strong>{catalog.plannedArchitecture.charts.krab.chartName}</strong>
                    <span>Reference architecture entry point</span>
                  </div>
                  <ArrowRight size={18} />
                  <div className="architecture-dependencies">
                    <div className="architecture-node required">
                      <small>Required dependency</small>
                      <strong>
                        {catalog.plannedArchitecture.charts.nfd.chartName}{' '}
                        {catalog.plannedArchitecture.charts.nfd.version}
                      </strong>
                      <span>Always installed by KRAB</span>
                    </div>
                    <div className="architecture-node required">
                      <small>Required dependency</small>
                      <strong>
                        {catalog.plannedArchitecture.charts.kataDeploy.chartName}{' '}
                        {catalog.plannedArchitecture.charts.kataDeploy.version}
                      </strong>
                      <span>Installs Kata runtimes and RuntimeClasses</span>
                    </div>
                    {selectedVendor.id === 'nvidia' && (
                      <>
                        <div className="architecture-node vendor-specific">
                          <small>NVIDIA dependency</small>
                          <strong>
                            {catalog.plannedArchitecture.charts.devicePlugin.chartName}{' '}
                            {catalog.plannedArchitecture.charts.devicePlugin.version}
                          </strong>
                          <span>Advertises VFIO devices to kubelet</span>
                        </div>
                        <div className="architecture-node planned vendor-specific">
                          <small>Planned NVIDIA dependency</small>
                          <strong>
                            {catalog.plannedArchitecture.charts.provisioner.chartName}{' '}
                            {catalog.plannedArchitecture.charts.provisioner.version}
                          </strong>
                          <span>Provisions multiple hardware profiles in one release</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </details>

              <section className="install-command-callout">
                <div className="artifact-heading">
                  <div>
                    <span className="section-kicker">Install with KRAB</span>
                    <h2>One command for every architecture</h2>
                    <p>The command stays constant. Only the generated values.yaml changes.</p>
                  </div>
                  <button className="copy-artifact-button" onClick={() => copyCode('install')}>
                    {copied === 'install' ? <Check size={15} /> : <Copy size={15} />}
                    {copied === 'install' ? 'Copied' : 'Copy command'}
                  </button>
                </div>
                <div className="install-command">
                  <code>{artifacts.install}</code>
                </div>
              </section>

              <section
                className={`cluster-config cluster-config-wide ${
                  cluster.distributionId ? '' : 'incomplete'
                }`}
              >
                <header>
                  <div>
                    <span>Cluster configuration</span>
                    <strong>Kubernetes platform</strong>
                  </div>
                  <em>{cluster.distributionId ? 'Configured' : 'Required'}</em>
                </header>
                <div className="cluster-fields single-field">
                  <div className="cluster-field">
                    <div className="field-label">
                      Distribution
                      <details className="info-popover">
                        <summary aria-label="Distribution support details">i</summary>
                        <div className="popover-panel">
                          <strong>Supported layouts</strong>
                          <p>
                            RKE2, K3s, MicroK8s, and k0s are supported with
                            their default deployment configuration only. kubeadm
                            maps to kata-deploy&apos;s standard k8s profile.
                          </p>
                        </div>
                      </details>
                    </div>
                    <select
                      value={cluster.distributionId ?? ''}
                      onChange={(event) =>
                        setCluster((current) => ({
                          ...current,
                          distributionId: event.target.value || null,
                        }))
                      }
                    >
                      <option value="">Select distribution…</option>
                      {catalog.plannedArchitecture.cluster.distributions.map(
                        (distribution) => (
                          <option key={distribution.id} value={distribution.id}>
                            {distribution.displayName}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                </div>
                {!cluster.distributionId && (
                  <p>Select a distribution to generate values.yaml.</p>
                )}
              </section>

              {requiresErofs && (
                <div
                  className={`runtime-prerequisite ${
                    advanced.installErofsUtils ? 'managed' : ''
                  }`}
                  role="note"
                >
                  {advanced.installErofsUtils ? (
                    <Check size={18} />
                  ) : (
                    <AlertTriangle size={18} />
                  )}
                  <div>
                    <strong>EROFS host prerequisite</strong>
                    {advanced.installErofsUtils ? (
                      <p>
                        The generated job-mode deployment stages mkfs.erofs 1.9.3
                        on every targeted node before validating the host.
                      </p>
                    ) : (
                      <p>
                        Install erofs-utils 1.8.2 or newer on every targeted node,
                        or enable utility installation under Advanced deployment
                        configuration.
                      </p>
                    )}
                  </div>
                </div>
              )}

              <details className="advanced-config">
                <summary>
                  <span>
                    <strong>Advanced deployment configuration</strong>
                    <small>
                      Most deployments can use the generated defaults. Change
                      these only for environment-specific requirements.
                    </small>
                  </span>
                  <ChevronDown size={17} />
                </summary>
                <div className="advanced-config-body">
                  <section className="advanced-group">
                    <header>
                      <span>Kata runtime</span>
                      <strong>Guest network access</strong>
                      <small>
                        Proxy image pulls performed inside confidential Kata guests.
                      </small>
                    </header>
                    <div className="advanced-field-grid two-columns">
                      <label>
                        <span>HTTPS proxy</span>
                        <input
                          type="url"
                          value={runtime.runtimeHttpsProxy}
                          placeholder="https://proxy.example.com:8443"
                          onChange={(event) =>
                            setRuntime((current) => ({
                              ...current,
                              runtimeHttpsProxy: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>NO_PROXY</span>
                        <input
                          type="text"
                          value={runtime.runtimeNoProxy}
                          placeholder="registry.internal,.svc,.cluster.local"
                          onChange={(event) =>
                            setRuntime((current) => ({
                              ...current,
                              runtimeNoProxy: event.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                  </section>
                  {selectedVendor.id === 'nvidia' && (
                    <section className="advanced-group component-toggle-group">
                    <div>
                      <span>Kata runtime · NVIDIA RuntimeClasses</span>
                      <strong>DCGM metrics</strong>
                      <small>
                        Starts nv-hostengine and dcgm-exporter for NVIDIA pod sandboxes.
                      </small>
                    </div>
                    <label className="selinux-toggle">
                      <span className="toggle-copy">
                        <strong>
                          {runtime.nvidiaDcgmEnabled ? 'Enabled' : 'Disabled'}
                        </strong>
                        <small>Applied to every selected NVIDIA RuntimeClass.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={runtime.nvidiaDcgmEnabled}
                        onChange={(event) =>
                          setRuntime((current) => ({
                            ...current,
                            nvidiaDcgmEnabled: event.target.checked,
                          }))
                        }
                      />
                      <span className="toggle-track" aria-hidden="true">
                        <span />
                      </span>
                    </label>
                    </section>
                  )}
                  <section className="advanced-group component-toggle-group">
                    <div>
                      <span>Kata runtime installer</span>
                      <strong>SELinux policy</strong>
                      <small>
                        Loads Kata&apos;s installer policy on SELinux-enforcing nodes.
                      </small>
                    </div>
                    <label className="selinux-toggle">
                      <span className="toggle-copy">
                        <strong>
                          {cluster.selinuxEnabled ? 'Enabled' : 'Disabled'}
                        </strong>
                        <small>Recommended on SELinux-enforcing worker nodes.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={cluster.selinuxEnabled}
                        onChange={(event) =>
                          setCluster((current) => ({
                            ...current,
                            selinuxEnabled: event.target.checked,
                          }))
                        }
                      />
                      <span className="toggle-track" aria-hidden="true">
                        <span />
                      </span>
                    </label>
                  </section>
                  {requiresErofs && (
                    <section className="advanced-group erofs-installer">
                      <header>
                        <span>Kata runtime · EROFS snapshotter</span>
                        <strong>EROFS configuration</strong>
                        <small>
                          Configure writable-layer storage and integrity checks
                          for every selected RuntimeClass that uses EROFS.
                        </small>
                      </header>
                      <div
                        className={`advanced-field-grid erofs-mode-field ${
                          advanced.erofsSnapshotterMode === 'disk'
                            ? 'with-size'
                            : ''
                        }`}
                      >
                        <label>
                          <span>Writable-layer backing</span>
                          <select
                            value={advanced.erofsSnapshotterMode}
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                erofsSnapshotterMode: event.target.value as
                                  AdvancedConfiguration['erofsSnapshotterMode'],
                              }))
                            }
                          >
                            <option value="memory">Memory</option>
                            <option value="disk">Disk</option>
                          </select>
                          <small>
                            {advanced.erofsSnapshotterMode === 'memory'
                              ? 'Keeps writable layers in memory.'
                              : 'Uses disk-backed writable layers.'}
                          </small>
                        </label>
                        {advanced.erofsSnapshotterMode === 'disk' && (
                          <label>
                            <span>Writable-layer size</span>
                            <input
                              type="text"
                              required
                              value={advanced.erofsDiskSize}
                              placeholder="256M"
                              onChange={(event) =>
                                setAdvanced((current) => ({
                                  ...current,
                                  erofsDiskSize: event.target.value,
                                }))
                              }
                            />
                          </label>
                        )}
                      </div>
                      <div className="erofs-integrity-options">
                        <label className="selinux-toggle">
                          <span className="toggle-copy">
                            <strong>dm-verity</strong>
                            <small>Verify EROFS lower-layer block integrity.</small>
                          </span>
                          <input
                            type="checkbox"
                            checked={advanced.erofsDmverity}
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                erofsDmverity: event.target.checked,
                              }))
                            }
                          />
                          <span className="toggle-track" aria-hidden="true">
                            <span />
                          </span>
                        </label>
                        <label className="selinux-toggle">
                          <span className="toggle-copy">
                            <strong>fs-verity</strong>
                            <small>Enable host snapshotter filesystem verification.</small>
                          </span>
                          <input
                            type="checkbox"
                            checked={advanced.erofsEnableFsverity}
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                erofsEnableFsverity: event.target.checked,
                              }))
                            }
                          />
                          <span className="toggle-track" aria-hidden="true">
                            <span />
                          </span>
                        </label>
                      </div>
                      <div className="erofs-utilities">
                        <header>
                          <strong>Provide EROFS utilities</strong>
                          <small>
                            Enable when nodes do not provide erofs-utils 1.8.2
                            or newer. Kata-deploy installs mkfs.erofs before its
                            host checks run.
                          </small>
                        </header>
                        <label className="selinux-toggle">
                          <span className="toggle-copy">
                            <strong>
                              {advanced.installErofsUtils
                                ? 'Managed'
                                : 'Host provided'}
                            </strong>
                            <small>Uses the enforced job installation mode.</small>
                          </span>
                          <input
                            type="checkbox"
                            checked={advanced.installErofsUtils}
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                installErofsUtils: event.target.checked,
                              }))
                            }
                          />
                          <span className="toggle-track" aria-hidden="true">
                            <span />
                          </span>
                        </label>
                        {advanced.installErofsUtils && (
                          <label className="erofs-image-field">
                            <span>Utility image override</span>
                            <input
                              type="text"
                              value={advanced.erofsUtilsImage}
                              placeholder="quay.io/kata-containers/erofs-utils:1.9.3"
                              onChange={(event) =>
                                setAdvanced((current) => ({
                                  ...current,
                                  erofsUtilsImage: event.target.value,
                                }))
                              }
                            />
                            <small>Leave empty to use the pinned image.</small>
                          </label>
                        )}
                      </div>
                    </section>
                  )}
                  {cluster.distributionId === 'kubeadm' && (
                    <section className="advanced-group">
                      <header>
                        <span>Kata runtime</span>
                        <strong>Custom containerd paths</strong>
                        <small>Optional overrides for non-standard kubeadm nodes.</small>
                      </header>
                      <div className="advanced-field-grid three-columns">
                        <label>
                          <span>Configuration directory</span>
                          <input
                            type="text"
                            value={advanced.containerdConfigDir}
                            placeholder="/etc/containerd"
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                containerdConfigDir: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Runtime socket</span>
                          <input
                            type="text"
                            value={advanced.containerdRuntimeSocket}
                            placeholder="unix:///run/containerd/containerd.sock"
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                containerdRuntimeSocket: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Configuration filename</span>
                          <input
                            type="text"
                            value={advanced.containerdConfigFileName}
                            placeholder="config.toml"
                            onChange={(event) =>
                              setAdvanced((current) => ({
                                ...current,
                                containerdConfigFileName: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                    </section>
                  )}

                  <section className="advanced-group">
                    <header>
                      <span>Kata runtime installer</span>
                      <strong>Node targeting</strong>
                      <small>
                        Restrict installation to matching nodes and admit tainted nodes.
                      </small>
                    </header>
                    <div className="advanced-list-heading">
                      <span>Node selectors</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAdvanced((current) => ({
                            ...current,
                            nodeSelector: [
                              ...current.nodeSelector,
                              { key: '', value: '' },
                            ],
                          }))
                        }
                      >
                        <Plus size={13} /> Add selector
                      </button>
                    </div>
                    {advanced.nodeSelector.length === 0 ? (
                      <p className="advanced-empty">All otherwise eligible nodes.</p>
                    ) : (
                      <div className="advanced-rows selector-rows">
                        {advanced.nodeSelector.map((entry, index) => (
                          <div className="advanced-row" key={`selector-${index}`}>
                            <input
                              aria-label={`Node selector ${index + 1} key`}
                              value={entry.key}
                              placeholder="node-role.kubernetes.io/worker"
                              onChange={(event) =>
                                updateNodeSelector(index, 'key', event.target.value)
                              }
                            />
                            <input
                              aria-label={`Node selector ${index + 1} value`}
                              value={entry.value}
                              placeholder="true"
                              onChange={(event) =>
                                updateNodeSelector(index, 'value', event.target.value)
                              }
                            />
                            <button
                              type="button"
                              aria-label={`Remove node selector ${index + 1}`}
                              onClick={() =>
                                setAdvanced((current) => ({
                                  ...current,
                                  nodeSelector: current.nodeSelector.filter(
                                    (_, entryIndex) => entryIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="advanced-list-heading toleration-heading">
                      <span>Required node affinity</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAdvanced((current) => ({
                            ...current,
                            nodeAffinity: [
                              ...current.nodeAffinity,
                              { key: '', operator: 'In', values: [] },
                            ],
                          }))
                        }
                      >
                        <Plus size={13} /> Add expression
                      </button>
                    </div>
                    {advanced.nodeAffinity.length === 0 ? (
                      <p className="advanced-empty">No additional affinity rules.</p>
                    ) : (
                      <div className="advanced-rows affinity-rows">
                        {advanced.nodeAffinity.map((entry, index) => (
                          <div className="advanced-row" key={`affinity-${index}`}>
                            <input
                              aria-label={`Node affinity ${index + 1} key`}
                              value={entry.key}
                              placeholder="feature.node.kubernetes.io/example"
                              onChange={(event) =>
                                updateNodeAffinity(index, { key: event.target.value })
                              }
                            />
                            <select
                              aria-label={`Node affinity ${index + 1} operator`}
                              value={entry.operator}
                              onChange={(event) =>
                                updateNodeAffinity(index, {
                                  operator: event.target.value as AdvancedConfiguration['nodeAffinity'][number]['operator'],
                                })
                              }
                            >
                              <option value="In">In</option>
                              <option value="NotIn">NotIn</option>
                              <option value="Exists">Exists</option>
                              <option value="DoesNotExist">DoesNotExist</option>
                            </select>
                            <input
                              aria-label={`Node affinity ${index + 1} values`}
                              value={entry.values.join(', ')}
                              placeholder="value-a, value-b"
                              disabled={
                                entry.operator === 'Exists' ||
                                entry.operator === 'DoesNotExist'
                              }
                              onChange={(event) =>
                                updateNodeAffinity(index, {
                                  values: event.target.value.split(','),
                                })
                              }
                            />
                            <button
                              type="button"
                              aria-label={`Remove node affinity ${index + 1}`}
                              onClick={() =>
                                setAdvanced((current) => ({
                                  ...current,
                                  nodeAffinity: current.nodeAffinity.filter(
                                    (_, entryIndex) => entryIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="advanced-list-heading toleration-heading">
                      <span>Tolerations</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAdvanced((current) => ({
                            ...current,
                            tolerations: [
                              ...current.tolerations,
                              { key: '', operator: 'Exists', value: '', effect: '' },
                            ],
                          }))
                        }
                      >
                        <Plus size={13} /> Add toleration
                      </button>
                    </div>
                    {advanced.tolerations.length === 0 ? (
                      <p className="advanced-empty">No additional tolerations.</p>
                    ) : (
                      <div className="advanced-rows toleration-rows">
                        {advanced.tolerations.map((entry, index) => (
                          <div className="advanced-row" key={`toleration-${index}`}>
                            <input
                              aria-label={`Toleration ${index + 1} key`}
                              value={entry.key}
                              placeholder="Taint key"
                              onChange={(event) =>
                                updateToleration(index, 'key', event.target.value)
                              }
                            />
                            <select
                              aria-label={`Toleration ${index + 1} operator`}
                              value={entry.operator}
                              onChange={(event) =>
                                updateToleration(index, 'operator', event.target.value)
                              }
                            >
                              <option value="Exists">Exists</option>
                              <option value="Equal">Equal</option>
                            </select>
                            <input
                              aria-label={`Toleration ${index + 1} value`}
                              value={entry.value}
                              placeholder="Value"
                              disabled={entry.operator === 'Exists'}
                              onChange={(event) =>
                                updateToleration(index, 'value', event.target.value)
                              }
                            />
                            <select
                              aria-label={`Toleration ${index + 1} effect`}
                              value={entry.effect}
                              onChange={(event) =>
                                updateToleration(index, 'effect', event.target.value)
                              }
                            >
                              <option value="">Any effect</option>
                              <option value="NoSchedule">NoSchedule</option>
                              <option value="PreferNoSchedule">PreferNoSchedule</option>
                              <option value="NoExecute">NoExecute</option>
                            </select>
                            <button
                              type="button"
                              aria-label={`Remove toleration ${index + 1}`}
                              onClick={() =>
                                setAdvanced((current) => ({
                                  ...current,
                                  tolerations: current.tolerations.filter(
                                    (_, entryIndex) => entryIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="advanced-group">
                    <header>
                      <span>All deployed components</span>
                      <strong>Image pulls</strong>
                      <small>
                        Configure each dependency&apos;s registry credentials, policy,
                        and optional mirror.
                      </small>
                    </header>
                    <div className="chart-image-list">
                      {imageChartOptions
                        .filter(
                          ({ id }) =>
                            selectedVendor.id === 'nvidia' ||
                            id === 'kataDeploy' ||
                            id === 'nfd',
                        )
                        .map((chart) => {
                        const configuration = advanced.images[chart.id]
                        return (
                          <div className="chart-image-card" key={chart.id}>
                            <strong>{chart.label}</strong>
                            <div className="advanced-field-grid two-columns">
                              <label>
                                <span>Pull policy</span>
                                <select
                                  value={configuration.pullPolicy}
                                  onChange={(event) =>
                                    updateImageConfiguration(chart.id, {
                                      pullPolicy: event.target.value as ChartImageConfiguration['pullPolicy'],
                                    })
                                  }
                                >
                                  <option value="">Chart default</option>
                                  <option value="Always">Always</option>
                                  <option value="IfNotPresent">IfNotPresent</option>
                                  <option value="Never">Never</option>
                                </select>
                              </label>
                              <label>
                                <span>
                                  Image pull secrets
                                  {!chart.pullSecrets && <em>Not implemented yet</em>}
                                </span>
                                <input
                                  type="text"
                                  value={configuration.pullSecrets.join(', ')}
                                  placeholder="registry-secret, mirror-secret"
                                  onChange={(event) =>
                                    updateImageConfiguration(chart.id, {
                                      pullSecrets: event.target.value.split(','),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <div className="image-override-row primary-image-row">
                              <strong>Primary image</strong>
                              <input
                                aria-label={`${chart.label} image reference`}
                                value={configuration.reference}
                                placeholder="Registry/repository"
                                onChange={(event) =>
                                  updateImageConfiguration(chart.id, {
                                    reference: event.target.value,
                                  })
                                }
                              />
                              <input
                                aria-label={`${chart.label} image tag`}
                                value={configuration.tag}
                                placeholder="Tag"
                                onChange={(event) =>
                                  updateImageConfiguration(chart.id, {
                                    tag: event.target.value,
                                  })
                                }
                              />
                            </div>
                            {chart.id === 'kataDeploy' && (
                              <div className="image-override-row">
                                <strong>Kubectl image</strong>
                                <input
                                  aria-label="Kubectl image reference"
                                  value={advanced.images.kataDeploy.kubectlReference}
                                  placeholder="Registry/repository"
                                  onChange={(event) =>
                                    updateImageConfiguration('kataDeploy', {
                                      kubectlReference: event.target.value,
                                    })
                                  }
                                />
                                <input
                                  aria-label="Kubectl image tag"
                                  value={advanced.images.kataDeploy.kubectlTag}
                                  placeholder="Tag"
                                  onChange={(event) =>
                                    updateImageConfiguration('kataDeploy', {
                                      kubectlTag: event.target.value,
                                    })
                                  }
                                />
                              </div>
                            )}
                            {(chart.id === 'kataDeploy' ||
                              chart.id === 'provisioner') && (
                              <div className="image-override-row">
                                <strong>Job dispatcher</strong>
                                <input
                                  aria-label={`${chart.label} dispatcher image reference`}
                                  value={configuration.dispatcherReference}
                                  placeholder="Registry/repository"
                                  onChange={(event) =>
                                    updateImageConfiguration(chart.id, {
                                      dispatcherReference: event.target.value,
                                    })
                                  }
                                />
                                <input
                                  aria-label={`${chart.label} dispatcher image tag`}
                                  value={configuration.dispatcherTag}
                                  placeholder="Tag"
                                  onChange={(event) =>
                                    updateImageConfiguration(chart.id, {
                                      dispatcherTag: event.target.value,
                                    })
                                  }
                                />
                              </div>
                            )}
                          </div>
                        )
                        })}
                    </div>
                  </section>

                  <section className="advanced-group debug-group">
                    <div>
                      <span>Kata runtime</span>
                      <strong>Runtime debugging</strong>
                      <small>
                        Adds debug RuntimeClasses and enables host-side diagnostics.
                      </small>
                    </div>
                    <label className="selinux-toggle">
                      <span className="toggle-copy">
                        <strong>{advanced.debug ? 'Enabled' : 'Disabled'}</strong>
                        <small>Leave disabled for production workloads.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={advanced.debug}
                        onChange={(event) =>
                          setAdvanced((current) => ({
                            ...current,
                            debug: event.target.checked,
                          }))
                        }
                      />
                      <span className="toggle-track" aria-hidden="true">
                        <span />
                      </span>
                    </label>
                  </section>
                </div>
              </details>

              <div className="builder-grid">
                <div
                  className={`profile-list ${
                    selectedVendor.id === 'nvidia' ? 'nvidia-profiles' : ''
                  }`}
                >
                  {runtimeOnlyVendor && (
                    <section
                      className={`local-runtime-selection ${
                        runtime.selectedShimIds.length === 0 ? 'incomplete' : ''
                      }`}
                    >
                      <header>
                        <div>
                          <span>{selectedVendor.displayName} deployment</span>
                          <h2>Select RuntimeClasses</h2>
                          <p>
                            {selectedVendor.runtime.shims.length === 1
                              ? `This path installs the Kata runtime for ${selectedVendor.tagline}.`
                              : 'Choose every Kata runtime that should be installed ' +
                                'on this cluster. QEMU runtime-rs is the broadly ' +
                                'supported default.'}
                          </p>
                        </div>
                        <em>
                          {runtime.selectedShimIds.length > 0
                            ? `${runtime.selectedShimIds.length} selected`
                            : 'Required'}
                        </em>
                      </header>
                      <div className="local-runtime-grid">
                        {selectedVendor.runtime.shims.map((shim) => (
                          <label key={shim.id}>
                            <input
                              type="checkbox"
                              checked={runtime.selectedShimIds.includes(shim.id)}
                              onChange={() => toggleRuntimeShim(shim.id)}
                            />
                            <span>
                              <strong>{runtimeName(shim.id)}</strong>
                              <small>{runtimeUse(shim.id)}</small>
                              <em>
                                {shim.supportedArches.length === 1
                                  ? `Architecture: ${shim.supportedArches[0]}`
                                  : `Architectures: ${shim.supportedArches.join(' · ')}`}
                              </em>
                            </span>
                          </label>
                        ))}
                      </div>
                    </section>
                  )}
                  {selectedVendor.hardwareFamilies.map((family) => (
                    <details className="profile-card" key={family.id}>
                      <summary>
                        <div>
                          <h2>{family.displayName}</h2>
                          <strong>
                            {family.models.length > 0
                              ? family.models.join(' / ')
                              : family.upstreamName}
                          </strong>
                        </div>
                        <div className="profile-summary-status">
                          <span
                            className={
                              needsCpuSelection(selections[family.id])
                                ? 'incomplete'
                                : ''
                            }
                          >
                            {profileSummary(selectedVendor, selections[family.id])}
                          </span>
                          <ChevronDown size={16} />
                        </div>
                      </summary>
                      <div className="profile-options">
                        {family.modes.map((mode) => (
                          <label className="mode-option" key={mode.id}>
                            <input
                              type="radio"
                              name={`${family.id}-mode`}
                              checked={selections[family.id]?.modeId === mode.id}
                              onChange={() => selectMode(family.id, mode.id)}
                            />
                            <span>
                              <strong>
                                {mode.displayName}
                                {mode.badge && <em>{mode.badge}</em>}
                              </strong>
                            </span>
                          </label>
                        ))}

                        {selections[family.id]?.modeId &&
                          selections[family.id].modeId !== 'off' && (
                            <fieldset
                              className={`cpu-tee-selection ${
                                needsCpuSelection(selections[family.id])
                                  ? 'needs-selection'
                                  : ''
                              }`}
                            >
                              <legend>Base CPUs / confidential-computing TEEs</legend>
                              <p>
                                Select every host CPU type used with this GPU family.{' '}
                                <a
                                  href={
                                    selectedVendor.integration.officialSupport
                                      .workloadsUrl
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Official documentation <ExternalLink size={10} />
                                </a>
                              </p>
                              {needsCpuSelection(selections[family.id]) && (
                                <strong className="selection-required">
                                  Select at least one CPU / TEE to generate values.yaml.
                                </strong>
                              )}
                              <div>
                                {selectedVendor.runtime.cpuTees.map((tee) => (
                                  <label key={tee.id}>
                                    <input
                                      type="checkbox"
                                      checked={
                                        selections[family.id]?.cpuTeeIds.includes(
                                          tee.id,
                                        ) ?? false
                                      }
                                      onChange={() =>
                                        toggleCpuTee(family.id, tee.id)
                                      }
                                    />
                                    <span>
                                      <strong>{tee.displayName}</strong>
                                    </span>
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                          )}

                        <label className="mode-option">
                          <input
                            type="radio"
                            name={`${family.id}-mode`}
                            checked={selections[family.id]?.modeId === null}
                            onChange={() => selectMode(family.id, null)}
                          />
                          <span>
                            <strong>Not present in this cluster</strong>
                            <small>Do not generate a provisioner release for this family.</small>
                          </span>
                        </label>
                      </div>
                    </details>
                  ))}
                </div>

                <section className="runtime-install-summary">
                  <header>
                    <div>
                      <span>Installation summary</span>
                      <h2>RuntimeClasses installed on the cluster</h2>
                      <p>
                        These are the Kubernetes RuntimeClass names workloads
                        will reference through <code>runtimeClassName</code>.
                      </p>
                    </div>
                    <strong>
                      {installedRuntimeClasses.length}{' '}
                      {installedRuntimeClasses.length === 1
                        ? 'RuntimeClass'
                        : 'RuntimeClasses'}
                    </strong>
                  </header>
                  {installedRuntimeClasses.length > 0 ? (
                    <div className="runtime-summary-grid">
                      {installedRuntimeClasses.map((shim) => (
                        <article key={shim.id}>
                          <div className="runtime-summary-title">
                            <Check size={14} />
                            <div>
                              <span>{runtimeName(shim.id)}</span>
                              <code>{shim.runtimeClass}</code>
                            </div>
                          </div>
                          <p>{shim.purpose}</p>
                          {shim.contexts.length > 0 && (
                            <ul>
                              {shim.contexts.map((context) => (
                                <li key={context}>{context}</li>
                              ))}
                            </ul>
                          )}
                          <small>
                            {shim.supportedArches.length === 1
                              ? `Architecture: ${shim.supportedArches[0]}`
                              : `Architectures: ${shim.supportedArches.join(' · ')}`}
                          </small>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="runtime-summary-empty">
                      Select a runtime or NVIDIA hardware profile to see what
                      workloads will be able to request.
                    </p>
                  )}
                </section>

                <aside className="code-column">
                  <div className="code-heading">
                    <div>
                      <span><FileCode2 size={15} /> Generated values.yaml</span>
                      <small>
                        {valuesReady
                          ? `${selectedDistribution?.displayName} · Installer SELinux ${
                              cluster.selinuxEnabled ? 'enabled' : 'disabled'
                            }`
                          : 'Complete the required configuration first'}
                      </small>
                    </div>
                    <button
                      className="copy-artifact-button"
                      disabled={!valuesReady}
                      onClick={() => copyCode('values')}
                    >
                      {copied === 'values' ? <Check size={15} /> : <Clipboard size={15} />}
                      {copied === 'values' ? 'Copied' : 'Copy values.yaml'}
                    </button>
                  </div>
                  {valuesReady ? (
                    <div className="code-preview">
                      <pre><code>{artifacts.values}</code></pre>
                    </div>
                  ) : (
                    <div className="values-blocked">
                      <span>Configuration incomplete</span>
                      <strong>Complete the required selections:</strong>
                      <ul>
                        {!cluster.distributionId && (
                          <li>Kubernetes distribution</li>
                        )}
                        {runtimeOnlyVendor &&
                          runtime.selectedShimIds.length === 0 && (
                            <li>At least one Kata RuntimeClass</li>
                          )}
                        {erofsDiskSizeMissing && (
                          <li>EROFS disk-backed writable-layer size</li>
                        )}
                        {incompleteFamilies.map((family) => (
                          <li key={family.id}>
                            CPU / TEE for {family.displayName}
                          </li>
                        ))}
                      </ul>
                      <p>
                        KRAB will generate values.yaml once the cluster platform
                        and every confidential GPU profile are fully configured.
                      </p>
                    </div>
                  )}
                </aside>
              </div>
            </div>
          )}
        </section>
      </main>

    </div>
  )
}

export default App
