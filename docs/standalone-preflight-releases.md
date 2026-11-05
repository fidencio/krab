# Standalone Linux checker releases

New releases built with the standalone-binary workflow attach these assets to
the same GitHub release as the Helm charts:

- `krab-preflight-X.Y.Z-linux-amd64.tar.gz`
- `krab-preflight-X.Y.Z-linux-arm64.tar.gz`
- The release-wide `SHA256SUMS`, covering both archives and the other assets.

Each archive contains only the focused checker executable, its README and
license, a binary `SHA256SUMS`, and `BUILD-INFO.json`. The metadata records the
release version, source revision, Rust compiler, target, and checker digest.
The binaries use static musl linkage, so they do not depend on the host's glibc
version. They do not include the full `krab` CLI or the GPU provisioner.

## Download and verify

Replace `X.Y.Z` with a new release containing the standalone assets. Select
`amd64` for x86_64 or `arm64` for aarch64:

```sh
krab_version=X.Y.Z
krab_arch=amd64
krab_archive="krab-preflight-${krab_version}-linux-${krab_arch}.tar.gz"
krab_release="https://github.com/fidencio/krab/releases/download/chart-v${krab_version}"
mkdir -p krab-checker-release
cd krab-checker-release
curl --fail --location --remote-name "${krab_release}/${krab_archive}"
curl --fail --location --remote-name "${krab_release}/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
mkdir -p checker
tar -xzf "${krab_archive}" -C checker
cd checker
sha256sum --check SHA256SUMS
```

The release-wide checksum verifies the archive. The checksum inside it verifies
the executable and supplies the installer's artifact pin. If GitHub CLI is
available, verify the archive's build provenance before extraction with
`gh attestation verify "$krab_archive" --repo fidencio/krab` in the download
directory.

For a GPU node, choose the capabilities to enforce. For example, to accept
either supported GPU capability:

```sh
./krab-preflight conformance --local --require-any gpu-cc,gpu-ppcie --json
krab_checker_sha256="$(awk '$2 == "krab-preflight" {print $1}' SHA256SUMS)"
sudo ./krab-preflight conformance install \
  --checker-sha256 "${krab_checker_sha256}" \
  --require-any gpu-cc,gpu-ppcie
systemctl status krab-conformance.service
```

These checks report host prerequisites and static GPU capabilities; they do not
launch or attest a workload, change GPU mode, or reset a device. Host service
installation still requires systemd and its documented host tools. See the
[continuous conformance guide](continuous-node-conformance.md) for NFD mounts,
policy, supervision, removal, and reboot behavior.

## Build and publication

The reusable binary workflow builds and tests both musl targets on native
GitHub-hosted runners. It rejects dynamic or wrong-architecture artifacts,
packages deterministically, checks the packaged binary's checksum, and exercises
PASS/FAIL/ERROR and NFD publication against synthetic host/GPU evidence.
Physical GPU validation remains a separate hardware test.

Merging builds CI artifacts. Publication still requires a new release version
and the manually dispatched chart release workflow from current `main`.
That workflow waits for both binary builds, adds their archives to the release
checksums and build provenance attestations, and attaches them to the release.
Existing release checks and the guard against publishing an outdated main
revision remain in effect. Existing published versions are not overwritten or
retrofitted with binaries.
