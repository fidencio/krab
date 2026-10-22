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

The KRAB umbrella chart's dependencies come from pinned upstream chart
metadata. PR validation downloads them and renders both default and NVIDIA
installations.

## Helm chart

The UI and chart live in this repository so their values contract is versioned
together:

```text
charts/krab/                 Helm umbrella chart
src/                         Static configuration UI
scripts/sync-upstream.ts     Catalog and chart-contract generator
test/                        UI, artifact, and chart contract tests
```

The dependency table is generated from [`Chart.yaml`](charts/krab/Chart.yaml):

<!-- chart-dependencies:start -->

| Chart | Version | OCI repository | Enabled when |
| --- | --- | --- | --- |
| node-feature-discovery | 0.20.0 | `oci://registry.k8s.io/nfd/charts` | `node-feature-discovery.enabled` |
| kata-deploy | 4.2.0 | `oci://ghcr.io/kata-containers/kata-deploy-charts` | `kata-deploy.enabled` |
| kata-device-plugin | 0.2.0-rc.2 | `oci://ghcr.io/kata-containers/kata-device-plugin-charts` | `kata-device-plugin.enabled,nvidia.enabled` |
| kata-device-provisioner | 0.1.0-alpha.1 | `oci://ghcr.io/kata-containers/kata-device-provisioner-charts` | `kata-device-provisioner.enabled,nvidia.enabled` |
| intel-tdx-qgs | 0.27.0-alpha.1 | `oci://ghcr.io/intel` | `intel-tdx-qgs.enabled` |

<!-- chart-dependencies:end -->

KRAB installs NFD directly and disables kata-deploy's nested NFD dependency.
Generated NVIDIA values set `nvidia.enabled=true` and configure
`kata-device-provisioner.profiles` with one entry per selected hardware,
confidential-computing mode, and CPU TEE combination.

With Kata deployment disabled, KRAB supplies the pinned CPU feature rules for
AMD SNP and Intel TDX through shared or existing NFD. This lets confidential GPU
provisioning select capable nodes without installing Kata first.

Downloaded values files record their KRAB format and chart version in comments.
When you load one into the builder, KRAB checks it against the current chart
schema and the available shims and profiles. A compatible file from another
release loads with a warning; an unknown format or removed choice fails with
an explanation. Imports also fail when the builder would drop a nested field,
and warn if a field's value changes when regenerated. Older files without
version comments can still load after the same checks, with a warning to
review the new output before deploying.

The release workflow verifies that every upstream chart dependency is
available before publishing KRAB.

## Node pre-check

KRAB 0.2.1 uses Helm values format 2 and pre-check schema v2.
Regenerate values and rerun pre-flight checks: format 1 values, unversioned
values, and v1 pre-check reports are not accepted. Archived builders remain
available for older releases.

An opt-in [experimental Rust controller](controller/README.md) can prepare new
nodes across the enabled stack using one shared reconcile loop. It is separate
from the published chart workflow and currently intended for fresh test clusters.

Install the published pre-check chart to check every Linux node in the cluster:

```sh
helm install krab-precheck \
  oci://ghcr.io/fidencio/krab-precheck \
  --version 0.2.1 \
  --timeout 35m \
  --namespace krab-precheck --create-namespace &&
kubectl --namespace krab-precheck logs \
  job/krab-precheck-results > krab-precheck.json
```

The Helm install waits for the existing job dispatcher to run one privileged,
node-pinned probe Job on every Linux node, and for a collector Job to assemble
their logs into one versioned JSON document. The collector fails if any node
Job fails or no Linux nodes match the selector. The aggregate remains available as the
`krab-precheck-results` Job log. Upload `krab-precheck.json` on the first page
of the builder. To restrict the check to selected nodes, run
`kubectl label nodes NODE_1 NODE_2 krab/preflight=true` and add
`--set-string nodeSelector=krab/preflight=true` to the Helm install command.
Any Kubernetes label selector can be supplied through `nodeSelector`; the chart
always restricts checks to Linux nodes. Helm creates the
`krab-precheck` namespace if needed; to use another namespace, change both
`--namespace` flags.

The Rust checker saves reports on each node under `/var/lib/krab/preflight`.
Later runs still launch one Job per selected node, but reuse valid reports
without repeating the checks. Reports are invalidated when the machine, boot ID,
checker binary, requested checks, or execution context changes. Probe errors
are retried rather than cached. After changing host configuration without
rebooting, pass `--set cache.forceRefresh=true` to get fresh results; set it
back to `false` for later runs. Use `--set cache.enabled=false` to disable caching,
or `--set cache.hostPath=/your/cache/path` to change the host cache location.
Only the cache directory is mounted writable; host inspection mounts remain
read-only, and probes do not receive Kubernetes credentials.

