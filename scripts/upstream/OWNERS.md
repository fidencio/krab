# Generated data owners

`catalog-owners.json` is the machine-checked index for this map. The test
fails when a generated catalog field has no matching owner, so add a new field
there and explain its source here in the same change.

This map describes the inputs to `npm run generate`. A path ending in `.*`
includes every field below it. `[]` means each array item; a profile or shim
name is a dynamic key. `[nvidia,custom]` selects those vendor IDs. When a row
names a whole object, more specific rows
below it take precedence. The owner is the place to change the value, even
when the generator validates it against another source or formats it for output.

Upstream file IDs refer to `upstream/sources.lock.yaml`. Its ref and checksum
pin each file; `scripts/upstream/sources.ts` verifies the cached content. The
files under `upstream/` named below are KRAB inputs and require review. The
generator itself owns derived labels, links, ordering, and schema versions.

## `src/generated/catalog.json`

| Path | Owner | How the value is used |
| --- | --- | --- |
| `schemaVersion` | Generator contract | Format version of this catalog. |
| `plannedArchitecture.schemaVersion`, `.namespace`, `.cluster.selinuxValuesPath`, `.charts.krab.*` except version fields | `upstream/architecture.yaml` | KRAB's install and chart policy. |
| `plannedArchitecture.status`, `.notice`, `.charts.krab.version`, `.charts.krab.appVersion` | `package.json` `version` | `sync-release-version.ts` updates the intermediate architecture and chart files. |
| `plannedArchitecture.images.kubectl.*`, `.images.devicePlugin.*` | `upstream/architecture.yaml` | KRAB's selected image pins; the device-plugin repository must agree with `device-plugin-values`. |
| `plannedArchitecture.cluster.distributions[].id`, `.displayName`, `.kataDeployValue`, `.defaultConfigurationOnly` | `upstream/architecture.yaml` | Each Kata distribution value is checked against `kata-values`. |
| `plannedArchitecture.cluster.distributions[].sourceUrl`, `.cluster.selinuxSourceUrl` | `kata-values` | Links to the pinned values file used for validation. |
| `plannedArchitecture.charts.nfd.chartName`, `.appVersion` | `nfd-chart` | NFD's chart metadata. |
| `plannedArchitecture.charts.nfd.version` | `nfd-chart` release in `sources.lock.yaml` | The published chart version comes from the release tag; the source `Chart.yaml` version is not its published version. |
| `plannedArchitecture.charts.nfd.image.*` | `nfd-values`, with an absent tag filled from `nfd-chart` appVersion | Image defaults from NFD. |
| `plannedArchitecture.charts.nfd.repository` | Generator's OCI registry mapping | Published NFD chart location. |
| `plannedArchitecture.charts.nfd.valuesKey`, `.required` | `upstream/architecture.yaml` | KRAB dependency policy. |
| `plannedArchitecture.charts.kataDeploy.chartName`, `.version` | `kata-chart` | Kata chart metadata. |
| `plannedArchitecture.charts.devicePlugin.chartName`, `.version`, `.appVersion` | `device-plugin-chart` | Device-plugin chart metadata. |
| `plannedArchitecture.charts.provisioner.chartName`, `.version`, `.appVersion` | `provisioner-chart` | Provisioner chart metadata. |
| `plannedArchitecture.charts.{kataDeploy,devicePlugin,provisioner}.required` | `upstream/architecture.yaml` | KRAB dependency policy. |
| `plannedArchitecture.charts.{nfd,kataDeploy,devicePlugin,provisioner}.sourceUrl` | Corresponding chart ID in `sources.lock.yaml` | Link to the pinned chart. |
| `plannedArchitecture.attestation.trustee.repository`, `.commit` | `kata-versions` | Trustee source pinned by Kata. |
| `plannedArchitecture.attestation.trustee.displayName`, `.sourceUrl`, `.documentationUrl`, `.kataSourceUrl` | Generator contract | Label and links built from `kata-versions`. |
| `vendors[].id`, `.capabilities[].id`, `.capabilities[].resourceName`, `.hardwareFamilies`, `.runtime`, `.devicePlugin`, `.workload` | Rows below | These objects combine inputs; use their specific rows. |
| `vendors[].displayName`, `.tagline`, `.description`, `.logo`, and vendor order | `upstream/presentation.json` | Editorial copy and branding. |
| `vendors[].sourceUrl` | Generator contract | Link chosen for the vendor path from its pinned Kata source. |
| `vendors[].capabilities[].id` | Generator contract | Capabilities exposed for each path. |
| `vendors[].capabilities[].resourceName` | `device-plugin-code` | GPU resource name until the upstream resource index is released. |
| `vendors[nvidia].capabilities[confidential-computing].modes[]` | Profile values files | `ccMode` values present in selected profiles. |
| `vendors[].hardwareFamilies[].id`, `.displayName`, `.supportedArches[]`, `.availability`, `.availabilityReason`, `.modelAliases.*`, `.modes[].supportedCpuTeeIds[]` | `upstream/compatibility.json` | KRAB support decisions. Availability remains reviewed even when upstream adds a profile. |
| `vendors[].hardwareFamilies[].upstreamName`, `.models[]`, `.modes[].label` | `provisioner-profiles` | Parsed from the pinned README until the upstream catalog is released. |
| `vendors[].hardwareFamilies[].modes[].description`, `.values.*` | Each profile's locked values file | The description is its leading comment; values omit `enabled`. |
| `vendors[].hardwareFamilies[].modes[].profileName`, `.sourcePath`, `.sourceUrl` | Profile name and source ID in `upstream/compatibility.json`; locked source metadata | Identity and provenance for each selected profile. |
| `vendors[].hardwareFamilies[].modes[].id` | Profile values file | String form of its `ccMode`. |
| `vendors[].hardwareFamilies[].modes[].displayName`, `.badge`, and family `.defaultModeId` | Generator contract | Display labels derived from the selected profile's `ccMode`. |
| `vendors[].hardwareFamilies[].evidenceUrls[]` | Evidence IDs in `upstream/compatibility.json` | Resolved through `sources.lock.yaml`. |
| `vendors[].hardwareFamilies[].sourceUrl`, `.experimental` | Generator contract | README provenance and experimental flag. |
| `vendors[].runtime.chart.name`, `.version`, `.appVersion` | `kata-chart` | Kata chart metadata. |
| `vendors[].runtime.chart.ociReference` | `kata-nvidia-profile` | OCI install reference in the pinned example. |
| `vendors[].runtime.chart.namespace` | `upstream/architecture.yaml` for Custom and CPU TEE paths; `provisioner-profiles` for NVIDIA | The latter is parsed from the pinned README. |
| `vendors[].runtime.chart.valuesFileName`, `.sourceUrl` | Generator contract | Output filename and pinned chart link. |
| `vendors[].runtime.chart.values.debug`, `.deploymentMode`, `.snapshotter.*`, `.defaultShim.*`, `.runtimeClasses.*`, `.node-feature-discovery.*` | `kata-values` for Custom and CPU TEE paths; `kata-nvidia-profile` for NVIDIA | Pinned Kata defaults. |
| `vendors[nvidia].runtime.chart.values.containerd.*` and other inherited NVIDIA fields | `kata-nvidia-profile` | Pinned NVIDIA example values. |
| `vendors[].runtime.chart.values.shims.*` except the overrides below | `kata-values` for CPU/local shims; `kata-nvidia-profile` for NVIDIA GPU shims | Pinned Kata shim defaults. |
| `vendors[].runtime.chart.values.shims.disableAll` | Generator contract | KRAB enables only the selected shims. |
| `vendors[custom].runtime.chart.values.shims.{qemu-snp-runtime-rs,qemu-tdx-runtime-rs,qemu-se-runtime-rs}.runtimeClass.nodeSelector.*` | `upstream/compatibility.json` | Reviewed TEE selectors, checked against Kata or NFD rules. |
| `vendors[].runtime.chart.values.shims.qemu-nvidia-cpu-runtime-rs.containerd.snapshotter` | Generator contract | KRAB's EROFS choice for that shim. |
| `vendors[].runtime.chart.values.image.*` | `kata-values`, with an absent tag filled from `kata-chart` appVersion | Kata deployment image. |
| `vendors[].runtime.chart.values.kubectlImage.*` | `upstream/architecture.yaml` | KRAB's selected kubectl image. |
| `vendors[].runtime.chart.values.job.dispatcherImage.*` | `kata-values` | Kata dispatcher image. |
| `vendors[nvidia].runtime.chart.values.job.*` except `dispatcherImage` | `kata-nvidia-profile` | Other pinned NVIDIA job fields. |
| `vendors[].runtime.shims[].id`, `.supportedArches[]`, `.snapshotter`, `.nodeSelector.*` | `kata-values` or `kata-nvidia-profile`, according to the shim | Pinned shim settings, with the two overrides below. |
| `vendors[].runtime.shims[qemu-nvidia-cpu-runtime-rs].snapshotter` | Generator contract | KRAB's EROFS choice. |
| `vendors[custom].runtime.shims[{qemu-snp-runtime-rs,qemu-tdx-runtime-rs,qemu-se-runtime-rs}].nodeSelector.*` | `upstream/compatibility.json` | Reviewed TEE selectors. |
| `vendors[].runtime.shims[].runtimeClass`, `.selectionGroup`, `.userSelectable`, `.snapshotterConfiguration.*`, `.sourceUrl` | Generator contract | RuntimeClass naming, UI grouping, KRAB's EROFS setup, and pinned source link. |
| `vendors[].runtime.cpuTees[].shimId`, `.nodeSelector.*` | `kata-nvidia-profile` | Pinned NVIDIA GPU shims. |
| `vendors[].runtime.cpuTees[].id`, `.displayName`, `.runtimeClass`, `.documentedRuntimeClass`, `.sourceUrl` | Generator contract | SNP/TDX names and links derived from those shims. |
| `vendors[].provisioner.chart.name`, `.version`, `.appVersion` | `provisioner-chart` | Chart metadata. |
| `vendors[].provisioner.chart.namespace` | Same namespace choice as the vendor runtime chart | KRAB install policy. |
| `vendors[].provisioner.chart.repository`, `.ref`, `.pullRequest`, `.chartPath`, `.sourceUrl` | `provisioner-chart` entry in `sources.lock.yaml` | Pinned provenance. |
| `vendors[].provisioner.chart.experimental` | Generator contract | KRAB's experimental marker. |
| `vendors[].provisioner.values.image.*`, `.job.dispatcherImage.*` | `provisioner-values`, with an absent image tag filled from `provisioner-chart` appVersion | Provisioner images. |
| `vendors[].devicePlugin.chart.*` | `plannedArchitecture.charts.devicePlugin` above | Reused chart metadata and KRAB requirement. |
| `vendors[nvidia,custom].devicePlugin.values.*` | `device-plugin-values`, except image fields below | Pinned chart defaults. CPU TEE paths use an empty object. |
| `vendors[nvidia,custom].devicePlugin.values.image.repository`, `.pullPolicy` | `device-plugin-values` | Image defaults from the pinned chart. |
| `vendors[nvidia,custom].devicePlugin.values.image.tag` | `upstream/architecture.yaml` | KRAB's selected image tag. |
| `vendors[].devicePlugin.sourceUrl` | `device-plugin-chart` entry in `sources.lock.yaml` | Pinned chart link. |
| `vendors[nvidia,custom].workload.resourceName`, `.nvSwitchResourceName` | `device-plugin-code` | Parsed from pinned Rust source until the upstream resource index is released. |
| `vendors[nvidia,custom].workload.resourceNaming` | `device-plugin-values` | Pinned chart default. |
| `vendors[].workload.sourceUrl` | `device-plugin-code` for NVIDIA/Custom; `kata-values` for CPU TEE paths | Pinned source link. CPU TEE workload fields are empty by KRAB policy. |

