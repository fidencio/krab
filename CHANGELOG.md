# Changelog

All notable changes to KRAB are documented in this file.

## [Unreleased]

## [0.3.1] - 2026-11-09

- Remove the KRAB logo after OpenInfra Foundation flagged it as a copyright
  infringement, including the favicon and website walkthrough imagery.

- Apply product light/dark colours to the TUI editor and cluster-check screens,
  detect terminal appearance, and support an explicit `KRAB_THEME` override.
- Load local profile PNG icons in graphics-capable terminals, including the
  shared CoCo website/TUI icon. Preserve the unprofiled terminal appearance.
- Preserve indexed terminal colours when recording walkthroughs and screenshots.

## [0.3.0] - 2026-11-08

### Changed

- Publish KRAB from `kata-containers/krab`, with website, release downloads,
  Helm charts, container images, attestations, and provenance using the Kata
  Containers organization.
- Move upstream pin maintenance to an external agent while retaining the manual
  discovery, verification, and generation commands.

### Added

- Runnable Confidential Containers product demo with configurable branding,
  colours, runtime choices, and shared website/CLI generation.
- Repository bootstrap instructions for Pages, publication, and project settings.

### Fixed

- Select a supported architecture when switching vendor paths under a product
  profile, including IBM Secure Execution on s390x.
- Keep filtered hardware defaults valid when changing architectures and hide
  empty NVIDIA CPU sections.
- Improve product header layout for longer names and descriptions.

## [0.2.11] - 2026-11-08

### Added

- Self-hosted static website and CLI product profiles with configurable branding,
  defaults, available runtimes and platforms, advanced controls, and KRAB attribution.
- Runtime-configurable light and dark website colours, a CoCo example profile,
  portable website artifacts, and on-site self-hosting documentation.
- Kubernetes smoke tests using Kata's own setup scripts for kubeadm, k0s, k3s,
  MicroK8s, and RKE2, including generic CPU, EROFS, and Nydus runtime coverage.
- Dependabot updates, Rust quality/security checks, reproducible CLI verification,
  and rendered deployment artifacts for pull requests.

### Changed

- Remove the experimental controller and its deployment integration.
- Update JavaScript, Rust, container, and GitHub Actions dependencies, with
  compatibility fixes and a patched fast-uri dependency.
- Use supported Node 26 LTS for the website container's build stage.

### Fixed

- Reject EROFS runtime selections on incompatible MicroK8s installations while
  keeping supported Nydus runtimes available.
- Recover from build-tool download outages through the release API and exact,
  locked wasm-bindgen source builds, retaining integrity checks and reproducible
  browser output.
- Fetch checksum-verified Syft assets through the release API for SBOM jobs.
- Allow Pages more time to synchronize immutable release builders.

## [0.2.10] - 2026-11-07

- Select NVIDIA CPU TDX and SNP directly in the website, TUI, and CLI. Prepare
  measured CPU profiles automatically in the node installation pipeline.
- Enable continuous node conformance with one deployment setting, including
  systemd setup, NFD discovery, runtime scheduling gates, and cleanup.
- Remove the manual CPU overlay import workflow from the normal deployment path.

## [0.2.9] - 2026-11-07

### Added

- Native CLI / TUI release downloads for Linux amd64/arm64 and macOS Apple
  Silicon, with checksums, completions, source metadata, and build provenance.
- On-site documentation for website navigation, installation, TUI / CLI, and
  conformance, with three captioned video walkthroughs and readable transcripts.
- Compact website download strip with links pinned to its release.
- Export website configurations to the terminal with every advanced setting,
  including QGS, custom runtimes, scheduling, containerd, and image overrides.
- Shared Rust configuration engine compiled natively for the CLI and to WebAssembly
  for the browser; defaults, validation, and values generation share one source.
- Command reference generated directly from actual CLI help output.
- NVIDIA CPU TDX/SNP overlay imports in the website and CLI, with the existing
  node-derived helper and guide included in release packages.
- Release publication requires passing native builds and CLI/web values parity.

### Changed

- Cross-compile preflight images on the builder CPU, cache Rust and container
  builds, and reuse verified CI binaries for the exact release commit.
- Retry temporary attestation-service failures before stopping publication.
- Use Node.js 24 actions throughout the build and release workflows.
- Improve walkthrough readability with closer UI capture and 1080p video encoding.
- Move node report uploads and readiness filters from the website to the TUI / CLI.
  The website recommends terminal conformance, node selectors, and failure views.

## [0.2.7] - 2026-11-05

### Added

- Continuous host conformance through an unprivileged systemd daemon, with
  restart and watchdog supervision, checker integrity verification, and
  expiring results for opt-in NFD node labels.
