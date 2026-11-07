import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Download, ExternalLink } from 'lucide-react'
import { cliArchiveUrl, cliAssetBase, cliPlatforms, cliRepository } from './lib/cli-release'
import recordings from './generated/walkthroughs.json'
import './Documentation.css'

const sections = [
  ['start', 'Start here'], ['install', 'Install KRAB'], ['website', 'Use the website'],
  ['tui', 'Use the terminal editor'], ['cli', 'Automate with the CLI'],
  ['checks', 'Check your nodes'], ['reference', 'Command reference'],
] as const
const shortcuts = [
  ['↑ / ↓', 'Move between choices and sections'], ['Space', 'Toggle a checkbox'],
  ['Enter', 'Confirm a choice or open a section'], ['Esc', 'Cancel a section and restore its previous settings'],
  ['F1', 'Open help from any screen'], ['s', 'Save from the overview'],
  ['p', 'Preview generated values from the overview'], ['q', 'Exit from the overview'],
  ['Ctrl + S', 'Confirm a multiline YAML edit'],
]

function Command({ children }: { children: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="docs-command"><pre><code>{children}</code></pre>
    <button type="button" aria-label="Copy command" onClick={async () => {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button>
  </div>
}

function Walkthrough({ name }: { name: keyof typeof recordings }) {
  const recording = recordings[name]
  const base = `${import.meta.env.BASE_URL}walkthroughs/${name}`
  return <figure className="docs-walkthrough">
    <video controls playsInline preload="none" poster={`${base}.png`} aria-label={recording.title}>
      <source src={`${base}.webm`} type="video/webm" />
      <track kind="captions" src={`${base}.vtt`} srcLang="en" label="English" default />
      <p>Your browser cannot play this recording. Read the transcript below.</p>
    </video>
    <figcaption>{recording.title} · {recording.duration}s · Recorded with {recording.version}</figcaption>
    <details><summary>Read the walkthrough</summary><ol>{recording.steps.map((step, index) =>
      <li key={index}>{step.caption}{step.keys && <> <kbd>{step.keys}</kbd></>}</li>)}</ol></details>
  </figure>
}

export function Documentation({ version, development }: { version: string; development: boolean }) {
  const [platform, setPlatform] = useState<string>('linux-amd64')
  const [activeSection, setActiveSection] = useState(window.location.hash.slice(1) || 'docs/start')
  const archive = `krab-${version}-${platform}.tar.gz`
  const source = `${cliRepository}/blob/${development ? 'main' : `chart-v${version}`}`
  useEffect(() => {
    const jump = () => requestAnimationFrame(() => {
      const id = window.location.hash.slice(1)
      setActiveSection(id === 'docs' ? 'docs/start' : id)
      if (id !== 'docs') document.getElementById(id)?.scrollIntoView({ behavior: 'instant', block: 'start' })
      else window.scrollTo({ top: 0, behavior: 'instant' })
    })
    jump()
    window.addEventListener('hashchange', jump)
    return () => window.removeEventListener('hashchange', jump)
  }, [])
  return <div className="docs-layout">
    <aside className="docs-sidebar">
      <a className="docs-back" href="#builder"><ArrowLeft size={14} /> Back to builder</a>
      <nav aria-label="Documentation sections">
        {sections.map(([id, label]) => <a key={id} href={`#docs/${id}`} aria-current={activeSection === `docs/${id}` ? 'location' : undefined}>{label}</a>)}
      </nav>
      <small>{development ? 'Next documentation' : `KRAB ${version}`}</small>
    </aside>
    <article className="docs-content">
      <header className="docs-hero" id="docs/start">
        <span className="docs-eyebrow">KRAB guide</span>
        <h1>Get started with KRAB.</h1>
        <p>Build your configuration in the browser or your terminal. Both use the same
          pinned catalog and generate the same Helm values.</p>
        <div className="docs-paths">
          <a href="#docs/website"><strong>I’m using the website</strong><span>Choose a path, configure, and download values.</span><ArrowRight size={16} /></a>
          <a href="#docs/tui"><strong>I prefer a terminal</strong><span>Use the interactive editor and inspect your nodes.</span><ArrowRight size={16} /></a>
          <a href="#docs/cli"><strong>I’m automating this</strong><span>Validate and generate values from a configuration file.</span><ArrowRight size={16} /></a>
        </div>
      </header>

      <section id="docs/install">
        <h2>Install KRAB</h2>
        <p>Choose the computer you’ll run KRAB on. Your cluster’s node architectures
          are a separate choice you make during configuration.</p>
        <div className="docs-platforms" role="group" aria-label="Your computer">
          {cliPlatforms.map(({ label, id }) => <button key={id} type="button"
            aria-pressed={id === platform} onClick={() => setPlatform(id)}>{label}</button>)}
        </div>
        {development ? <p className="docs-note">This is the Next documentation. Matching development builds
          are available from a successful <a href={`${cliRepository}/actions/workflows/cli.yml`}>Native CLI run</a>
          {' '}(GitHub sign-in required). For a stable binary, use the <a href={`${import.meta.env.BASE_URL}../#docs/install`}>stable website and its matching guide</a>.</p> : <p className="docs-download-row">
          <a className="docs-primary" href={cliArchiveUrl(version, platform)}><Download size={16} /> Download {archive}</a>
          <a href={`${cliAssetBase(version)}/SHA256SUMS`}>Download checksums</a>
        </p>}
        <ol className="docs-steps">
          <li><strong>Verify the download.</strong> Put the archive and SHA256SUMS in the same folder.
            {platform.startsWith('linux') ? <Command>sha256sum --ignore-missing --check SHA256SUMS</Command> : <>
              <Command>{`shasum -a 256 ${archive}`}</Command><p>Compare the printed digest with the matching line in SHA256SUMS.</p></>}
          </li>
          <li><strong>Extract and install it.</strong> Linux binaries are statically linked. Rust and Node.js aren’t needed.
            <Command>{`tar -xzf ${archive}
mkdir -p "$HOME/.local/bin"
install -m 0755 krab "$HOME/.local/bin/krab"
export PATH="$HOME/.local/bin:$PATH"`}</Command>
            <p>Add that PATH line to your shell configuration to keep it for new terminals.</p>
          </li>
          <li><strong>Open KRAB.</strong><Command>{`krab --version
krab`}</Command></li>
        </ol>
        <p>Windows ARM64 and x86_64 support is a follow-up. Today’s packages cover Linux and macOS ARM64.</p>
      </section>

      <section id="docs/website">
        <h2>Use the website</h2>
        <p>The builder takes you from a deployment path to files you can review and deploy.</p>
        <Walkthrough name="website" />
        <ol className="docs-steps">
          <li><strong>Choose a deployment path.</strong> Custom combines CPU runtimes and GPU profiles across node types.
            Vendor paths give you a focused starting point. “Load previous deployment” restores a KRAB values.yaml.</li>
          <li><strong>Describe your cluster.</strong> Select target architectures and your Kubernetes distribution,
            then choose runtimes and any GPU families, modes, and CPU TEEs. Required GPU runtimes are selected automatically.</li>
          <li><strong>Adjust what you need.</strong> Advanced deployment configuration includes components,
            QGS, containerd, custom runtimes, node scheduling, EROFS, images, and debug settings.</li>
          <li><strong>Review the result.</strong> The installation summary lists your RuntimeClasses.
            The Deploy section contains generated values and a version-pinned install command.
            Copy them or download the values file.</li>
          <li><strong>Continue in your terminal.</strong> “Continue in TUI / CLI” downloads krab.json with all
            your choices. Use the matching binary version to open it:
            <Command>krab edit --config krab.json</Command></li>
        </ol>
        <p className="docs-note">The release selector at the top opens archived builders. Next previews
          changes from main. Node report filtering lives in the TUI / CLI; the browser focuses on configuration.</p>
        <a className="docs-inline-link" href="#builder">Open the builder <ArrowRight size={14} /></a>
      </section>

      <section id="docs/tui">
        <h2>Use the terminal editor</h2>
        <p>Run <code>krab</code> to create a configuration. If krab.yaml exists, KRAB opens it.
          To edit another file, use <code>krab edit --config your-file.yaml</code>.</p>
        <Walkthrough name="tui" />
        <p>Setup asks for your deployment path, target architectures, and Kubernetes distribution.
          The overview lets you revisit sections in any order, with a live configuration panel and validation status.</p>
        <div className="docs-keyboard" aria-label="Keyboard controls">{shortcuts.map(([keys, action]) =>
          <div key={keys}><kbd>{keys}</kbd><span>{action}</span></div>)}</div>
        <p>Radio choices follow the highlighted entry. Space toggles checkboxes. In text fields,
          use arrow keys, Home/End, Backspace/Delete, or Ctrl+U to clear. F1 opens help even while typing.</p>
        <h3>Advanced settings and saving</h3>
        <p>Components, proxies, DCGM, and EROFS have dedicated controls. “Website advanced settings (YAML)”
          exposes the remaining website settings, including custom runtimes, QGS, scheduling, containerd, and images.
          Enter inserts a line; Ctrl+S confirms. The website export fills this mapping for you.</p>
        <p>Save writes a configuration file, not Helm values. KRAB validates before saving and asks you to confirm
          the destination. Exiting with unsaved changes asks whether to discard them. Changed files are serialized as YAML;
          unchanged saves preserve the original formatting and comments.</p>
        <Command>{`krab generate --config krab.yaml --output values.yaml`}</Command>
      </section>

      <section id="docs/cli">
        <h2>Automate with the CLI</h2>
        <p>Explicit commands work without the editor. Configuration and values generation run offline.</p>
        <Walkthrough name="cli" />
        <h3>Create, validate, generate</h3>
        <Command>{`krab init --non-interactive --architecture amd64 --output krab.yaml
krab validate --config krab.yaml
krab generate --config krab.yaml --output values.yaml`}</Command>
        <p>Use <code>--vendor</code> and <code>--distribution</code> with init for a different starting point.
          Configuration files accept YAML or JSON. <code>--config -</code> reads stdin;
          <code>--output -</code> writes stdout. Existing output files need an explicit <code>--force</code> to replace them.</p>
        <h3>Review, then deploy</h3>
        <Command>{`krab install --config krab.yaml --context my-cluster
# Apply only after reviewing the printed plan:
krab install --config krab.yaml --context my-cluster --execute`}</Command>
        <p>The first command prints the Helm arguments and generated values. The second runs Helm against
          the named context, pinned to the chart version in your binary. Install Helm and configure that context first.</p>
      </section>

      <section id="docs/checks">
        <h2>Check your nodes</h2>
        <p>In the TUI overview, choose “Node pre-check” or “Cluster conformance”. Select a kubeconfig
          and context, then a node or label selector. Review the collection plan before running it.</p>
        <p>Node pre-check reports capabilities. Conformance evaluates required capabilities and starts with
          KVM as the baseline. Add a CPU TEE and/or GPU requirements for your workload; EROFS is optional.</p>
        <Command>{`# Fresh checks on one node
krab precheck --node worker-1 --context my-cluster --output node.json

# Show only failed/error nodes across the selected pool
krab conformance --run --context my-cluster --require tdx \\
  --node-selector pool=confidential --failed-nodes --output verdict.json

# Evaluate evidence you already collected
krab conformance --report node.json --require kvm --failed-nodes`}</Command>
        <p>Remote checks need Helm, kubectl, and a kubeconfig allowed to list nodes and install the pre-check chart.
          Blank kubeconfig uses KUBECONFIG or ~/.kube/config. <code>--kubeconfig</code> selects a specific file.</p>
        <h3>Read the result</h3>
        <p>The TUI initially shows failed/error nodes. Select a node to see its reasons; press <kbd>f</kbd>
          to switch between failed and all nodes, PgUp/PgDn to scroll details, and <kbd>e</kbd> to export JSON evidence.</p>
        <div className="docs-verdicts">
          <p><strong>PASS</strong> The collected host evidence meets the requested policy.</p>
          <p><strong>FAIL</strong> At least one required capability did not pass.</p>
          <p><strong>ERROR</strong> Collection or evidence could not establish a verdict.</p>
        </div>
        <p className="docs-note">These checks establish host prerequisites. Workload launch and attestation need
          separate validation. Local host probes require Linux; configuration and remote checks also run on macOS.</p>
      </section>

      <section id="docs/reference">
        <h2>Keep these commands handy</h2>
        <div className="docs-reference">
          <code>krab</code><span>Open the interactive editor</span>
          <code>krab edit --config FILE</code><span>Edit a saved configuration</span>
          <code>krab list runtimes --json</code><span>Discover pinned runtime choices</span>
          <code>krab list hardware --vendor nvidia --json</code><span>Discover GPU families and modes</span>
          <code>krab validate --config FILE</code><span>Validate offline</span>
          <code>krab generate --config FILE</code><span>Print Helm values</span>
          <code>krab completions zsh</code><span>Generate shell completion definitions</span>
          <code>krab conformance --help</code><span>All conformance options</span>
        </div>
        <p>Exit codes: <strong>0</strong> success; <strong>1</strong> failed checks or nonconformance;
          <strong>2</strong> invalid configuration, collection, I/O, or deployment error.</p>
        <p className="docs-source">This guide and its recordings live in the KRAB repository.
          For the full configuration contract and development details:
          {' '}<a href={`${source}/cli/README.md`}>CLI source documentation <ExternalLink size={12} /></a>,
          {' '}<a href={`${source}/preflight/README.md`}>preflight reference <ExternalLink size={12} /></a>.
          You can follow the workflows above entirely on this website.</p>
      </section>
    </article>
  </div>
}
