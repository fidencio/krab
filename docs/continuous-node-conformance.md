# Host conformance daemon prototype

KRAB installs its existing `krab-preflight` checker binary and systemd service
through `krab-preflight conformance install`. The checker's
`conformance --local --daemon` mode stays running,
launches bounded one-shot local checks, and publishes expiring raw NFD features.
The existing evaluator remains responsible for PASS/FAIL/ERROR decisions. No
Kubernetes credentials, Helm, or kubectl are needed on the checking path.

This is opt-in and has not been deployed to a production Kubernetes cluster.
The checker, installer, systemd configuration, and opt-in NFD rules all belong to
KRAB. The GPU provisioner has no conformance implementation or dependency on this
service. A deployment can run KRAB's installer alongside GPU provisioning, or
independently on CPU-only nodes.

## Install and activate

Build the checker for the target Linux architecture and host ABI (or use a
compatible static Linux checker artifact):

```sh
cargo build --release --manifest-path preflight/Cargo.toml
```

Set `CHECKER_SHA256` from a trusted build/release manifest. On the host:

```sh
sudo /path/to/krab-preflight conformance install \
  --checker-sha256 "$CHECKER_SHA256" \
  --require cc --require-any gpu-cc,gpu-ppcie
```

The live installer validates its inputs, stops the existing service during an
upgrade, installs the new files, reloads systemd, and runs:

```sh
systemctl enable --now krab-conformance.service
```

It then verifies that the service is active. Choose requirements appropriate to
that node pool; use `--require kvm` for basic CPU-only virtualization. Installation
is independent of GPU `apply`, so CPU-only nodes can receive the same integration.
Run it through the provisioning workflow on every intended node, including newly
added nodes. No provisioner executable is needed or copied to the host. By default
the installer copies its own executable; `--checker /path/to/artifact` selects a
different host-compatible checker artifact.

From a privileged deployment Job, `--host-root /host` installs into the
mounted host tree and runs host systemctl after entering host PID 1's mount
namespace and root. This needs host `/proc` access, `CAP_SYS_ADMIN`, and
`CAP_SYS_CHROOT`, as well as a host-PID deployment and host filesystem mount.
It still uses `systemctl enable --now` and checks that the service is active.

For a genuinely offline filesystem, `--offline --host-root /host` writes files
and boot enablement without contacting systemd or claiming a running daemon.
Before using that host, run `systemctl daemon-reload` and `systemctl enable --now
krab-conformance.service` through host management.

Installation writes:

| Host path | Purpose |
| --- | --- |
| `/opt/krab/conformance/krab-preflight` | The only installed executable |
| `/etc/krab/conformance.sha256` | Expected checker digest, writable only by root |
| `/etc/systemd/system/krab-conformance.service` | Supervised service |
| `/etc/systemd/system/multi-user.target.wants/krab-conformance.service` | Boot enablement |
| `/var/lib/krab/conformance/latest.json` | Latest complete evidence |
| `/var/lib/krab/conformance/lock` | Daemon/install/remove exclusion |
| `/run/krab/features/conformance` | Expiring NFD result |
| `/etc/kubernetes/node-feature-discovery/features.d/krab-conformance` | Symlink to the volatile result |

The host must provide systemd, `/usr/bin/systemctl`, `/usr/bin/sha256sum`, and
`/usr/bin/rm`. Installation and removal acquire the same lock as the daemon
before modifying its files. This prototype uses KRAB-owned paths; remove an earlier provisioner-owned
prototype with its original installer before switching to this version.

## Supervision and privileges

The service uses `Type=notify`, `Restart=always`, `RestartSec=5s`, and a 30-second
systemd watchdog. It sends watchdog heartbeats while waiting for a check and
between checks. Systemd restarts crashes, unexpected exits, and a frozen daemon;
startup retries are not disabled by a start-rate limit. `KillMode=control-group`
and a ten-second stop deadline keep service children within the same lifecycle.
An explicit `systemctl stop` stops the service without an automatic restart.

The daemon checks immediately, then schedules checks on a 60-second cadence.
An overrun skips missed slots; it never starts overlapping checks.
Each check has a 30-second timeout; no checks overlap. A timed-out or unexpectedly
terminated checker makes the daemon exit so systemd can restart it. A completed
FAIL or ERROR is a reported conformance outcome, and the daemon continues checking.
If the checker cannot publish the outcome it reported, the daemon fails and
systemd restarts it. Local checks never reconfigure devices to repair a failure.

