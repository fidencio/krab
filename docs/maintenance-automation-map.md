# Maintenance automation map

This map describes the repository as of 2026-09-25. It separates data that can
come from pinned upstream projects from KRAB policy that needs human review.

The [release builder decision](release-builders.md) covers fully usable
historical tabs and immutable site archives. No Kata Containers change is
needed for the current automation plan.

## Current data flow

`upstream/sources.lock.yaml` pins 22 upstream files by ref and SHA-256.
`scripts/sync-upstream.ts` verifies those files and generates
`src/generated/catalog.json` and `provenance.json`. It already derives chart
metadata, most image defaults, Kata shims, provisioner profile values, device
resource names. The generator also updates chart dependencies, image defaults,
the precheck image and dispatcher, and KRAB release versions. Pages and release
CI regenerate these files and reject an out-of-date tree.

The [field ownership map](../scripts/upstream/OWNERS.md) identifies the input
for generated catalog fields, chart defaults, and the precheck image. The
generator entry point coordinates `scripts/upstream/`: `sources.ts` verifies
the locked sources, `inputs.ts` parses them, `policy.ts` reads KRAB's reviewed
compatibility and presentation choices, `build-catalog.ts` assembles the derived
data, and `outputs.ts` writes it. The application build type checks this path.

The weekly `refresh-upstream.yml` workflow now checks Kata, NFD, device plugin,
and provisioner releases separately. It resolves each candidate tag to a commit,
checksums the locked source paths, regenerates KRAB, and proposes a PR after
the published chart and tests pass. Missing files or artifacts block that group.

## Automation inventory

| Priority | Data or task | Current copies and source | Automation to add | Review boundary |
| --- | --- | --- | --- | --- |
| Done | Upstream release discovery | Refs, release labels, and checksums in `upstream/sources.lock.yaml`; chart versions in `charts/krab/Chart.yaml` | The weekly job discovers release tags for Kata, NFD, device plugin, and provisioner, resolves immutable commits, updates checksums, regenerates, and proposes one PR per group after validation. Missing paths and unavailable charts fail that group. | Keep the selected version and compatibility decision in a reviewed PR. Never deploy or release directly from discovery. |
| Done | KRAB chart dependency metadata | `charts/krab/Chart.yaml` contains generated upstream chart versions and repositories | `sync-chart-dependencies.ts` derives them from pinned releases and an explicit OCI registry mapping. CI checks the output and published artifacts. | Whether each dependency is required and whether NVIDIA gates it belongs to KRAB. |
| Done | Umbrella chart image defaults | `charts/krab/values.yaml` contains generated upstream image defaults | `sync-chart-images.ts` updates the upstream owned fields while keeping deployment policy explicit. | `nvidia.enabled`, nested NFD disablement, `shims.disableAll`, and other deployment policy stay in KRAB. |
| Done | Precheck provisioner binary image | `Dockerfile.precheck` contains generated provisioner image references | `sync-precheck.ts` uses the pinned provisioner release and verified amd64/arm64 manifest digest. | Digest updates and changes to the inspected binary still need review and a smoke test. |
| Done | KRAB release version and examples | `package.json` is the release version input | Generation updates the lockfile, charts, notice, install examples, catalog, and changelog heading. CI checks the generated copies. | Release timing, date, and release-note content remain editorial. |
| Done | Precheck dispatcher image | `charts/precheck/values.yaml` shows the generated dispatcher image | `sync-precheck.ts` derives it from the pinned provisioner values, independently of Kata's dispatcher version. | Compatibility still needs review when the provisioner release changes. |
| Done | GPU model choices | `src/NodePrecheckPanel.tsx` reads the generated catalog | The model options are deduplicated from the pinned provisioner profiles; README model examples were updated. | Profile descriptions are not a complete hardware support matrix. Keep support availability and aliases reviewed. |
| Done | EROFS utility image | `upstream/erofs-utils-image.lock.json` pins the Quay digest and amd64/arm64 manifests | The UI and artifact builder use the same lock; CI verifies it and a weekly job proposes newer tags. | Quay proves publication and platform coverage, not compatibility with Kata. Keep the minimum version and installation policy explicit. |
| Done | Precheck contract and release identifiers | `contracts/precheck-v1.schema.json` defines the report; `upstream/precheck-command.json` defines command metadata | Browser uploads and the image smoke test validate against the schema. Generation renders the README command; the UI uses the same configuration. | Probe semantics, privileges, and meaning of unknown results need explicit review. |
| Done | TEE selectors | `upstream/compatibility.json` keeps the selector policy; pinned Kata rules, provisioner rules, and NFD v0.19 docs define the labels | Generation verifies SNP/TDX against Kata, IBM SE against NFD, and profile selectors against the provisioner rule. | Distribution usability remains local policy until Kata publishes structured support data. |
| Done | Compatibility and availability claims | `upstream/compatibility.json` records family availability, architecture, profile modes, TEE mapping, aliases, and pinned evidence IDs | Generation checks these decisions against pinned profiles and Kata runtime arches and emits catalog evidence links. | New profiles stay unavailable until reviewed. `grace-blackwell` remains pending despite its profile. |
| Done | Vendor copy and presentation | `upstream/presentation.json` owns vendor names, descriptions, logos, and ordering | Generation checks that every supported vendor has complete presentation data and an existing logo. The catalog is unchanged. | Wording, ordering, and branding are editorial choices. |

