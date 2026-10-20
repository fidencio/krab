# Changelog

All notable changes to KRAB are documented in this file.

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
