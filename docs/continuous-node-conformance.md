# Continuous node conformance

Enable **Continuous conformance** in the website or terminal editor’s advanced
settings. The equivalent CLI flag is:

```sh
krab init --non-interactive --continuous-conformance --output krab.yaml
krab install --config krab.yaml --context my-cluster
```

Review the deployment plan, then add `--execute` to install. The only configuration
field is `advanced.continuousConformance: true`. KRAB generates the host policy
from the selected runtimes, enables NFD discovery, and requires a fresh passing result in generated RuntimeClasses. No separate
systemd installation, NFD worker patch, or existing deployment is required.

Continuous conformance and new-node installation are independent. Enable the
separate **New nodes** reconciliation setting to install on nodes that join later,
or reapply the deployment through your cluster lifecycle automation. Conformance
does not enable or change that setting.

## Deployment lifecycle

The pinned Kata per-node pipeline installs artifacts, runs KRAB’s setup stage,
and then registers CRI runtimes. The setup stage installs the checksum-verified
static checker and enables `krab-conformance.service`. The deployment job uses
host privileges during installation; ongoing checks run as an unprivileged host
service without Kubernetes credentials.

The service checks immediately and every 60 seconds. Systemd supervises it and
restarts it after a crash or watchdog timeout. Its policy accepts a complete
selected runtime profile for the node’s architecture: CPU and GPU requirements
from different profiles cannot be combined. CPU-only profiles need no GPU.
KVM is always required. Additional requirements follow the selected runtime,
including TDX, SNP, GPU modes, and EROFS where appropriate.

NFD discovers `/run/krab/features` through a read-only host mount and maps fresh
results to `feature.node.kubernetes.io/krab-conformance=pass|fail|error`.
Missing or expired results cannot satisfy the RuntimeClass pass selector.
Allow for checker and NFD polling intervals. This affects new scheduling and
does not evict running workloads. The checker verifies prerequisites; guest
launch and attestation still need validation on target hardware.

Turn the setting off and redeploy to remove the deployment-owned service and
its scheduling requirement. Uninstall removes that service before Kata artifact
cleanup. Saved evidence is retained. A namespace/release ownership marker avoids
removing another deployment’s service or adopting a manually installed service.

## Inspect a node

```sh
systemctl status krab-conformance.service
journalctl -u krab-conformance.service --follow
cat /var/lib/krab/conformance/latest.json
```

Nodes need systemd, systemctl, sha256sum, and rm. The unit and binary integrity
manifest are installed under `/etc/krab`; the checker lives under
`/opt/krab/conformance`. The daemon publishes bounded, expiring results atomically.
Standalone checker installation commands remain available for diagnostics and
independent use; they are not part of the KRAB deployment workflow.