- Native Rust CLI and terminal editor for configuration, Helm values,
  deployment plans, pre-flight collection, and conformance checks.
- Static Linux amd64 and arm64 checker release archives, with executable
  checksums, source metadata, and build provenance for host installation.

## [0.2.6] - 2026-11-01

### Fixed

- Update kata-device-provisioner to 0.1.0-alpha.3 so supported noncoherent
  NVIDIA CC GPUs and NVSwitches can use generic VFIO without a device-specific
  module alias, including GPUs already in CC mode and bound to vfio-pci.

### Changed

- Refresh the provisioner chart, image, source pins, and the immutable image
  digest used by the pre-flight checker.

## [0.2.5] - 2026-11-01

### Fixed

- Update kata-device-provisioner to 0.1.0-alpha.2 so Blackwell GPUs can enable
  confidential computing when firmware returns an unpadded 22-byte knob reply.

### Changed

- Refresh the provisioner chart, image, source pins, and the immutable image
  digest used by the pre-flight checker.

## [0.2.4] - 2026-11-01

### Fixed

- Apply DCGM metrics settings only to NVIDIA GPU runtimes. CPU-only NVIDIA
  runtimes no longer receive the unsupported `nvrc.enableDCGM` setting.
- Remove the invalid CPU-only DCGM setting when importing older generated
  values, with a warning, so they can be regenerated for installation.

## [0.2.3] - 2026-10-22

### Changed

- Update the Kata Containers chart and image from 4.2.0 to 4.3.1, including
  upstream's default Job-based deployment.
- Import NVIDIA CPU and confidential runtime definitions from their dedicated
  upstream profiles, preserving the available runtime choices and provenance.

## [0.2.2] - 2026-10-22

### Fixed

- Missing host EROFS utilities no longer fail every conformance profile. Require
  them explicitly with `--require erofs` or `conformance.requirements` for runtime
  classes that need them.

### Added

- Per-node probe results show whether each check is required, an allowed
  alternative, or outside the selected conformance requirements.

## [0.2.1] - 2026-10-20

### Changed

- Update the Node Feature Discovery chart and image from v0.19.0 to v0.20.0.

## [0.2.0] - 2026-10-19

### Added

- Native CC conformance with explicit CPU/GPU requirements, an all-node verdict,
  complete evidence, and per-node failure reasons. Evaluate saved reports or run
  fresh pre-flight collection through Helm and kubectl.
- Helm conformance Job with consistent PASS/FAIL/ERROR outcomes and container
  exit codes 0/1/2. Helm succeeds only when every selected node passes; JSON logs
  and termination summaries distinguish nonconformance from collection errors.
- Explicit per-node GPU alternatives with `--require-any gpu-cc,gpu-ppcie`
  and Helm `conformance.anyOf`, preserving mandatory prerequisites.
- Host-local caching in the Rust pre-flight checker, with force refresh,
  corruption recovery, and serialization of concurrent probes.
- Experimental shared node controller for preparing newly eligible nodes.
- Intel TDX QGS deployment and certificate provisioning controls.

### Changed

- Check every Linux node by default; a label selector can restrict the scope.
- Start a new compatibility boundary: Helm values use format 2, and pre-flight
  reports use schema v2 with selected node inventory, machine/boot identities,
  checker version, and collection time. Regenerate values and rerun checks;
  format 1 and unversioned values and v1 reports are rejected.
- Reject incomplete or changing node coverage when collecting cluster reports.

## [0.1.7] - 2026-10-09

### Changed

- Update the Kata device plugin chart and image to v0.2.0-rc.2.

### Fixed

- Schedule the device plugin on nodes with NVIDIA GPU PCI hardware instead of
  requiring the Kata runtime installation label. This supports both TEE and
  non-TEE deployments, including when Kata deployment is disabled.

## [0.1.6] - 2026-10-09

### Changed

- Update the Kata device plugin chart and image to v0.2.0-rc.1, which publishes
  its device resource contract in the chart and uses component-specific
  DaemonSet names.

## [0.1.5] - 2026-10-09

### Changed

- Choose deployed stack components directly on the architecture cards with
  Deploy/Skip switches and a reset to architecture defaults.

### Fixed

- Install the pinned AMD SNP and Intel TDX feature rules through shared or
  existing NFD when Kata deployment is disabled, allowing confidential GPU
  provisioning to discover capable nodes independently of Kata installation.
- The pre-flight Rust package and lockfile now follow the KRAB release version.
  Generation and CI checks keep the build version aligned with the image tags.

## [0.1.4] - 2026-10-09

### Added

- Enable or disable Node Feature Discovery, Kata deployment, the device plugin,
  and the device provisioner independently in the builder and Helm values.

### Fixed

