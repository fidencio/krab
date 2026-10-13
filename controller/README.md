# Experimental KRAB controller

This Rust prototype prepares newly eligible Linux nodes using the pinned Kata
and GPU provisioner Job templates. One controller processes all applicable
stages, with one mutating Job per node and two Jobs globally by default.
NFD, the Kata device plugin, and TDX QGS keep their native Kubernetes workloads.
Their pod readiness is not yet aggregated into controller status.

This is a local experiment, disabled in ordinary KRAB deployments. The image is
not published by the release workflow and the builder does not expose it yet.
Use a fresh test cluster. Existing installations require an adoption workflow
that is not implemented. This prototype deliberately removes Kata/provisioner
install, verification, and cleanup hooks and their ServiceAccounts/RBAC.
**Uninstall stops reconciliation but leaves host configuration installed.**
Do not convert an existing Helm release to this mode.

## Try it

Requirements: Helm 4 with combined hook post-rendering, Node.js and the repo's
dependencies, a container builder, and a test cluster with Kubernetes reporting
`status.runtimeHandlers` when Kata handlers are requested. Helm 3 does not pass
hooks to post-renderers and is unsupported. See
[Helm's hook post-rendering contract](https://helm.sh/docs/topics/advanced/#hooks-and-post-render-strategy).

From the repository root:

```sh
npm ci
helm dependency build charts/krab
docker build --file controller/Dockerfile --tag YOUR_REGISTRY/krab-controller:trial .
docker push YOUR_REGISTRY/krab-controller:trial
helm plugin install ./controller --verify=false

export KRAB_CONTROLLER_ROOT="$PWD"
export KRAB_CONTROLLER_IMAGE=YOUR_REGISTRY/krab-controller:trial
export KRAB_CONTROLLER_NAMESPACE=kata-system
export KRAB_CONTROLLER_PARALLELISM=2

helm template krab charts/krab --namespace kata-system \
  --values values.yaml \
  --set kata-deploy.deploymentMode=job \
  --set kata-deploy.job.reconcile.enabled=false \
  --post-renderer krab-controller > /tmp/krab-controller-review.yaml
```

`values.yaml` is the normal builder output. Review the rendered resources,
especially the installer images and host mounts. Install the same configuration:

```sh
helm upgrade --install krab charts/krab --namespace kata-system --create-namespace \
  --values values.yaml \
  --set kata-deploy.deploymentMode=job \
  --set kata-deploy.job.reconcile.enabled=false \
  --post-renderer krab-controller

kubectl -n kata-system logs deployment/krab-controller
kubectl -n kata-system get jobs -l krab.io/controller=krab-controller
kubectl -n kata-system get configmap krab-controller-state \
  -o jsonpath='{.data.state\.json}'
```

Helm installation now completes before node provisioning completes. Inspect the
state ConfigMap and Job results; Helm success is not node readiness. Always use
the same renderer when updating this release. `KRAB_CONTROLLER_NAME` changes
the default name; keep it stable for the release's lifetime. The controller
namespace must be the release namespace. Publicly accessible controller images
are simplest for the prototype's host-identity guard; private images require
the installer templates' image pull secrets to cover the controller image too.

Once installed, add an eligible node through the cluster's usual lifecycle
tooling. The next reconciliation discovers it and runs only its applicable
setup stages. The controller does not create machines or delete Nodes.

## Permissions and execution

The controller polls every ten seconds. It has these additional permissions:

| Scope | Resource | Verbs |
| --- | --- | --- |
| Cluster | Nodes | get, list, patch |
| Release namespace | Jobs | create, get, list |
| Release namespace | One named state ConfigMap | get, update |
| Release namespace | One named leader Lease | get, update |

No Pod, log, Secret, exec, node proxy, RBAC-management, or workload-management
permissions are granted to the controller. Existing component permissions,
including NFD's, remain. Installer Jobs run under a separate ServiceAccount with
no grants and `automountServiceAccountToken: false`. The controller runs as a
non-root process with a read-only filesystem. Place it on trusted infrastructure
by adding node selection/tolerations to its generated Deployment before install
or extending the adapter for your environment.

Node patches preserve the upstream readiness and instance labels. UID and
machine-ID JSON Patch tests prevent writing labels to a replaced host. The
first initContainer checks the mounted host `/etc/machine-id` before any
installer stage runs. Startup taint removal is rejected by the adapter.

RBAC does not constrain which Job specifications the controller may create, or
which Node label keys it may patch. Privileged host installers remain powerful.
For enforced restrictions, install admission policies limiting images, commands,
host mounts, worker ServiceAccount and token mounting, and Node patch keys.
This prototype does not install those policies. Use a dedicated trusted namespace
and restrict who may change its templates or create workloads there.

## Recovery and boundaries

The pre-created Lease provides leader election. State records node UID, machine
identity, the plan revision, stage revision, Job name, phase, and failure reason.
Intent is persisted before a Job is created, so a restarted controller observes
the same Job. If intent exists but the Job does not, reconciliation halts for
operator investigation: a crash immediately before submission cannot be
distinguished from a lost installer outcome. Successful state survives Job TTL cleanup. Kubernetes Job retries
use the existing template's `backoffLimit`; a terminal failure is retained for
operator investigation, with no controller-level automatic retry yet.

Existing-node plan changes are blocked. Selector removal never triggers host
cleanup. Two GPU profiles matching one node are blocked before any setup Job
starts. A changed identity is treated as a new machine, but stale installation
labels block automatic adoption. A missing Job with an unrecorded outcome fails
closed. Missing machine facts defer installation; missing runtime handlers block
Kata verification. Verification times out after ten minutes. The state ConfigMap
has a 700 KB budget; sharded status is needed before very large fleet trials.
Nodes leaving selection retain their state and Jobs; no automatic cancellation
or cleanup is attempted. The controller is not an autoscaler, upgrade manager,
drain controller, or continuous host-drift detector.

The adapter fails on unknown dispatcher flags and rejects Kata DaemonSet mode
and its CronJob reconciler. It supports the pinned charts in this checkout.
Long term, upstream charts should expose a native externally managed mode so
KRAB can consume their templates without a post-renderer.

## Checks

```sh
cargo test --locked --manifest-path controller/Cargo.toml
cargo clippy --locked --manifest-path controller/Cargo.toml --all-targets -- -D warnings
cargo fmt --check --manifest-path controller/Cargo.toml
npm run test:controller:render
```

Rust tests exercise actual HTTP calls against a fake Kubernetes API, including
durable restart recovery, lease contention, unknown Job outcomes, conflicting
GPU profiles, and stage serialization. Render tests use the pinned charts and
check template extraction, retained native workloads, rejected configurations,
and the controller's RBAC. These checks do not replace a real GPU/node trial.