`--interval-seconds`, `--timeout-seconds`, and `--ttl-seconds` on installation
configure these limits. Result TTL defaults to 180 seconds and must exceed the
interval, check timeout and 15-second verification deadline. It is measured from
collection start, not publication.

`DynamicUser=yes` and `User=krab-conformance` give the daemon an unprivileged
systemd-managed identity. `StateDirectory` and `RuntimeDirectory` grant it access
to its output paths; the executable, manifest and service definition remain
protected. The service clears capabilities, enables `NoNewPrivileges`, protects
system paths against writes, and permits only Unix-domain sockets. It does not
hide host device metadata needed by the checks.

`RuntimeDirectoryPreserve=yes` preserves the directory inode across service
restarts so an existing NFD directory bind mount keeps seeing new results.
Individual result files are withdrawn on stop/failure. `/run` must be volatile
on the target host; its contents disappear on reboot.

The checks read host prerequisites and static GPU capabilities. They do not open
KVM, map GPU BAR0, change modes, reset devices, or require a provisioner executable.
Local GPU inventory uses the pinned shared `pcilibs-rs` library directly. Restricted
host evidence can yield a non-passing result. The existing container-based
cluster/node-report collection path retains its existing bundled inventory helper.

## Binary integrity

Systemd runs the host's `sha256sum` before executing the daemon. The daemon also
uses that verifier before launching each one-shot check. A changed executable is
not launched; the service fails, the result is withdrawn, and systemd retries.
The service can recover automatically after the expected executable is restored.

`--checker-sha256` pins the artifact before installation. Without it the installer
records the supplied file's digest as its baseline. The manifest is separate from
writable state. It is readable by the service but writable only by root.