The probe image builds
the Rust checker in [`preflight/`](preflight/) for amd64, arm64,
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
The v2 report shape is defined in [`contracts/precheck-v2.schema.json`](contracts/precheck-v2.schema.json).
It records the selected node inventory, node UID, host machine/boot identities,
checker version, and collection time. The collector rejects identity changes
and incomplete node coverage.
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
If IOMMUFD is installed as an unloaded module, the report requests host setup
instead of rejecting the kernel. Run `sudo modprobe iommufd`, then
`echo iommufd | sudo tee /etc/modules-load.d/iommufd.conf` on each target node
to persist it across reboots. Rerun the precheck afterward. The precheck itself
is read-only.

The generated deployment installs EROFS utilities when a checked node does not
confirm suitable host utilities.
The node probe runs on a distroless base. The collector uses a separate
`ghcr.io/fidencio/krab-collector` image containing Bash, curl, jq, and CA
certificates, with the same release version as the precheck chart. Its probe provisioner
image digest is kept in `upstream/precheck-image.lock.json`. Run
`npm run sync:upstream` to refresh it with ORAS, check amd64 and arm64, and
updates the Dockerfile and the precheck chart's dispatcher image. The probe
checks the host EROFS binary without executing it, so new reports leave the
optional `erofsVersion` field empty.

## CC conformance

The Rust checker can give a strict cluster verdict for the requirements you
choose. Every selected node must pass: one `no`, `unknown`, or `review` on a
required check fails the cluster. KVM is a prerequisite for every profile;
host EROFS utilities are required only with `--require erofs`. A reported runtime
layout must also be confirmed.

Run fresh pre-flight checks, collect all Linux nodes, and save the verdict with
its complete evidence:

```sh
krab-preflight conformance --run \
  --require tdx --require gpu-cc \
  --output krab-conformance.json
```

Choose requirements explicitly: `tdx`, `snp`, `se`, `gpu-cc`, or `gpu-ppcie`.
Add `--require erofs` for runtime classes that need host EROFS utilities.
Each node’s `checks` reports probe status and whether it is `required`, an
`alternative`, or `not-required` for the selected policy.
`--require cc` allows any supported CPU TEE on each node, including mixed Intel
and AMD clusters. CPU and GPU requirements combine with AND. GPU profiles also
require IOMMUFD and a complete NVIDIA GPU inventory. Optional `--gpu-model H100`
restricts the GPU model; repeat it to allow alternatives. No profile is assumed.

To allow either GPU CC or PPCIE on each node, use an explicit OR selection:

```sh
krab-preflight conformance --run --require-any gpu-cc,gpu-ppcie --output verdict.json
```

Each node must confirm at least one alternative and all shared GPU prerequisites.
Different nodes can match different alternatives. Add `--require tdx`, for example,
to also require TDX on every node. Two separate `--require` flags still mean AND.
JSON records the OR selection as `anyOfRequirements` and each node's matching
alternatives as `matchedAnyOfRequirements`.

`--run` needs Helm and kubectl on the machine running the binary. It uses the
pre-check chart matching the binary version, forces fresh probes, pins one Kubernetes context, and
compares node identities before and after collection. Use `--context NAME` to
choose a context, `--node-selector 'pool=cc'` to choose a subset of Linux nodes,
or `--chart ./charts/precheck` to test a local chart. Namespace and release both
default to `krab-conformance`; the probe Jobs remain available for diagnostics.
The command installs only the pre-check chart.

To evaluate an existing v2 collection without accessing Kubernetes:

```sh
krab-preflight conformance --report krab-precheck.json \
  --require snp --json > krab-conformance.json
```

The saved report's embedded inventory must match every report and host identity.
Optionally pass `--nodes nodes.json` containing the corresponding
`kubectl get nodes --selector kubernetes.io/os=linux -o json` inventory for an
independent coverage comparison. Saved reports describe their collection-time
snapshot; use `--run` to check current configuration.

Exit code 0 means all nodes passed, 1 means complete checks show nonconformance,
and 2 means collection, evidence, CLI, or output errors. Text output names every
node, with PASS, FAIL, or ERROR. JSON verdicts include all
failed nodes, reasons, selected requirements, the node inventory, and the
pre-check reports; their contract is
[`contracts/conformance-v1.schema.json`](contracts/conformance-v1.schema.json).
Conformance verifies reported host prerequisites; workload launch and attestation
remain untested. Build the binary as described in [`preflight/`](preflight/).

Helm can gate installation on the same verdict. Save your selection as
`conformance-values.yaml`:

```yaml
conformance:
  enabled: true
  requirements: [tdx, gpu-cc]
```

For the GPU OR selection instead, use `anyOf: [gpu-cc, gpu-ppcie]` under
`conformance`. It can be used alone or alongside mandatory `requirements: [tdx]`.

```sh
helm upgrade --install krab-conformance \
  oci://ghcr.io/fidencio/krab-precheck \
  --version 0.2.1 \
  --namespace krab-conformance --create-namespace \
  --timeout 35m --values conformance-values.yaml
```

