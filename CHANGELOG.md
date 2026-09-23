# Changelog

All notable changes to KRAB are documented in this file.

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
