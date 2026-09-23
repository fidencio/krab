# Kata Reference Architecture Builder

KRAB is a static, source-generated builder for Kata Containers reference
architectures and hardware integrations.
The browser contains no product catalog or GitHub API integration: technical
data is generated from checksum-validated, pinned upstream files before Vite
builds the site.

## Data flow

1. `upstream/sources.lock.yaml` pins repository commits, paths, and checksums.
2. `npm run generate` downloads any missing files into an ignored local cache
   and validates every file against its pinned checksum.
3. Generation creates
   `src/generated/catalog.json` plus `provenance.json`.
4. The React UI renders that generated catalog and creates artifacts from the
   upstream chart values.

The catalog currently uses released Kata Containers data and the explicitly
marked alpha profile set from
[`kata-device-provisioner` v0.1.0-alpha.1](https://github.com/kata-containers/kata-device-provisioner/releases/tag/v0.1.0-alpha.1).
GPU, CPU TEE, and CC-mode claims are validated against the pinned NVIDIA
Confidential Containers 1.0.0 supported-platform, CC-mode, and workload
documentation.

The KRAB umbrella chart always installs Node Feature Discovery and kata-deploy.
NVIDIA configurations additionally install kata-device-plugin and a
multi-profile kata-device-provisioner release. Existing dependency versions are
derived from pinned chart metadata. The provisioner chart is consumed from its
published upstream OCI repository; the device-plugin OCI chart remains planned
until that upstream project publishes it.

## Helm chart

The UI and chart live in this repository so their values contract is versioned
together:

```text
charts/krab/                 Helm umbrella chart
src/                         Static configuration UI
scripts/sync-upstream.ts     Catalog and chart-contract generator
test/                        UI, artifact, and chart contract tests
```

The chart dependency model is:

```text
krab
├── node-feature-discovery   always installed
├── kata-deploy              always installed
├── kata-device-plugin       NVIDIA only
└── kata-device-provisioner  NVIDIA only, multiple profiles in one release
```

KRAB installs NFD directly and disables kata-deploy's nested NFD dependency.
Generated NVIDIA values set `nvidia.enabled=true` and configure
`kata-device-provisioner.profiles` with one entry per selected hardware,
confidential-computing mode, and CPU TEE combination.

The chart is structurally complete, but publication is intentionally blocked
until the kata-device-plugin chart is available from its planned upstream OCI
repository. The multi-profile kata-device-provisioner chart is a published
alpha dependency.

## Development

```sh
npm ci
npm run generate
npm test
npm run test:chart
npm run dev
```

To refetch every locked source and verify its checksum:

```sh
npm run sync:upstream
```

Updating an upstream version is a reviewed change: update the ref and checksum
in the lock file, run the sync command, and review the generated-data diff.

## Releases

KRAB chart and application versions are kept identical. Alpha releases use a
`chart-vX.Y.Z-alpha.N` Git tag; for example, the first release is tagged
`chart-v0.1.0-alpha.0`.

The chart release workflow can be run manually as a non-publishing validation.
A matching tag runs the same checks, packages and attests the chart, publishes
it to `oci://ghcr.io/fidencio/krab`, verifies an anonymous pull, and creates a
GitHub prerelease with the chart archive and checksum file. Publication is
refused while any pinned upstream OCI dependency is unavailable.

Because Helm does not select prereleases implicitly, install this alpha with an
explicit version:

```sh
helm upgrade --install krab oci://ghcr.io/fidencio/krab \
  --version 0.1.0-alpha.1 \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

See [CHANGELOG.md](CHANGELOG.md) for release contents and known limitations.

## GitHub Pages

The Pages workflow runs generation, tests, lint, and the production build. It
sets Vite's base path from the repository name, so the resulting application is
fully static and works from a project Pages URL.
