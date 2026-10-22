# krab-preflight

A small read-only Linux host capability checker, written in Rust.

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
| `--iommufd` | `/dev/iommu` is a character device; otherwise inspect running-kernel module files and configuration |
| `--erofs` | The first executable `mkfs.erofs` in `PATH` (or standard system directories) contains the `mkfs-time` and `sort` option strings required by Kata Deploy |
| `--gpu` | `kata-device-provisioner status --all` reports a supported NVIDIA GPU |
| `--gpu-cc` | At least one supported NVIDIA GPU reports CC capability |
| `--gpu-ppcie` | At least one supported NVIDIA GPU reports PPCIE capability |

The kernel checks report presence or enabled state. They do not open the devices, query KVM capabilities, launch a guest, or verify that a particular device can use IOMMUFD. An absent sysfs file reports unavailable for the TEE checks; an unreadable file or an unexpected value reports an error.

IOMMUFD readiness is confirmed by the host `/dev/iommu` character device. A
missing device does not prove that the kernel lacks IOMMUFD: Ubuntu can ship it
as an unloaded `iommufd.ko.zst` module. The probe checks the running kernel's
module files, built-in module list, and kernel configuration under the host root.
An installed but unloaded module, missing host mounts, or unavailable kernel
metadata reports `skipped` (`unknown` in the node report), with an explanation.
Only an explicit disabled kernel configuration confirms lack of support.
The precheck does not load modules or change the host.

To enable an installed module now and persist it across reboots:

```sh
sudo modprobe iommufd
echo iommufd | sudo tee /etc/modules-load.d/iommufd.conf
ls -l /dev/iommu
```

Rerun the precheck after setup. The persistent file must be created on every
target node that needs IOMMUFD.

The EROFS check reads the `mkfs.erofs` binary for the `mkfs-time` and `sort` option strings, following [Kata Deploy's option check](https://github.com/kata-containers/kata-containers/blob/main/tools/packaging/kata-deploy/binary/src/main.rs). It does not execute `mkfs.erofs`. Like Kata Deploy's option check, it does not inspect `-T` separately. It does not check kernel EROFS support, containerd version, or whether the snapshotter is configured.

The GPU checks require [`kata-device-provisioner`](https://github.com/kata-containers/kata-device-provisioner) in `PATH`, or at the path in `KRAB_PROVISIONER`. They call its read-only `status --all` command so a GPU already set to another CC mode is still included. These checks report hardware capability for the supported NVIDIA GPUs; they do not call `status --probe`, read live CC/PPCIE modes, or require every GPU on the node to support the feature. The provisioner currently emits human-readable status rather than a machine-readable format, so these checks depend on its current output layout.

## Cluster conformance

Use the same binary to evaluate every node against an explicit CC selection:

```sh
krab-preflight conformance --run --require tdx --require gpu-cc --output verdict.json
krab-preflight conformance --report krab-precheck.json --require snp --json
krab-preflight conformance --help
```

`--run` uses Helm and kubectl from PATH to run the published pre-check chart and
collect fresh reports. `--report` evaluates a saved v2 cluster collection offline.
Every node in the selected inventory must confirm every requirement. Required
`no`, `unknown`, or `review` states fail the verdict, as do missing/duplicate
nodes, changed identities, unsupported reports, or failed collection.
Conformance verdicts are never cached; live runs force the underlying probes to
refresh their cache.

Choose one of `cc` (any supported CPU TEE per node), `tdx`, `snp`, or `se`, and/or
`gpu-cc` or `gpu-ppcie`. All selections also require KVM;
add `--require erofs` only for runtime classes that need host EROFS utilities;
GPU selections require IOMMUFD, NVIDIA hardware, and complete GPU inventory.
An optional reported runtime layout must pass. `--gpu-model MODEL` restricts GPU
models; repeated models are alternatives. The full selection, inventory, node
failures, and source reports are included in the JSON verdict.

Use `--require-any gpu-cc,gpu-ppcie` to allow either GPU capability on each node.
The shared GPU prerequisites still apply. Optional `--require tdx` remains
mandatory on every node; separate `--require` flags always combine with AND.
The JSON verdict includes the OR alternatives and which ones each node matched.
Each node's `checks` lists every collected probe's `status` and `reason`, alongside
its `evaluation`: `required`, `alternative` (one allowed option must pass), or
`not-required` (reported evidence that does not affect this verdict). Collection
status and conformance policy are separate: an EROFS `no` can accompany a PASS.
`failures` also includes policy and evidence checks such as GPU inventory,
architecture, host identity, and report freshness. A PASS covers the selected
capabilities; it does not certify every runtime class or its snapshotter setup.
In Helm values, add `erofs` to `conformance.requirements` to enforce it.

Exit status is 0 for PASS, 1 for confirmed nonconformance after complete checks,
and 2 for collection failures, incomplete/invalid evidence, invalid CLI options,
or output-write errors. Required unknown/review capability states are FAIL;
missing reports and invalid identities are ERROR. Text output lists every node.
The Helm conformance Job uses these same container exit codes: 0 produces a
Complete Job, while 1 and 2 produce Failed Jobs. Its termination message and
JSON logs distinguish FAIL from ERROR, since Helm itself exits nonzero for both.
This is conformance of reported host
prerequisites; it does not test workload launch or attestation. See the
[cluster conformance guide](../README.md#cc-conformance) for scope and context options.

## Cached checks

Caching is enabled by default for both `--node-report` and individually selected
checks, including text and JSON output. Results live in
`$XDG_CACHE_HOME/krab/preflight`, or `$HOME/.cache/krab/preflight` when
`XDG_CACHE_HOME` is unset. Select another location with `--cache-dir DIR`.

```sh
krab-preflight --node-report --cache-dir /var/cache/krab-preflight
krab-preflight --node-report --cache-dir /var/cache/krab-preflight --force-refresh
krab-preflight --json --snp --tdx --no-cache
```

The cache matches the host machine ID, boot ID, checker version and binary,
architecture, host root, caller credentials, requested checks, output format,
`PATH`, and `KRAB_PROVISIONER`. A hit returns the original output and exit status,
including confirmed unavailable capabilities. Reboots and checker changes
automatically require fresh checks. Changes made to a running host, such as
loading modules or installing tools, require `--force-refresh`. Use `--no-cache`
to bypass all cache reads and writes.

Collection errors are not cached. If host identity cannot be read or the cache
directory is unavailable, the checker runs fresh checks. Individual check mode
reports cache diagnostics on stderr; `--node-report` suppresses them so Kubernetes
logs contain only the JSON report. Cache files use private permissions, integrity checks, atomic writes,
and a file lock so simultaneous invocations sharing a cache do not repeat probes.
The cache writes only to its selected directory; it does not change host capabilities.

The Helm chart mounts a writable host cache directory and passes `--cache-dir`
to this same binary. It adds no separate cache implementation. Probe Jobs still
run on every selected node, returning cached reports when valid.

## Container image

The repository's `Dockerfile.precheck` builds Linux amd64, arm64, ppc64le, and s390x images. It includes pinned, published amd64 and arm64 `kata-device-provisioner` binaries; GPU checks are skipped on the other architectures. The runtime image deliberately does not contain `mkfs.erofs`: the EROFS check must inspect the host's utility, not a copy in the image. Its entrypoint is `krab-preflight --node-report`, which uses this Rust binary and emits the versioned node report consumed by the KRAB chart and UI.

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
