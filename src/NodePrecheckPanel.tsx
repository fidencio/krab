import { useState, type Dispatch, type SetStateAction } from 'react'
import { Check, CircleAlert, Copy, Upload } from 'lucide-react'
import packageData from '../package.json'
import catalog from './generated/catalog.json' with { type: 'json' }
import { gpuModelChoices, hasGpuModel, type NodePrecheck, type RequestedCheck } from './lib/precheck'
import { precheckCommand } from './lib/precheck-command'

const readinessChecks = [
  { id: 'tdx', label: 'Intel TDX' },
  { id: 'snp', label: 'AMD SEV-SNP' },
  { id: 'se', label: 'IBM SEL' },
  { id: 'gpu', label: 'NVIDIA GPU' },
] as const
const nvidia = catalog.vendors.find((vendor) => vendor.id === 'nvidia')
if (!nvidia) throw new Error('Generated catalog has no NVIDIA vendor')
const gpuModels = gpuModelChoices(nvidia.hardwareFamilies)
const pageSize = 10

function shortReason(label: string, status: string, reason: string) {
  if (status === 'unknown' || status === 'review') return `${label} unconfirmed`
  if (reason.includes('requires an Intel CPU')) return 'Intel CPU required'
  if (reason.includes('requires an AMD CPU')) return 'AMD CPU required'
  if (reason.includes('requires s390x')) return 'S390X required'
  if (label === 'EROFS utilities') return 'EROFS setup needed'
  if (label === 'NVIDIA GPU') return 'NVIDIA GPU not found'
  if (label === 'IOMMUFD' || label === 'KVM') return `${label} unavailable`
  if (reason.startsWith('/')) return 'Host support not detected'
  return reason
}

function readinessResult(report: NodePrecheck, check: RequestedCheck, selectedGpuModels: string[]) {
  const probes = check === 'gpu'
    ? [
      { label: 'KVM', probe: report.checks.kvm },
      { label: 'IOMMUFD', probe: report.checks.iommufd },
      { label: 'NVIDIA GPU', probe: report.gpus.nvidia },
      { label: 'EROFS utilities', probe: report.checks.erofs },
    ]
    : [{ label: check.toUpperCase(), probe: report.checks[check] }]
  const unmet = probes.filter(({ probe }) => probe.status !== 'yes')
  const modelNeeded = check === 'gpu' &&
    selectedGpuModels.length > 0 && report.gpus.nvidia.status === 'yes' &&
    !selectedGpuModels.some((model) => hasGpuModel(report, model))
  const reasons = unmet.map(({ label, probe }) =>
    check === 'se' && report.node.architecture !== 's390x'
      ? 'S390X required'
      : shortReason(label, probe.status, probe.reason))
  if (modelNeeded) reasons.push(report.gpus.devices.length === 0
    ? 'GPU model unconfirmed'
    : `${selectedGpuModels.join(' or ')} not found`)
  return {
    ready: unmet.length === 0 && !modelNeeded,
    reason: reasons.join(' · '),
  }
}

