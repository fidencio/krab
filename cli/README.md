# KRAB CLI

The native Rust interface to Kata Reference Architecture Builder.
The binary embeds the same pinned catalog, chart version, and values schema as
the web builder. Configuration validation and values generation run offline;
The browser compiles the same Rust configuration engine to WebAssembly.
Node.js is only needed for website development and comparison tests.

## Download and install

The [website guide](https://kata-containers.github.io/krab/#docs) includes installation,
keyboard controls, CLI examples, and captioned video walkthroughs.

Use the [website downloads](https://kata-containers.github.io/krab/#cli) for binaries
matching that website, or choose a version from [GitHub releases](https://github.com/kata-containers/krab/releases).
Download the archive for the computer running KRAB (Linux amd64/arm64 or macOS
Apple Silicon) and the release's `SHA256SUMS`. The cluster may use different
architectures. For example, for Linux amd64, replacing VERSION with your release:

```sh
sha256sum --ignore-missing --check SHA256SUMS
tar -xzf krab-VERSION-linux-amd64.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 0755 krab "$HOME/.local/bin/krab"
export PATH="$HOME/.local/bin:$PATH"
krab --version
krab
```

On macOS use `shasum -a 256 krab-VERSION-darwin-arm64.tar.gz` and compare the digest with `SHA256SUMS` before extraction.
Archives include `BUILD-INFO.json` with the source revision and catalog digest,
an executable checksum, license, this guide, and Bash/Zsh/Fish completions.
GitHub build provenance is attached to the release archives.
Linux binaries are statically linked with musl; Rust and Node.js are not needed.
Local probes require Linux. Configuration works offline on Linux and macOS.

Windows ARM64 and x86_64 support is planned as a follow-up; Windows binaries are
not included in this release.

The Next website points to development artifacts from successful Native CLI runs.
Those artifacts require GitHub sign-in and are separate from stable release downloads.

## Continue from the website

Click **Continue in TUI / CLI** next to the generated values to download
`krab.json`. Every selected setting is retained:

```sh
krab edit --config krab.json
krab generate --config krab.json --output values.yaml
```

Use the matching release of the CLI and website. Generated CLI `values.yaml`
can also be loaded through the website's **Load previous deployment** action.

## Build and use

From the repository root, with Rust 1.95 or newer installed:

```sh
cargo build --release --locked --manifest-path cli/Cargo.toml
./cli/target/release/krab --help
./cli/target/release/krab init
./cli/target/release/krab validate --config krab.yaml
./cli/target/release/krab generate --config krab.yaml --output values.yaml
```

Run `krab` with no arguments to open the Ratatui editor. It loads `krab.yaml`
when present and starts a new configuration otherwise. Explicit commands remain
available for scripts and automation.

```sh
krab
krab init
krab edit --config krab.yaml
krab edit --config krab.yaml --output another-cluster.yaml
krab edit --config krab.yaml --advanced
```

`init` collects the deployment path, target architectures, and Kubernetes
distribution, then opens the overview. `edit` opens the overview immediately
with the file's current configuration. Both commands use the same editor and
retain existing component switches, proxies, snapshotter settings, and chart
overrides.

The terminal interface uses Ratatui and Crossterm, with a persistent live
configuration panel and validation status. The original webpage logo appears as
a small image beside KRAB in the header when the terminal supports inline
graphics (Kitty, iTerm2, or Sixel). Text-only terminals show the KRAB title.
Product profiles can apply their `theme.light` / `theme.dark` colours to the
editor and cluster-check screens. Terminal background detection chooses the
palette, with `COLORFGBG` as a fallback and dark as the default. Override it with
`KRAB_THEME=light`, `KRAB_THEME=dark`, or `KRAB_THEME=auto`. Omitted colours keep
the terminal defaults or inherit the supplied page/text colours. No palette keeps
the existing appearance. Restart after editing the profile. This mapping is newer
than 0.3.0; use a development build until the next release.
A local PNG `logo` is resolved beside the profile and shown on graphics-capable
terminals. Remote URLs and unsupported formats keep the product's text heading.

Arrow keys navigate; Space toggles
checkboxes; Enter confirms a section. Single-choice menus preview the highlighted
value. Selections and typed changes update the summary and validation immediately.
Single selections use radio buttons `(*)`/`( )`; multiple selections use
checkboxes `[x]`/`[ ]`. Space only toggles checkboxes. Press `?` for help with
the current screen, or F1 anywhere. In text fields, `?` types normally and F1
opens help. Enter or Esc closes help without changing your selection or draft.
GPU profiles automatically select their required runtimes, marked `[A]` in the
runtime picker. Pending hardware and incompatible choices are excluded.

The overview starts with Node pre-check and Cluster conformance, followed by a
KRAB configuration divider and deployment path, architecture, distribution, runtime, GPU,
Helm chart SELinux policy, advanced, release, and namespace sections. You can revisit sections in
any order, validate, preview generated Helm values, save, or exit. Press `s` to
save, `p` to preview, or `q` to exit from the overview. Exiting with unsaved changes
asks whether to discard them. Esc cancels a section and restores its earlier
settings; Esc from Advanced or Preview returns to the overview.

The Helm chart SELinux policy setting loads policy for Kata's installer
containers on SELinux-enforcing nodes. It does not enable host SELinux or
change SELinux confinement for guest workloads. It is stored as `selinux` in
`krab.yaml`; press `?` in its picker for the explanation.

Text fields support cursor movement, Backspace/Delete, Home/End, and Ctrl+U to
clear. Typing initially replaces the displayed value; move the cursor first to
edit within it. In the YAML overrides editor, Enter adds a line and Ctrl+S
confirms. Pasting multiline YAML is supported. The interface needs at least
65 columns and 24 rows; resizing redraws it.

## Advanced configuration

Use the Advanced section, or `--advanced` with either `init` or `edit`, to go
directly to advanced settings. On `edit`, basic selections remain unchanged;
on `init`, the vendor/distribution/architecture flags determine the starter
configuration. Advanced settings include:

- Components: automatic, enabled, or disabled for NFD, Kata deploy, the device
  plugin, provisioner, and TDX QGS.
- Runtime: HTTPS/no-proxy settings, NVIDIA DCGM, EROFS mode and disk size,
  dm-verity, fs-verity, and utility installation.
- Chart overrides: an editable YAML mapping, including custom runtime
  definitions and lower-level upstream Helm settings.

Flags such as `--vendor nvidia`, `--distribution k3s`, and `--architecture arm64`
set the starter defaults. The target architecture describes cluster nodes,
independently of the machine running the CLI.

### Website advanced settings

The **Website advanced settings (YAML)** entry in the TUI exposes the remaining
website advanced settings as a typed YAML mapping. The same mapping is accepted
under `advanced` in configuration files; unknown fields are rejected. Component
and EROFS switches retain their dedicated controls above. Supported keys are:

- `qgs`: `mode`, `pcsApiKeySecretName`, and nullable `deploySgxPlugin`.
- `containerdConfigDir`, `containerdRuntimeSocket`, `containerdConfigFileName`,
  `containerdUserDropIn`, and `shimDropIns` (runtime ID to TOML text).
- `customRuntimes`: `name`, `baseConfig`, `dropIn`, `runtimeClass`, optional
  `crioPullType` and `inheritBaseOverhead` for each runtime.
- `nodeSelector` (key/value rows), `nodeAffinity` (key/operator/values rows),
  and `tolerations` (key/operator/value/effect rows).
- `continuousConformance`, `scheduledReconcileEnabled`, `scheduledReconcileSchedule`, and `debug`.
- `erofsUtilsImage` for a custom utility image.
- `images`: `kataDeploy`, `nfd`, `devicePlugin`, `provisioner`; each accepts
  `reference`, `tag`, `pullPolicy`, `pullSecrets`, `dispatcherReference`, and
  `dispatcherTag`. Kata deploy also accepts `kubectlReference` and `kubectlTag`.

The website's **Continue in TUI / CLI** export fills this mapping for you. Both
builders use the same defaults and value-generation behavior. Containerd path
and user drop-in overrides apply to kubeadm, as on the website. Low-level
`valuesOverrides` are applied last and validated against the chart schema.

## Save and automate

Saving validates the configuration, prompts for a destination, and asks for
confirmation. If a separate destination already exists, choose another filename;
Ctrl+U clears the filename field. You can use `~/krab.yaml` when the current
directory is read-only. `edit` can save back to its source after confirmation;
`--force` permits replacing a different existing destination.

Edits use atomic file replacement, retain source permissions, and refuse to
replace a source changed while the editor was open. An unchanged save leaves
the file untouched, including comments. Changed configurations are serialized
as YAML, replacing their formatting and comments. Cancelling, discarding, or
failing validation leaves the original file intact.

The UI renders on stderr and restores the terminal on exit. `--output -` emits
only configuration YAML on stdout. Scripts can create defaults without a UI:

```sh
krab init --non-interactive --architecture amd64 --output krab.yaml
krab validate --config krab.yaml
krab generate --config krab.yaml --output values.yaml --force
```

Explicit noninteractive commands work independently of the terminal editor.
With redirected stdin/stderr, `--interactive` permits the text section editor
for scripted answers: select menu options by number or ID, separate multiple
selections with commas, use `back` within a section to revisit its previous
question, and `q` to cancel the section. In this fallback YAML editor, finish a
replacement mapping with a line containing only `.`; an empty block keeps it,
and `none` followed by `.` clears it.

The implementation targets Linux and macOS. Host probes require Linux; offline
generation and remote cluster conformance can run on either. GPU host probes
also need the pinned kata-device-provisioner executable described in
[preflight](../preflight/README.md).

The `Native CLI` workflow tests and packages all three host platforms. The release
workflow requires these builds and CLI/web values parity before publishing the
archives alongside the chart and website in the same versioned GitHub release.

## NVIDIA CPU TDX / SNP

Select **NVIDIA CPU TDX** or **NVIDIA CPU SNP** in the website’s runtime choices,
or in the terminal editor. These CPU-only profiles do not require a GPU.

```sh
krab init --non-interactive --runtime qemu-nvidia-cpu-tdx-runtime-rs --output krab.yaml
krab generate --config krab.yaml --output values.yaml
krab install --config krab.yaml --context my-cluster
```

Use `qemu-nvidia-cpu-snp-runtime-rs` for SNP; repeat `--runtime` to select both.
Review the printed plan, then add `--execute` to deploy. TDX selects QGS
automatically. CPU-only selections do not enable GPU provisioning.

KRAB prepares profiles automatically on each node after Kata installs its
artifacts, before CRI registration. The shared Rust implementation derives the
CPU profile from the installed, matching NVIDIA confidential GPU reference:
it keeps the confidential kernel, firmware, CoCo extension and integrity
metadata, CPU TEE selectors and extended resource, inherited overhead, Nydus,
and CRI-O guest-pull settings. It removes the GPU guest extension and DCGM boot
argument. No Python helper, profile upload, or existing deployment is required.

These are experimental KRAB profiles using Kata’s custom runtime support,
not new upstream shim names. Kata may stage the GPU extension artifact, but the
CPU profile does not attach it to its guest. Validate guest boot and attestation
on compatible TDX/SNP hosts before running workloads.

## Discover choices

```sh
krab list vendors
krab list distributions
krab list runtimes --vendor custom
krab list hardware --vendor nvidia --json
krab list catalog --json
```

Identifiers come directly from the embedded catalog. Hardware JSON includes
mode IDs, supported CPU TEEs, architectures, model names, and publication status.
Pending hardware cannot be selected. JSON catalog output retains source links
and upstream versions.

## Configuration

Configuration files accept YAML or JSON. The initial contract is
`apiVersion: krab/v1alpha1`; unknown configuration fields are rejected.

```yaml
apiVersion: krab/v1alpha1
vendor: custom
distribution: kubeadm
release: krab
namespace: kata-system
architectures: [amd64]
selinux: false
runtimes: [qemu-runtime-rs]
```

For NVIDIA GPU workloads, select hardware profiles and their modes. For example:

```yaml
apiVersion: krab/v1alpha1
vendor: nvidia
distribution: kubeadm
architectures: [amd64]
hardware:
  hopper:
    mode: ppcie
    cpuTees: [tdx]
```

Use `krab list hardware --vendor nvidia --json` to check available family IDs
for the binary's catalog. `off` means passthrough and accepts no CPU TEEs;
confidential modes require at least one compatible CPU TEE. Multiple families
and TEEs are supported, and their required runtime shims are selected automatically.

Optional `components` keys are `nfd`, `kataDeploy`, `devicePlugin`, `provisioner`,
and `qgs`. Each accepts a boolean or null. Null uses the builder's automatic
selection: NFD and Kata deploy are enabled, GPU components follow hardware
selection, and TDX QGS follows the selected TDX runtimes.

Optional `runtime` settings are `httpsProxy`, `noProxy`, `nvidiaDcgm`,
`erofsMode` (`memory` or `disk`), `erofsDiskSize` (default `256M`),
`erofsDmverity` (default true), `erofsFsverity`, and `installErofsUtils`.

Use `valuesOverrides` for lower-level chart configuration such as image pins,
node selectors, tolerations, custom runtimes, and containerd drop-ins:

```yaml
valuesOverrides:
  kata-deploy:
    debug: true
    nodeSelector:
      pool: kata
```

Overrides merge recursively into generated mappings; lists and scalars replace
their generated values. Overrides can also change selection-derived fields.
The final result is checked against the embedded KRAB umbrella chart schema.
That schema deliberately permits additional upstream fields within subcharts;
it does not validate every nested upstream option or certify hardware readiness.

`generate` writes commented, versioned YAML by default. `--json` emits plain
Helm-compatible JSON. `--config -` reads stdin; `--output -` or no output flag
writes stdout. File writes fail if the destination exists unless `--force` is
supplied. `validate --json` emits a success object; errors go to stderr.

## Deploy

Review the generated values or the JSON execution plan first:

```sh
krab install --config krab.yaml --context test-cluster
krab install --config krab.yaml --context test-cluster --execute
```

The second command invokes Helm directly, passes values through stdin, and
pins the chart version embedded in the binary. Helm must be installed and the
named Kubernetes context must be configured. The first command only prints
the executable, argument array, and values that would be passed to Helm.

## Preflight and conformance

The TUI starts with **Node pre-check** and **Cluster conformance**. Choose a
kubeconfig (blank uses `KUBECONFIG` or `~/.kube/config`) and a context. The editor
lists Linux nodes for a node pre-check, or accepts a label selector for cluster
conformance. It verifies that the target inventory is accessible before offering
a reviewed Helm run. These actions preserve the current configuration draft.

Conformance starts with KVM as the baseline requirement. Add one CPU TEE policy
and/or GPU requirements as needed; EROFS is optional. Results initially show only
failed/error nodes. Select a node to read its reasons; `f` switches between failed
and all nodes, PgUp/PgDn scroll details, and `e` exports the complete JSON evidence.
Esc cancels local collection; the pre-check Helm release and any running cluster
Jobs remain available for inspection. Pre-check reports describe capabilities without assigning a conformance verdict.

The same operations are available as commands:

```sh
# Local Linux host probes; no kubeconfig required.
krab precheck --json --kvm --tdx

# Fresh probes on one Kubernetes node (the name need not match its hostname label).
krab precheck --node worker-1 --context test-cluster \
  --kubeconfig ~/.kube/config --output node-precheck.json

# Cluster conformance with a clean list of failed/error nodes and reasons.
krab conformance --run --context test-cluster --require kvm --failed-nodes
krab conformance --run --context test-cluster --require tdx --require gpu-cc \
  --failed-nodes --output verdict.json
krab conformance --report krab-precheck.json --require snp --failed-nodes
```

Remote runs require `kubectl`, Helm, and a usable kubeconfig with permission to
list nodes and install the pre-check chart. The selected context and optional
`--kubeconfig` are passed to both tools. `--node-selector` restricts remote scope;
`--chart`, `--version`, `--namespace`, and `--release` customize collection.
The `--failed-nodes` text view omits passing nodes and probe detail unrelated to
failures; `--json` and `--output` retain the full verdict and evidence.
On Linux, host daemon installation requires a separate checker artifact:

```sh
sudo krab conformance install --checker /path/to/krab-preflight \
  --checker-sha256 "$CHECKER_SHA256" --require kvm
```

The full CLI never defaults to installing itself as `krab-preflight`.
Standalone `krab-preflight conformance install` can install its own executable.

Host probes and conformance retain the existing [preflight semantics](../preflight/README.md).
These checks establish host prerequisites, not workload launch or attestation.

Exit codes are 0 for success, 1 for failed host checks or nonconformance, and 2
for invalid configuration, command, evidence, I/O, or deployment errors. A
successful `validate` only establishes configuration validity, not cluster
conformance or successful workload launch.

Generate completions with `krab completions bash`, `krab completions zsh`, or
`krab completions fish`.

## Development

```sh
cargo fmt --check --manifest-path cli/Cargo.toml
cargo test --locked --manifest-path cli/Cargo.toml
cargo test --locked --manifest-path preflight/Cargo.toml
cargo build --locked --manifest-path cli/Cargo.toml
python3 cli/tests/terminal.py cli/target/debug/krab
npm run build:core
npm run test:cli-parity
```

Set `KRAB_CLI_BINARY` when the binary is at another path. The comparison test
checks generated values against the TypeScript builder across available
runtimes, hardware modes, CPU TEE combinations, distributions, and both EROFS
modes. Catalog changes are therefore checked against both implementations.
`npm run generate` synchronizes CLI and preflight versions from `package.json`.

Next milestones are importing existing builder values, using node reports
during configuration, structured JSON errors, and
package-manager distribution. The experimental controller remains
separate from this CLI.