## Upstream chart contracts worth contributing

These requests would remove parsing and duplication in KRAB. They are upstream
project work, separate from the local generation work above.

| Project | What the pinned chart already gives KRAB | Smallest useful upstream addition | KRAB data it could replace |
| --- | --- | --- | --- |
| kata-device-provisioner | Chart and app versions, image and dispatcher defaults, profile values, and the `NodeFeatureRule` defining `kata.feature.node.kubernetes.io/nvidia-*` labels | The profile index and catalog are in an open PR. No additional change is needed for node labels: profile values already carry their selectors and the chart already defines the rules that produce them. | Once released, replace README parsing and the local profile-to-family map with the pinned catalog; validate selectors against the chart rule. KRAB still decides whether the whole Kata stack supports a combination. |
| kata-deploy | Chart metadata, shim values with `supportedArches`, image defaults, examples, and the `NodeFeatureRule` defining the AMD SNP and Intel TDX labels | No change is needed for the labels. Structured shim capabilities and supported distribution IDs could still remove other KRAB heuristics if Kata chooses to publish them. | Validate KRAB's AMD and Intel TEE selectors against the pinned chart rule. The distribution-list comment parser and shim-name heuristics remain. |
| kata-device-plugin | Chart and app versions, image repository, and `resourceNaming` default; resource names currently come from Rust source | A generated resource index and values schema are in an open PR. Do not invent a provisioner or dispatcher compatibility range without tested evidence. | Once released, replace source-code regexes for `nvidia.com/gpu` and `nvidia.com/nvswitch` and use the pinned chart/image mapping. |
| Node Feature Discovery | Chart metadata and image defaults; built-in labels include `feature.node.kubernetes.io/cpu-security.se.enabled` for IBM Secure Execution and CPU virtualization flags | No new NFD label contract is needed for KRAB's current selectors. NFD applies the Kata and provisioner `NodeFeatureRule` objects; those projects own their custom label definitions. | Use NFD's documented IBM label and keep the chart/app version distinction explicit. |

The provisioner profile catalog and device-plugin resource index are in open
PRs. Their KRAB consumers should be changed once those files ship in pinned
chart releases. Existing chart rules already define the NFD-applied labels;
label ownership does not require another upstream PR.

The locked NFD source `Chart.yaml` version differs from the published chart
version. KRAB now uses the reviewed release tag for the OCI chart version and
checks that the published artifact exists. The app version remains distinct.

## End-to-end implementation plan

The stages below cover every row in the inventory. Each stage can be reviewed
independently, but its output becomes the input to the following stages.

### 1. Establish ownership and generation checks (implemented)

- `scripts/upstream/OWNERS.md` maps generated catalog fields, chart defaults,
  and the precheck image to pinned upstream files, KRAB release metadata, or
  KRAB policy. Keep it beside the generator as new fields are added.
- Split `sync-upstream.ts` into source acquisition, upstream parsing, policy
  application, and output rendering (done). CI regenerates and compares the
  committed output, so changes to deployment values remain visible in the PR.
- Keep `npm run generate` as the command for all derived files. Pages and release
  CI already check the generated tree, including chart dependencies and image
  defaults; extend those checks to each new output.

**Done when:** every repeated value in the inventory has a declared owner and
CI detects an out-of-date generated file.

### 2. Automate upstream candidate intake (implemented)

