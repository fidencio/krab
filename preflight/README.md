# krab-preflight

A small read-only Linux host capability checker, written in Rust without external Cargo dependencies.

Build a native binary with `cargo build --release` from this directory on the target Linux architecture.

```text
cargo run -- --kvm --tdx --snp --ibm-se --iommufd --erofs --gpu --gpu-cc --gpu-ppcie
cargo run -- --json --snp --tdx
```

Each option runs only its corresponding check. Options may be combined. The exit status is 0 when every selected check reports available, 1 when any selected check is unavailable or fails, and 2 for invalid arguments.

`--json` writes one object to stdout with `architecture` (`amd64`, `arm64`, `ppc64le`, or `s390x` on the supported hosts) and a `checks` array. Each item has `check`, `status` (`available`, `unavailable`, `skipped`, or `error`), and `reason` (`null` when available). The array follows the order of the selected flags. Text output remains the default. GPU checks are skipped on architectures other than amd64 and arm64.

| Option | Check |
| --- | --- |
| `--kvm` | `/dev/kvm` is a character device |
| `--tdx` | `/sys/module/kvm_intel/parameters/tdx` is `Y` or `1` |
| `--snp` | `/sys/module/kvm_amd/parameters/sev_snp` is `Y` or `1` |
| `--ibm-se` | `/sys/firmware/uv/prot_virt_host` is `Y` or `1` |
| `--iommufd` | `/dev/iommu` is a character device |
| `--erofs` | The first executable `mkfs.erofs` in `PATH` (or standard system directories) contains the `mkfs-time` and `sort` option strings required by Kata Deploy |
| `--gpu` | `kata-device-provisioner status --all` reports a supported NVIDIA GPU |
| `--gpu-cc` | At least one supported NVIDIA GPU reports CC capability |
| `--gpu-ppcie` | At least one supported NVIDIA GPU reports PPCIE capability |

The kernel checks report presence or enabled state. They do not open the devices, query KVM capabilities, launch a guest, or verify that a particular device can use IOMMUFD. An absent sysfs file reports unavailable; an unreadable file or an unexpected value reports an error.

The EROFS check reads the `mkfs.erofs` binary for the `mkfs-time` and `sort` option strings, following [Kata Deploy's option check](https://github.com/kata-containers/kata-containers/blob/main/tools/packaging/kata-deploy/binary/src/main.rs). It does not execute `mkfs.erofs`. Like Kata Deploy's option check, it does not inspect `-T` separately. It does not check kernel EROFS support, containerd version, or whether the snapshotter is configured.

The GPU checks require [`kata-device-provisioner`](https://github.com/kata-containers/kata-device-provisioner) in `PATH`, or at the path in `KRAB_PROVISIONER`. They call its read-only `status --all` command so a GPU already set to another CC mode is still included. These checks report hardware capability for the supported NVIDIA GPUs; they do not call `status --probe`, read live CC/PPCIE modes, or require every GPU on the node to support the feature. The provisioner currently emits human-readable status rather than a machine-readable format, so these checks depend on its current output layout.

## Container image

The repository's `Dockerfile.precheck` builds Linux amd64, arm64, ppc64le, and s390x images. It includes pinned, published amd64 and arm64 `kata-device-provisioner` binaries; GPU checks are skipped on the other architectures. The runtime image deliberately does not contain `mkfs.erofs`: the EROFS check must inspect the host's utility, not a copy in the image. Its entrypoint is `node-precheck`, which uses this Rust binary and emits the versioned node report consumed by the KRAB chart and UI.

Build a multi-architecture OCI image archive with Docker Buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64,linux/ppc64le,linux/s390x \
  -f Dockerfile.precheck --output type=oci,dest=krab-preflight.tar .
```

For a local build on the current architecture, then run with the host root mounted read-only at `/host`:

```sh
docker build -f Dockerfile.precheck -t krab-preflight:local .
docker run --rm --mount type=bind,src=/,dst=/host,readonly krab-preflight:local
```

The image defaults to a versioned JSON node report. To run this binary directly, override the image entrypoint with `/usr/local/bin/krab-preflight` and pass the desired flags. Docker's bind mount must include the host's `/dev` and `/sys` mounts. `KRAB_PREFLIGHT_HOST_ROOT=/host` makes device, sysfs, and `mkfs.erofs` checks read that tree, and passes `/host/sys` to the provisioner. If running the binary directly on the host, it defaults to `/`. The architecture field describes the image's native target architecture; use the matching platform image on the host.