This assumes trusted host tools, systemd configuration and an expected digest.
It detects drift; it does not defend against an attacker who controls those
components or replaces a file between verification and execution. For stronger
kernel-enforced verification, investigate [fs-verity with authenticated digests
and IMA/IPE policy](https://docs.kernel.org/filesystems/fsverity.html), or a
verified read-only host image. Those mechanisms are outside this prototype.

## NFD integration, only when conformance is enabled

Keep the existing NFD `features.d` host mount. Add a read-only host mount of
`/run/krab/features` at the same absolute container path,
using the example [existing-worker patch](../prototypes/node-conformance/nfd-worker-mount.patch.yaml).
Adjust its workload name, namespace and container name in the cluster
deployment source. Mount
the directory rather than a file through `subPath`, so atomic replacements stay
visible. This modifies the existing NFD worker and adds no checker DaemonSet.

Enable `local` discovery, publish `local.feature` (do not exclude it with
`core.noPublishFeatures`), allow the resulting label through configured filters,
and keep a finite rediscovery interval. KRAB explicitly sets `core.sleepInterval`
to `60s`, matching the checker default and upstream NFD. The two polling loops
can add approximately two minutes plus processing time before a change reaches
the node label. Faster local checks alone do not guarantee faster publication. The checker
atomically writes:

```text
# +expiry-time=<RFC3339 UTC deadline>
# +no-label
krab.conformance.state=pass
```

The KRAB chart installs its `NodeFeatureRule` only with explicit enablement:

```yaml
nodeConformance:
  enabled: true
```

The default is `false`. The [conditional rule](../charts/krab/templates/conformance-feature-rules.yaml)
matches exactly `pass`, `fail`, and `error` in `local.feature` attribute
`krab.conformance.state`, and publishes the corresponding
`feature.node.kubernetes.io/krab-conformance` label. Missing and expired features
match no rule and must never count as PASS. If using external NFD, install its
CRDs first. Keep the flag and mount overlay opt-in alongside host service setup.
Disabling the flag removes the rule through Helm; label withdrawal then depends
on NFD reconciliation. Stop/remove the host service separately when removing
conformance from nodes.

NFD evaluates expiry during rediscovery; it is not an independent Kubernetes
label TTL. Monitor NFD availability separately. A stored node label cannot prove
freshness while NFD publication is unavailable. See the [NFD file format](https://kubernetes-sigs.github.io/node-feature-discovery/stable/usage/customization-guide.html#input-format).

## Reboots and alerts

The enabled service starts after local filesystems and configured kernel modules,
without depending on kubelet, containerd, or Kubernetes availability. It collects
new evidence, including the current boot ID. It does not interpret Kubernetes
being down as a conformance failure. Old result files disappear with `/run`, but
stored Kubernetes labels converge only when NFD resumes discovery/publication.

Do not alert on an absent label alone during reboot. A conformance alert should
require `NodeReady`, account for current-boot evidence and NFD freshness, and use
a bounded startup grace period after readiness returns. Alert separately when a
node stays NotReady or NFD never recovers. Required host devices/modules may also
be temporarily unavailable during startup. Never suppress those conditions
indefinitely. The prototype does not install alerting rules, so readiness/grace
suppression must be supplied by the monitoring deployment.

## Inspect or remove

```sh
systemctl status krab-conformance.service
journalctl -u krab-conformance.service
systemctl show krab-conformance.service -p MainPID -p NRestarts -p Result
sudo /opt/krab/conformance/krab-preflight conformance remove
```

Removal disables and stops the service before deleting owned files, reloads
systemd, and retains saved JSON evidence. The installed checker can remove
itself. Removing GPU provisioning does not remove this separately managed service.
For an offline filesystem, stop the service through host management before
using `conformance remove --offline --host-root /host`. Remove the extra NFD mount
from cluster configuration when no longer needed.

## Validation

All 62 checker, daemon, and installer tests pass in the Linux VM. They
cover one-shot and daemon behavior, including repeated
PASS/FAIL checks, singleton exclusion, systemd notifications, graceful signal
handling, integrity rejection, a bounded hung check, and rejection of partial
PCI inventory. An unreadable device cannot be silently omitted to produce PASS.
The checker release build and Clippy pass (pre-existing EROFS warnings are allowed).
An offline public-CLI test verifies default self-installation, artifact rejection
before mutation, and removal through the installed checker while retaining evidence.
A real systemd smoke test verifies `enable --now`, native and mounted-host
activation, upgrades, cleanup, a non-root service, crash restart, watchdog
recovery after freezing the process, integrity failure/recovery, normal FAIL
without restarting, and explicit stop with result cleanup. A Helm render test
verifies the NFD rule's opt-in behavior.

A disposable K3s v1.37.2+k3s1 cluster with NFD v0.20.0 verified actual node
labels for PASS/FAIL/ERROR, expiry withdrawal, policy disable/re-enable, runtime
directory migration with a live mount, and worker restart without a result file.
The test used a one-second NFD refresh only to shorten the test; deployed defaults
remain 60 seconds. The [manual NFD verification driver](../prototypes/node-conformance/verify-nfd.py)
refuses containers without the `org.krab.test=node-conformance` label and checks
that its input/result paths are the disposable container's mounts. It requires
a Linux checker and a disposable container providing kubectl, the NFD worker
mounts, and the rendered conformance rule; it never uses the caller's kubeconfig.

A real `systemctl reboot` on the Ubuntu 26.04 arm64 VM verified automatic
startup without manually starting the service. The first current-boot result
was PASS at 3.44 seconds after boot, with no service restarts. The daemon ran
as a non-root dynamic user, the checker digest was unchanged, and only the
checker was installed. This test used the KRAB-owned installer and paths.
Previous-boot runtime evidence disappeared, and the
new NFD feature had a future expiry. The next check ran exactly 60 seconds
later and also passed. The temporary installation was removed after testing.
Real GPU hardware remains untested;
this CPU-only reboot test does not validate Kubernetes alert suppression.

The [manual reboot verification driver](../prototypes/node-conformance/verify-reboot.py)
requires root and an explicit expected hostname on a disposable systemd VM.
Its `setup` phase refuses an existing conformance installation, installs the
checker with `--require kvm`, and records the baseline. Reboot the VM separately,
then run `verify` and `observe` to check automatic startup and the next scheduled
result. Copy the report from `/var/lib/krab-conformance-reboot-test/report.json`
before running `cleanup`, which invokes removal through the installed checker.
Pass `--expected-hostname <hostname>` to every phase and `--checker` to `setup`.
The verification script itself must be available again after reboot.

## Resource measurement

On the Linux arm64 build VM after moving installation into KRAB, the daemon's
resident memory was 4.9 MiB. The service cgroup peaked at 13.7 MiB during boot;
cgroup accounting includes file-backed pages and differs from process RSS.

An earlier CPU-only run, before moving the installer, measured 0.107 CPU-seconds
for startup plus the first check, and 0.0059 CPU-seconds during a 30-second idle
sample (about 0.02% of one CPU core). That run produced its first result in
0.13 seconds after service activation. The reboot timing above includes host boot.

These are VM measurements, not a GPU-node capacity guarantee. Validate a
representative GPU node before tightening deadlines or increasing frequency.
