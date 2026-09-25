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
3. Generation synchronizes the KRAB release version from `package.json`, then
   creates `src/generated/catalog.json` plus `provenance.json`.
4. The React UI renders that generated catalog and creates artifacts from the
   upstream chart values.

The catalog uses released Kata Containers data and the reviewed provisioner
profiles pinned in [`sources.lock.yaml`](upstream/sources.lock.yaml). The exact
refs and checksums are in the generated
[`provenance.json`](src/generated/provenance.json).
KRAB's reviewed [`compatibility.json`](upstream/compatibility.json) records
which profile and CPU TEE combinations the builder offers. Generation checks
that policy against the pinned Kata runtimes, provisioner profiles, and node
label definitions. Profile publication alone does not enable a new path.

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

## Node pre-check

Label the Linux nodes to check, then install the published pre-check chart:

```sh
kubectl label nodes NODE_1 NODE_2 krab/preflight=true
helm install krab-precheck \
  oci://ghcr.io/fidencio/krab-precheck \
  --version 0.1.0-alpha.7 \
  --timeout 35m \
  --namespace krab-precheck --create-namespace &&
kubectl --namespace krab-precheck logs \
  job/krab-precheck-results > krab-precheck.json
```

The Helm install waits for the existing job dispatcher to run one privileged,
node-pinned probe Job on every labeled Linux node, and for a collector Job to assemble
their logs into one versioned JSON document. The collector fails if any node
Job fails or no labeled nodes are covered. The aggregate remains available as the
`krab-precheck-results` Job log. Upload `krab-precheck.json` on the first page
of the builder. To check one node, label only that node. Helm creates the
`krab-precheck` namespace if needed; to use another namespace, change both
`--namespace` flags. The probe image builds
the dependency-free Rust checker in [`preflight/`](preflight/) for amd64, arm64,
ppc64le, and s390x. It uses pinned, published kata-device-provisioner binaries
for NVIDIA capability and device inventory on amd64 and arm64; no provisioner
source build, GPU mode change, or NFD installation is involved. On ppc64le and
s390x the GPU capability fields remain unknown. The Rust checker probes KVM,
TDX, SNP, IBM Secure Execution, IOMMUFD, and host `mkfs.erofs` options. The
node report also includes GPU inventory. The
dispatcher records result metadata on Nodes, so its ServiceAccount has node
patch permission. Review the JSON before sharing it; it includes GPU names,
PCI addresses, and kernel version.

The browser reads reports locally. Definite incompatibilities disable matching
choices, while unknown probes remain selectable and require operator review.
The v1 report shape is defined in [`contracts/precheck-v1.schema.json`](contracts/precheck-v1.schema.json).
The install command above and the builder use [`upstream/precheck-command.json`](upstream/precheck-command.json).
An uploaded report is a snapshot, not a launch or attestation test. Add reports
from every target node, particularly for clusters with mixed hardware. Select
the Kubernetes distribution separately in the builder.
Select one or more Intel TDX, AMD SEV-SNP, IBM SEL, or NVIDIA GPU checks before
uploading a report. Top-level checks use AND: all selected checks must pass on
the same node. GPU model choices use OR: any selected model qualifies. The
results show which selected models were found and list only nodes with failed
checks, with name search and ten nodes per page. NVIDIA GPU readiness includes
KVM, IOMMUFD, an NVIDIA GPU, and EROFS utilities. The report still records CC and
PPCIE capability for deployment choices. NO means a host check did not pass or
could not be confirmed. It does not establish whether the hardware lacks a
feature or the host needs firmware, BIOS, or kernel setup.
For the NVIDIA check, optionally select one or more GPU models. The choices
come from the pinned provisioner profiles. A node passes the model filter when
its provisioner inventory identifies any selected model. The node report records
the provisioner's `chip=` field and readable device name; older reports can
still match a complete model name in the device name.
The generated deployment installs EROFS utilities when a checked node does not
confirm suitable host utilities.
The precheck image runs the Rust probe on a distroless base. Its provisioner
image digest is kept in `upstream/precheck-image.lock.json`. Run
`npm run sync:upstream` to refresh it with ORAS, check amd64 and arm64, and
updates the Dockerfile and the precheck chart's dispatcher image. The probe
checks the host EROFS binary without executing it, so new reports leave the
optional `erofsVersion` field empty.

## Development

