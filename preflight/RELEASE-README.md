# KRAB standalone checker @VERSION@

This archive contains the static Linux krab-preflight checker, not the full
KRAB CLI or the GPU provisioner. BUILD-INFO.json identifies its architecture,
compiler, source revision, and executable digest.

Verify the executable before using it:

```sh
sha256sum --check SHA256SUMS
```

For a GPU node, require either supported GPU capability:

```sh
./krab-preflight conformance --local --require-any gpu-cc,gpu-ppcie --json
```

To install the unprivileged host daemon, use the verified binary digest:

```sh
krab_checker_sha256="$(awk '$2 == "krab-preflight" {print $1}' SHA256SUMS)"
sudo ./krab-preflight conformance install \
  --checker-sha256 "${krab_checker_sha256}" \
  --require-any gpu-cc,gpu-ppcie
```

Installation requires root, systemd, and the documented host tools. Checks
report prerequisites and static GPU capabilities; they do not change GPU modes,
reset devices, launch workloads, or attest them.

See the [host daemon documentation for this source revision](https://github.com/kata-containers/krab/blob/@REVISION@/docs/continuous-node-conformance.md)
for NFD configuration, policy selection, integrity checks, reboot behavior,
and removal.
