import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  ExternalLink,
  FileCode2,
} from 'lucide-react'
import catalogData from './generated/catalog.json'
import provenanceData from './generated/provenance.json'
import {
  buildInstallScript,
  buildValuesBundle,
  type ClusterConfiguration,
  type ExplorerCatalog,
  type FamilySelections,
  type VendorCatalog,
} from './lib/artifacts'
import './App.css'

const catalog = catalogData as unknown as ExplorerCatalog
const brandLogos = import.meta.glob('./assets/brands/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>

const logoFor = (vendor: { logo: string }) =>
  brandLogos[`./assets/brands/${vendor.logo}`]

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

function App() {
  const [step, setStep] = useState<1 | 2>(1)
  const [selectedVendorId, setSelectedVendorId] = useState(catalog.vendors[0]?.id ?? '')
  const selectedVendor = catalog.vendors.find(({ id }) => id === selectedVendorId) ??
    catalog.vendors[0]
  const [copied, setCopied] = useState<'install' | 'values' | null>(null)
  const [selections, setSelections] = useState<FamilySelections>(() =>
    initialSelections(selectedVendor),
  )
  const [cluster, setCluster] = useState<ClusterConfiguration>({
    distributionId: null,
    selinuxEnabled: false,
  })
  const artifacts = useMemo(() => ({
    values: buildValuesBundle(catalog, selectedVendor, selections, cluster),
    install: buildInstallScript(catalog),
  }), [cluster, selectedVendor, selections])
  const incompleteFamilies = selectedVendor.hardwareFamilies.filter((family) =>
    needsCpuSelection(selections[family.id]),
  )
  const selectedDistribution =
    catalog.plannedArchitecture.cluster.distributions.find(
      ({ id }) => id === cluster.distributionId,
    )
  const valuesReady =
    cluster.distributionId !== null && incompleteFamilies.length === 0

  const selectVendor = (vendor: VendorCatalog) => {
    setSelectedVendorId(vendor.id)
    setSelections(initialSelections(vendor))
    setCluster({ distributionId: null, selinuxEnabled: false })
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
                    <div className="vendor-logo-wrap">
                      <img src={logoFor(vendor)} alt={vendor.displayName} />
                    </div>
                    <p>
                      {vendor.hardwareFamilies.length} hardware families and{' '}
                      {vendor.runtime.shims.length} runtime classes discovered.
                    </p>
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
                <a href={selectedVendor.sourceUrl} target="_blank" rel="noreferrer">
                  <span>Building for</span>
                  <img src={logoFor(selectedVendor)} alt={selectedVendor.displayName} />
                  <ExternalLink size={11} />
                </a>
              </div>

              <div className="source-strip">
                <a
                  href={selectedVendor.runtime.chart.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selectedVendor.runtime.chart.name} {selectedVendor.runtime.chart.version}
                </a>
                <a
                  href={selectedVendor.provisioner.chart.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Experimental provisioner · PR #{selectedVendor.provisioner.chart.pullRequest}
                </a>
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
                <div className="cluster-fields">
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
                  <div className="cluster-field">
                    <div className="field-label">
                      Installer SELinux policy
                      <details className="info-popover">
                        <summary aria-label="Installer SELinux policy details">i</summary>
                        <div className="popover-panel align-right">
                          <strong>Installer confinement only</strong>
                          <p>
                            Loads a Kata-owned policy for kata-deploy&apos;s
                            installation containers on enforcing nodes. It does
                            not enable SELinux inside Kata VMs or workloads.
                          </p>
                        </div>
                      </details>
                    </div>
                    <label className="selinux-toggle">
                      <span className="toggle-copy">
                        <strong>
                          {cluster.selinuxEnabled ? 'Enabled' : 'Disabled'}
                        </strong>
                        <small>Applies only to the installation path.</small>
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
                  </div>
                </div>
                {!cluster.distributionId && (
                  <p>Select a distribution to generate values.yaml.</p>
                )}
              </section>

              <div className="builder-grid">
                <div className="profile-list">
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