Development changes land on the `dev` branch. GitHub Pages publishes the
released `main` tree at `/krab/` and the integration tree at `/krab/dev/`.
When cutting a release, merge `dev` into `main` and dispatch the chart release
workflow from `main`; the workflow refuses to release if the two branch trees
differ.

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

This command also resolves the precheck provisioner image digest and requires
the ORAS CLI. The EROFS utility image has its own
[`upstream/erofs-utils-image.lock.json`](upstream/erofs-utils-image.lock.json).
`npm run verify:erofs-image` checks its Quay digest and amd64/arm64 manifests;
`npm run refresh:erofs-image` selects a newer published version when both
platforms are present. The weekly workflow proposes that update for review.
The utility image is used only when generated values request EROFS setup.

Updating an upstream version is a reviewed change. For example, run
`npm run refresh:upstream -- --group kata` to discover the newest Kata release,
resolve its tag to a commit, and update its locked checksums. The other groups
are `nfd`, `device-plugin`, and `provisioner`. Then run
`npm run sync:upstream` and review the generated diff.

The generator updates the chart dependencies in `charts/krab/Chart.yaml` and
the image pins in `charts/krab/values.yaml`. KRAB installs NFD directly from
its latest reviewed upstream release. The weekly workflow also verifies the
current pins, then checks each upstream group separately and proposes a PR only
when its source files, generated data, and published chart pass validation.
A blocked group leaves the others free to update. NFD's published chart version
follows its release tag, since the source
`Chart.yaml` at that tag has a different version. KRAB's deployment settings
stay in the values file; the kubectl image pin and device plugin tag choice
remain in `upstream/architecture.yaml`.
Each refresh job writes its pinned version, candidate, and result to the
workflow run summary, with a link when it opens a PR.

`npm run refresh:nfd` remains a shortcut for the NFD group.

### Updating or rolling back an upstream pin

For a source release, choose one group (`kata`, `nfd`, `device-plugin`, or
`provisioner`) and run:

```sh
npm run refresh:upstream -- --group GROUP
npm run sync:upstream
npm run verify:chart-artifact -- --group GROUP
npm test
npm run build
```

Review the lockfile, generated catalog, chart dependencies, image pins, and
compatibility claims together in one PR. `sync:upstream` also resolves the
published provisioner image digest and checks its platform coverage.

The EROFS image has a separate lock. Update and check it with:

```sh
npm run refresh:erofs-image
npm run verify:erofs-image
npm run generate
npm test
npm run build
```

To roll back a merged upstream update, revert its PR commit in a new PR:

```sh
git revert UPDATE_COMMIT
npm run generate
npm test
npm run build
git diff --exit-code
```

For a merge commit, use `git revert -m 1 UPDATE_COMMIT` instead. GitHub's
Revert action is also suitable. Keep the lockfile and all generated files in
the same revert. If generation leaves a diff, review and commit it with the
revert: changes made since the original update can affect the output. The PR's
generation check must finish with no diff.

## Releases

KRAB chart, pre-flight chart, pre-flight image, and application versions are
kept identical. Alpha releases use a `chart-vX.Y.Z-alpha.N` Git tag; for
example, the first release is tagged `chart-v0.1.0-alpha.0`.

To bump the KRAB release version, edit only `version` in `package.json` and run
`npm run generate`. It updates `package-lock.json`, both chart versions, the
release notice, installation examples, and the generated catalog. It also
starts a new changelog section; add the release notes and date there. CI checks
that the generated copies are committed.

Dispatch the chart release workflow from `main`. It runs the application and
pre-flight checks, publishes the pre-flight image to
`ghcr.io/fidencio/krab-preflight`, packages and attests both charts, and
publishes them to `oci://ghcr.io/fidencio/krab` and
`oci://ghcr.io/fidencio/krab-precheck`. It verifies anonymous access to all
three artifacts before creating the matching `chart-vX.Y.Z-alpha.N` tag and
GitHub release with both chart packages. Reruns verify existing artifacts
before replacing release assets. Publication is refused while any pinned
upstream OCI dependency is unavailable.

For a prerelease, specify its version explicitly when installing with Helm:

```sh
helm upgrade --install krab oci://ghcr.io/fidencio/krab \
  --version 0.1.0-alpha.7 \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

See [CHANGELOG.md](CHANGELOG.md) for release contents and known limitations.

## GitHub Pages

The Pages workflow runs generation, tests, lint, and the production build. It
sets Vite's base path from the repository name, so the resulting application is
fully static and works from a project Pages URL.