export function NodePrecheckPanel({
  nodeReports,
  error,
  onFiles,
  onClear,
  selectedChecks,
  setSelectedChecks,
  selectedGpuModels,
  setSelectedGpuModels,
}: {
  nodeReports: Array<{ name: string; report: NodePrecheck }>
  error: string
  onFiles: (files: FileList | null) => void
  onClear: () => void
  selectedChecks: RequestedCheck[]
  setSelectedChecks: Dispatch<SetStateAction<RequestedCheck[]>>
  selectedGpuModels: string[]
  setSelectedGpuModels: Dispatch<SetStateAction<string[]>>
}) {
  const [copied, setCopied] = useState(false)
  const [nodeQuery, setNodeQuery] = useState('')
  const [page, setPage] = useState(0)
  const chartVersion = packageData.version
  const command = precheckCommand(chartVersion)
  const upload = (label: string) => <label className="precheck-upload"><Upload size={14} /> {label}
    <input type="file" accept=".json,application/json" multiple onChange={(event) => {
      onFiles(event.target.files)
      event.target.value = ''
      setNodeQuery('')
      setPage(0)
    }} />
  </label>
  const unsupportedCount = nodeReports.filter(({ report }) => report.checks.kvm.status === 'no').length
  const activeChecks = readinessChecks.filter(({ id }) => selectedChecks.includes(id))
  const evaluatedNodes = nodeReports.map(({ name, report }) => {
    const failedChecks = activeChecks.flatMap(({ id, label }) => {
      const result = readinessResult(report, id, selectedGpuModels)
      return result.ready ? [] : [{ id, label, reason: result.reason }]
    })
    return {
      name,
      report,
      failedChecks,
      needsAttention: report.checks.kvm.status === 'no' || failedChecks.length > 0,
    }
  })
  const attentionCount = evaluatedNodes.filter(({ needsAttention }) => needsAttention).length
  const hasFailures = selectedChecks.length > 0 ? attentionCount > 0 : unsupportedCount > 0
  const matchingNodes = evaluatedNodes.filter(({ name, needsAttention }) =>
    needsAttention && name.toLowerCase().includes(nodeQuery.trim().toLowerCase()))
  const pageCount = Math.max(1, Math.ceil(matchingNodes.length / pageSize))
  const visibleNodes = matchingNodes.slice(page * pageSize, (page + 1) * pageSize)
  const modelCoverage = selectedGpuModels.map((model) => ({
    model,
    found: nodeReports.filter(({ report }) => hasGpuModel(report, model)).length,
    unconfirmed: nodeReports.some(({ report }) =>
      report.gpus.nvidia.status !== 'no' && report.gpus.devices.length === 0),
  }))
  const checkSelector = <fieldset className="precheck-tee-choice">
    <legend>Checks (all required on each node)</legend>
    <div className="precheck-choice-options">
      {readinessChecks.map(({ id, label }) => <label key={id}>
        <input type="checkbox" checked={selectedChecks.includes(id)} onChange={(event) => {
          setSelectedChecks((current) => event.target.checked
            ? [...current, id]
            : current.filter((selected) => selected !== id))
          setPage(0)
        }} />
        {label}
      </label>)}
    </div>
  </fieldset>
  const modelSelector = selectedChecks.includes('gpu') &&
    <details className="precheck-model-details">
      <summary>GPU models (any match) <strong>{selectedGpuModels.length > 0 ? selectedGpuModels.join(', ') : 'Any model'}</strong></summary>
      <fieldset className="precheck-model-choice" aria-label="NVIDIA GPU models">
        <div className="precheck-choice-options">
          {gpuModels.map((model) => <label key={model}>
            <input type="checkbox" checked={selectedGpuModels.includes(model)} onChange={(event) => {
              setSelectedGpuModels((current) => event.target.checked
                ? [...current, model]
                : current.filter((selected) => selected !== model))
              setPage(0)
            }} />
            {model}
          </label>)}
        </div>
      </fieldset>
    </details>

  if (nodeReports.length > 0) return <section className={`node-precheck node-precheck-loaded${hasFailures ? ' precheck-has-failures' : selectedChecks.length > 0 ? ' precheck-all-pass' : ''}`} aria-label="Pre-flight results">
    <div className="precheck-loaded-main">
      {hasFailures ? <CircleAlert size={16} aria-hidden="true" /> : selectedChecks.length > 0 && <Check size={16} aria-hidden="true" />}
      <strong>Pre-flight results</strong>
      <span>{nodeReports.length} {nodeReports.length === 1 ? 'node' : 'nodes'} checked</span>
      {selectedChecks.length > 0
        ? attentionCount > 0
          ? <span className="precheck-unsupported-count">· {attentionCount} failing</span>
          : <span className="precheck-passed-count">· All nodes passed</span>
        : unsupportedCount > 0 && <span className="precheck-unsupported-count">· {unsupportedCount} UNSUPPORTED</span>}
      <div className="precheck-loaded-actions">{upload('Replace JSON')}<button type="button" onClick={() => {
        setNodeQuery('')
        setPage(0)
        onClear()
      }}>Clear</button></div>
    </div>
    <details className="precheck-report-details">
      <summary>Nodes</summary>
      <div className="precheck-report-content">
      {checkSelector}
      {modelSelector}
      {selectedChecks.includes('gpu') && modelCoverage.length > 0 && <div className="precheck-model-coverage" aria-label="Selected NVIDIA GPU model coverage">
        {modelCoverage.map(({ model, found, unconfirmed }) => <span key={model} className={found > 0 ? 'precheck-model-found' : undefined}>
          <strong>{model}</strong> {found > 0
            ? `found on ${found} ${found === 1 ? 'node' : 'nodes'}`
            : unconfirmed ? 'not confirmed' : 'not found'}
        </span>)}
      </div>}
      {selectedChecks.length === 0 && <p className="precheck-select-prompt">Select a check to see node readiness.</p>}
      {selectedChecks.length > 0 && <>
        {attentionCount > 0 && <div className="precheck-list-controls">
          <span>{nodeReports.length - attentionCount} passing · Showing only failing nodes</span>
          <label className="precheck-node-search">Find failing node <input type="search" value={nodeQuery} placeholder="Node name" onChange={(event) => {
            setNodeQuery(event.target.value)
            setPage(0)
          }} /></label>
        </div>}
        {attentionCount === 0 && <div className="precheck-success" role="status">
          <Check size={17} aria-hidden="true" />
          <strong>All nodes passed</strong>
        </div>}
        {attentionCount > 0 && matchingNodes.length === 0 && <p className="precheck-empty-results">No failing nodes match this name.</p>}
        {matchingNodes.length > 0 && <ul className="precheck-node-list">{visibleNodes.map(({ name, report, failedChecks }) => {
          const blockers = report.checks.kvm.status === 'no' ? ['KVM unavailable'] : []
          return <li key={name}>
            <strong className="precheck-node-name">{name}</strong>
            <small className="precheck-node-architecture">{report.node.architecture}</small>
            {blockers.length > 0
              ? <span className="precheck-node-unsupported"><b>UNSUPPORTED</b><small>{blockers.join(' · ')}</small></span>
              : <span className="precheck-tee-results">{failedChecks.map(({ id, label, reason }) =>
                <span className="precheck-tee-result" key={id}>
                  <strong>{label}</strong><b className="precheck-tee-no">NO</b><small>{reason}</small>
                </span>
              )}</span>}
          </li>
        })}</ul>}
        {matchingNodes.length > pageSize && <nav className="precheck-pagination" aria-label="Node result pages">
          <span>Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, matchingNodes.length)} of {matchingNodes.length}</span>
          <button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>Previous</button>
          <span>Page {page + 1} of {pageCount}</span>
          <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</button>
        </nav>}
      </>}
      </div>
    </details>
    {error && <p className="precheck-error" role="alert">{error}</p>}
  </section>

  return <details className="node-precheck">
    <summary><strong>Unsure what to choose or what your nodes support?</strong></summary>
    <div className="node-precheck-content">
      <div className="precheck-step">
        <span className="precheck-step-number" aria-hidden="true">1</span>
        <div>
          <strong>Choose nodes</strong>
          <p>Label the Linux nodes to check <code>krab/preflight=true</code>.</p>
        </div>
      </div>
      <div className="precheck-step">
        <span className="precheck-step-number" aria-hidden="true">2</span>
        <div className="precheck-step-body">
          <div className="precheck-step-heading">
            <strong>Run the check</strong>
            <span>Use a terminal with Helm and kubectl access to the cluster.</span>
          </div>
          <div className="precheck-command">
            <pre>{command}</pre>
            <button type="button" onClick={() => {
              void navigator.clipboard.writeText(command).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              })
            }}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy command'}
            </button>
          </div>
        </div>
      </div>
      <div className="precheck-step precheck-upload-step">
        <span className="precheck-step-number" aria-hidden="true">3</span>
        <div>
          <strong>Upload the result</strong>
          <p>Add <code>krab-precheck.json</code> to show what the nodes support.</p>
        </div>
        {upload('Choose JSON')}
      </div>
      {error && <p className="precheck-error" role="alert">{error}</p>}
    </div>
  </details>
}