- The pre-flight collector uses a dedicated image with Bash, curl, and jq,
  allowing pre-flight checks to run before Kata Containers is installed.
- IOMMUFD checks recognize an installed but unloaded kernel module instead of
  reporting missing kernel support. Setup guidance includes loading the module
  now and persisting it through `/etc/modules-load.d/iommufd.conf`.

## [0.1.3] - 2026-09-27

### Added

- Blocked upstream refreshes send a Slack DM with the failed jobs and run link.

### Changed

- Release publication stops if `main` advances during a run, and chart
  dependency documentation is generated from the pinned chart.
- CI renders packaged Helm charts for every selectable runtime shim and
  supported GPU family, mode, and CPU TEE.

### Fixed

- Generated Helm values quote `on` and `off` GPU modes so Helm treats them as
  strings.
- The Next builder no longer links to itself in the release selector.

## [0.1.2] - 2026-09-25

### Changed

- The pre-flight GPU selector offers profile families or any NVIDIA model,
  including discrete PCIe cards.

### Fixed

- GPU readiness waits for a type selection before reporting that nodes passed.
- Next stays at the end of the version menu, including on the Next builder.

## [0.1.1] - 2026-09-25

## [0.1.0] - 2026-09-25

KRAB's first stable release includes the configuration builder, pinned Helm
charts, pre-flight checks, values import validation, and release SBOMs developed
through the alpha releases below.

### Added

- The home page opens the latest stable builder. The version menu links to
  older releases and Next, an unreleased build from `main`. Both Next and
  older builders show where to find the latest stable release.

## [0.1.0-alpha.8] - 2026-09-25

### Added

- Pull requests provide a validated builder preview and downloadable SBOMs for
  both charts and all four pre-flight image architectures.
- Releases include chart and pre-flight image SBOMs with checksums and
  attestations.

### Changed

- Chart dependencies, container image pins, the EROFS utility image, and KRAB
  release versions now come from maintained sources and generation checks.
- The pre-flight report has a versioned contract, and GPU model choices follow
  the pinned device provisioner profiles.

### Fixed

- Imported values are checked against their chart version. Compatible older
  files load with a warning; unsupported or lost fields fail validation.

## [0.1.0-alpha.7] - 2026-09-24

### Added

- Custom deployments can combine CPU TEE and NVIDIA GPU paths across selected
  target architectures, with GPU components included when needed.
- The front page shows the pinned component versions before deployment selection.

### Changed

- Pre-flight check and GPU model choices now appear with uploaded results, with
  a more compact failing-node report.
- The Local deployment path is now called Custom.

## [0.1.0-alpha.6] - 2026-09-24

### Fixed

- Existing NVIDIA GPU CC and PPCIE modes no longer block deployment choices
  that the provisioner can configure.

### Changed

- The pre-flight image and chart are now published with the KRAB release.

## [0.1.0-alpha.5] - 2026-09-24

### Added

- A labeled-node pre-flight check that collects one report for the cluster and
  uses selected CPU TEE and GPU requirements to guide deployment choices.
- Node readiness results with GPU model filters and clear failing-node details.

## [0.1.0-alpha.4] - 2026-09-23

### Added

- An optional deployment name now controls the Helm release and downloaded
  values filename, which also includes the KRAB version.

### Fixed

- NVIDIA deployments now use the published `v0.2.0-rc.0`
  kata-device-plugin image tag.

## [0.1.0-alpha.3] - 2026-09-23

### Fixed

- Generated values now select a valid default Kata shim for every supported
  architecture, preventing specialized configurations such as NVIDIA TDX from
  falling back to an unavailable generic QEMU runtime.

## [0.1.0-alpha.2] - 2026-09-23

### Fixed

- Releases are dispatched from `main`, with tag creation and safe reruns owned
  by one workflow execution.

## [0.1.0-alpha.1] - 2026-09-23

### Fixed

- Release verification now checks anonymous GHCR access directly instead of
  calling an unsupported package-visibility API.

## [0.1.0-alpha.0] - 2026-09-23

### Added

- Source-generated configuration UI for NVIDIA, local, AMD, IBM, and Intel
  Kata deployments.
- Generated, downloadable `values.yaml` artifacts and a version-pinned Helm
  installation command.
- KRAB umbrella chart with Node Feature Discovery, kata-deploy,
  kata-device-plugin, and kata-device-provisioner dependencies.
- Custom Kata RuntimeClasses, Kata and containerd drop-ins, image overrides,
  scheduled reconciliation, and advanced Kubernetes placement controls.
- Checksum-validated upstream provenance and release artifact attestations.

### Known limitations

- GB200 and GB300 are identified as `arm64`, but remain unavailable while Kata
  Containers support is pending.
- The chart consumes kata-device-provisioner `0.1.0-alpha.1`.