The chart launches fresh probes and a `krab-conformance-conformance` hook Job.
It retains both successful and failed verdicts until the next run. The collector
waits for the dispatcher and passes collection errors to the evaluator, so a
failed dispatcher cannot become a passing verdict.

| Outcome | Binary/container exit | Conformance Job | Helm command |
| --- | --- | --- | --- |
| PASS: all nodes meet the selection | 0 | Complete | exits 0 |
| FAIL: required capability is not confirmed | 1 | Failed | exits nonzero |
| ERROR: incomplete/invalid evidence or collection failure | 2 | Failed | exits nonzero |

Kubernetes Jobs have Complete and Failed conditions; distinguish FAIL from ERROR
using the evaluator container's exit code or JSON verdict. Helm does not preserve
the container's distinct exit codes in its own exit status. After Helm returns:

```sh
kubectl -n krab-conformance logs job/krab-conformance-conformance \
  -c conformance > verdict.json
kubectl -n krab-conformance get pods \
  -l batch.kubernetes.io/job-name=krab-conformance-conformance -o json \
  | jq '.items[].status.containerStatuses[]? | select(.name == "conformance") | .state.terminated | {exitCode, message}'
```

The termination message is a compact JSON summary containing `verdict`,
`exitCode`, node counts, and `coverageVerified`; full logs contain all evidence.
If a container cannot start, the Job times out, or Helm fails before creating the
Job, automation must treat the absent verdict as ERROR. Any unexpected exit code
is also ERROR; only exit 0 and a completed Job establish success.

## Development

Development changes land on `main`. GitHub Pages serves the latest published
stable release at `/krab/` and a build from `main`, called Next, at `/krab/dev/`.
Each pull request is built and checked independently. When it passes, Pages
publishes it at `/krab/pr/<number>/` and a bot comment links to that preview.
The preview is removed from the next Pages deployment after the PR closes or
its current revision fails validation.
When cutting a release, dispatch the chart release workflow from `main`.

```sh
npm ci
npm run generate
npm test
npm run test:chart
helm dependency update charts/krab
npm run test:helm
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
are `nfd`, `device-plugin`, `provisioner`, and `qgs`. Then run
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
If verification fails or a newer candidate produces no PR, the workflow sends
one Slack DM with a link to the run. Set the `KRAB_SLACK_BOT_TOKEN` repository
secret to a bot token with `chat:write`, and set the `KRAB_SLACK_USER_ID`
repository variable to the recipient's Slack user ID.

`npm run refresh:nfd` remains a shortcut for the NFD group.

### Updating or rolling back an upstream pin

For a source release, choose one group (`kata`, `nfd`, `device-plugin`, `qgs`, or
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
`npm run generate`. It updates `package-lock.json`, the pre-flight Rust package
and lockfile versions, both chart versions, the
release notice, installation examples, and the generated catalog. It also
starts a new changelog section; add the release notes and date there. CI checks
that the generated copies are committed.

Dispatch the chart release workflow from `main`. It runs the application and
pre-flight checks, publishes the pre-flight image to
`ghcr.io/fidencio/krab-preflight` and `ghcr.io/fidencio/krab-collector`, packages and attests both charts, and
publishes them to `oci://ghcr.io/fidencio/krab` and
`oci://ghcr.io/fidencio/krab-precheck`. It verifies anonymous access to all
three artifacts before creating the matching `chart-vX.Y.Z` tag and
GitHub release with both chart packages and a versioned builder archive.
Reruns verify existing artifacts without changing a published release. A run
started from an older `main` commit stops before publication. Publication is
refused while any pinned upstream OCI dependency is unavailable.

The home page uses the newest published stable release's builder and chart
contract. Its version menu links to older stable releases and to Next,
which builds from `main` at `/dev/`. Prereleases are omitted from the stable
release list.

The release also includes SPDX SBOMs for both packaged charts and for each
published pre-flight image architecture (`amd64`, `arm64`, `ppc64le`, and
`s390x`). The chart SBOMs list the packaged subcharts, their nested
dependencies, and every container image in the packaged chart defaults after
KRAB's overrides. They also include KRAB's optional, digest-pinned EROFS
utility image. Upstream image references that use tags are identified by those
tags; KRAB does not claim to inventory the contents of upstream images. The
four pre-flight image SBOMs describe the contents of each published image
manifest. All six SBOM files are in `SHA256SUMS` and have GitHub attestations;
the pre-flight image attestations are also attached to their GHCR manifests.
Pull requests build the same chart SBOMs and per-architecture pre-flight image
SBOMs as downloadable workflow artifacts. They also fail if a rendered image is
missing from a chart SBOM.

For a prerelease, specify its version explicitly when installing with Helm:

```sh
helm upgrade --install krab oci://ghcr.io/fidencio/krab \
  --version 0.2.1 \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

See [CHANGELOG.md](CHANGELOG.md) for release contents and known limitations.

## GitHub Pages

The Pages workflow runs generation, tests, lint, and the production build. It
sets Vite's base path from the repository name, so the resulting application is
fully static and works from a project Pages URL.
