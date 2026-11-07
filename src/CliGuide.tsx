import { Download, ExternalLink, Terminal } from 'lucide-react'

const repository = 'https://github.com/fidencio/krab'
const platforms = [
  ['Linux · x86_64', 'linux-amd64'],
  ['Linux · ARM64', 'linux-arm64'],
  ['macOS · Apple Silicon', 'darwin-arm64'],
] as const

export function CliGuide({ version, development }: { version: string; development: boolean }) {
  const release = `${repository}/releases/tag/chart-v${version}`
  const assets = `${repository}/releases/download/chart-v${version}`
  return <section className="cli-guide" id="cli" aria-labelledby="cli-title">
    <div className="cli-guide-heading">
      <Terminal size={23} aria-hidden="true" />
      <div>
        <h2 id="cli-title">KRAB in your terminal</h2>
        <p>Use the TUI / CLI for node pre-checks, cluster conformance, node selectors,
          and filtering failed nodes. Configure and generate values offline with the
          same pinned catalog and chart as this website.</p>
      </div>
    </div>
    {development ? <p>This is the Next builder. <a href={`${repository}/actions/workflows/cli.yml`}>
      Get matching development builds <ExternalLink size={13} /></a> from a successful
      Native CLI run (GitHub sign-in required), or <a href={`${repository}/releases/latest`}>
      download the latest stable release</a> and use its matching website.</p> : <>
      <div className="cli-downloads" aria-label={`Download KRAB ${version}`}>
        {platforms.map(([label, platform]) => <a key={platform}
          href={`${assets}/krab-${version}-${platform}.tar.gz`}>
          <Download size={15} aria-hidden="true" />{label}
        </a>)}
      </div>
      <p className="cli-release-links">Version {version} · <a href={`${assets}/SHA256SUMS`}>SHA256 checksums</a>
        {' · '}<a href={release}>All release assets</a></p>
    </>}
    <details>
      <summary>Install, configure, and check your cluster</summary>
      <p>Download the archive for the machine running KRAB. The target cluster can use
        different architectures. Extract it, verify its checksum against SHA256SUMS,
        and install the binary in your PATH. For example, on Linux x86_64:</p>
      <pre><code>{`sha256sum --ignore-missing --check SHA256SUMS
tar -xzf krab-${version}-linux-amd64.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 0755 krab "$HOME/.local/bin/krab"
export PATH="$HOME/.local/bin:$PATH"
krab`}</code></pre>
      <p>On macOS, verify the archive with <code>shasum -a 256</code>.
        Use “Continue in TUI / CLI” next to the generated values to save
        all website settings in <code>krab.json</code>, then run <code>krab edit --config krab.json</code>.
        Run <code>krab</code> to start a new configuration in the interactive editor. Arrow keys navigate,
        Space toggles, Enter confirms, and F1 opens help. Save a configuration as
        <code> krab.yaml</code>, then generate your Helm values:</p>
      <pre><code>{`krab validate --config krab.yaml
krab generate --config krab.yaml --output values.yaml
krab install --config krab.yaml --context my-cluster
# Apply the reviewed plan:
krab install --config krab.yaml --context my-cluster --execute`}</code></pre>
      <p>The first two TUI actions are Node pre-check and Cluster conformance.
        For scripted checks and a filtered list of failed nodes:</p>
      <pre><code>{`krab precheck --node worker-1 --context my-cluster --output node.json
krab conformance --run --context my-cluster --require kvm --failed-nodes
krab conformance --run --context my-cluster --require tdx \\
  --node-selector pool=confidential --failed-nodes --output verdict.json`}</code></pre>
      <p>Remote checks need Helm, kubectl, and a kubeconfig with permission to list
        nodes and install the pre-check chart. Offline configuration needs neither.
        Host probes run on Linux; configuration and remote checks also run on macOS.
        Conformance checks host prerequisites; workload launch and attestation need
        separate validation.</p>
      <p><a href={`${repository}/blob/${development ? 'main' : `chart-v${version}`}/cli/README.md`}>
        Full CLI / TUI documentation <ExternalLink size={13} /></a></p>
    </details>
  </section>
}