The generator's profile, shim, and image rules are intentionally explicit. A
new upstream field inside a copied values object inherits that object's owner;
a new KRAB decision needs an entry here and in the reviewed policy file.

## Chart defaults and precheck image

| Output path | Owner |
| --- | --- |
| `charts/krab/Chart.yaml` `version`, `appVersion`, `annotations.artifacthub.io/prerelease` | `package.json` `version` through `sync-release-version.ts`. |
| `charts/krab/Chart.yaml` `dependencies[].name`, `condition`, and all other chart metadata | `charts/krab/Chart.yaml` is KRAB policy. |
| `charts/krab/Chart.yaml` `dependencies[node-feature-discovery].version` | `nfd-chart` release in `sources.lock.yaml`. |
| `charts/krab/Chart.yaml` `dependencies[kata-deploy].version`, `dependencies[kata-device-plugin].version`, `dependencies[kata-device-provisioner].version` | Corresponding locked chart files. |
| `charts/krab/Chart.yaml` `dependencies[].repository` | Generator's OCI registry mapping, except Kata's repository, which comes from `kata-nvidia-profile`. |
| `charts/krab/values.yaml` image objects under NFD, kata-deploy, device plugin, and provisioner | Same image owners as the matching catalog paths above; `sync-chart-images.ts` writes only reference/repository and tag. |
| `charts/krab/values.yaml` all other fields | KRAB chart policy in that file: NVIDIA gate, nested NFD disablement, distribution, SELinux, shim choice, resource naming, and empty profile set. |
| `upstream/precheck-image.lock.json` `reference`, `tag` | `provisioner-values`; tag must agree with `provisioner-chart` appVersion. |
| `upstream/precheck-image.lock.json` `digest`, `platforms[]` | Published OCI manifest for that provisioner image, inspected by `sync-precheck.ts`. |
| `upstream/precheck-image.lock.json` `schemaVersion` | Generator contract. |
| `Dockerfile.precheck` two provisioner `FROM` image references | `upstream/precheck-image.lock.json`; `sync-precheck.ts` replaces both references. |
| `Dockerfile.precheck` all other instructions | KRAB's precheck build and runtime policy in that file. |
| `charts/precheck/values.yaml` `dispatcherImage` | `provisioner-values` job dispatcher image. |
| `charts/precheck/values.yaml` `parallelism`, `probeImage.*` | KRAB precheck chart policy in that file. |

To update a value, change its owner and run `npm run generate`. A new upstream
release goes through `npm run refresh:upstream` and a reviewed lockfile update.
CI rejects a PR if regeneration changes committed output. To roll back an
upstream update, revert its lockfile and generated-file commit together.