- Add read-only release discovery for each of the four tracked project groups:
  Kata, NFD, device plugin, and provisioner. Resolve a
  candidate tag to an immutable commit and check that its locked paths exist.
- Add a group update command that downloads those files, computes checksums,
  updates the lock, parses the candidate, and regenerates all outputs. Make
  failures specific: missing file, unexpected schema, incompatible chart
  version, or unavailable OCI artifact.
- Change the weekly workflow to propose one reviewed PR per compatible group.
  Keep security and compatibility checks in CI. Do not auto-merge, deploy, or
  publish a candidate merely because it parsed successfully.

**Done when:** a newer upstream release produces a complete reviewable PR or
a concrete failure report without a partial lockfile update.

### 3. Eliminate upstream data copies (mostly implemented)

- Chart dependency versions and repositories are generated from locked chart
  metadata and an explicit OCI registry mapping.
- Upstream owned image defaults are generated in `charts/krab/values.yaml`;
  KRAB's enablement, nesting, and shim policies stay explicit.
- The precheck Dockerfile uses the locked provisioner release and verified
  multi-architecture digest. Its dispatcher comes from the provisioner values.
- Once the upstream profile catalog and device-plugin index are released,
  consume them and remove KRAB's README and Rust-source parsers.
- Discover EROFS utility releases from Quay, pin the selected version and
  digest, and verify platform coverage. Use the pinned reference in the UI and
  artifact builder; keep Kata's minimum version requirement as a separate
  compatibility check.

**Done when:** advancing one upstream group updates every copied version,
image, and chart field without hand editing, and a rendered Helm smoke test
covers default and NVIDIA configurations.

### 4. Centralize KRAB release and precheck contracts (release version done)

- `package.json` `version` is now the only release version input. Generation
  updates the lockfile, charts, notice, examples, changelog heading, catalog,
  and provenance; Pages and release CI check those outputs.
- Define the node precheck report schema and check identifiers in a versioned
  contract. Validate shell output fixtures, TypeScript parsing, and examples
  against it. Use a shared command configuration for the precheck chart URL,
  release name, namespace, and displayed install command.
- Separate generated documentation facts from prose. Check that release
  versions and supported GPU model lists in docs match their source data.

**Done when:** changing only `package.json` `version` and running generation
updates every release version copy; a later CI run produces no diff. No test,
chart, lockfile, notice, changelog heading, install example, or release tag
requires a second manual version edit.

### 5. Make supported choices evidence driven

- Put GPU family availability, architecture coverage, GPU mode to CPU TEE
  mapping, and model aliases into a reviewed compatibility matrix with evidence
  for each claim. Generate the selectable catalog from that matrix and the
  locked profiles. Keep pending support pending until the matrix changes.
- Precheck GPU model options now come from the provisioner profiles in the
  generated catalog. Test inventory `chip` and display-name aliases against
  representative node reports as the compatibility matrix is built.
- Validate AMD and Intel selectors against Kata's existing `NodeFeatureRule`,
  IBM Secure Execution against NFD's built-in label, and NVIDIA selectors
  against the provisioner profiles and rule. No upstream label change is needed.
  Keep distribution names without structured upstream data as local policy.
- The README now describes the checks KRAB actually performs against pinned
  inputs. Vendor copy, logos, and ordering live in a local presentation file.

**Done when:** each selectable combination has a matching upstream profile,
an explicit KRAB support decision, and a representative generated-values and
node-report fixture. New upstream profiles cannot automatically become
selectable.

### 6. Retire duplication and keep the system observable

- Remove old constants and cross-file version copies after their consumers use
  generated data or the local policy files. Keep direct contract tests for the
  generated values and rendered Helm output; remove tests that merely restate
  a now-generated constant.
- Have the weekly job summarize pinned releases, discovered candidates, proposed
  PRs, blocked updates, and candidates with no PR (implemented). Include the
  locked ref and source checksum in generated provenance so a support claim can
  be traced to a reviewed PR.
- The README documents source and EROFS update commands, chart and image
  verification, and rollback of a reviewed PR (implemented). The revert keeps
  its lockfile and generated artifacts together.

**Done when:** routine upstream and KRAB version updates require one reviewed
input change each, CI detects drift, and unsupported candidates are visible
without changing the published builder.

`README.md` now describes the checks KRAB actually performs against its locked
inputs and reviewed compatibility matrix. NVIDIA Confidential Containers
documentation is not a locked input, so it is not presented as an automated
validation source.
