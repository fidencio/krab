# KRAB Helm chart

KRAB is an umbrella chart for a Kata Containers reference architecture.

## Dependencies

| Dependency | Scope |
| --- | --- |
| node-feature-discovery | Enabled by default; override `node-feature-discovery.enabled` |
| kata-deploy | Enabled by default; override `kata-deploy.enabled` |
| kata-device-plugin | Override `kata-device-plugin.enabled`; falls back to `nvidia.enabled` |
| kata-device-provisioner | Override `kata-device-provisioner.enabled`; falls back to `nvidia.enabled` |

KRAB owns the shared NFD installation, so
`kata-deploy.node-feature-discovery.enabled` and
`kata-device-provisioner.node-feature-discovery.enabled` must remain `false`.

Every dependency can be enabled or disabled independently. For example, use
`--set kata-deploy.enabled=false` to manage the remaining components without
installing Kata. Use `--set kata-device-plugin.enabled=false` to omit only the
device plugin from a GPU deployment. Explicit component switches take precedence
over the legacy `nvidia.enabled` default.

The device plugin selects NVIDIA GPU hardware using NFD's
`feature.node.kubernetes.io/pci-0302_10de.present=true` label. This works with
VFIO-bound GPUs and independently of Kata installation. With shared NFD
disabled, an existing NFD installation must supply that label. KRAB clears the
upstream chart's `katacontainers.io/kata-runtime` selector during Helm merging.

When Kata deployment is disabled, KRAB installs the pinned Kata CPU feature
rules if shared NFD is enabled or the NFD API already exists in the cluster.
NFD sets the AMD SNP and Intel TDX capability labels and advertises their key
counts before provisioning selects nodes. These are ordinary chart resources;
the provisioner's post-install dispatcher waits for NFD to publish the labels.
When Kata deployment is enabled, Kata continues to own those rules.

Disabling an already installed component during `helm upgrade` removes it through
Helm's normal lifecycle, including the component's cleanup hooks.

## NVIDIA profiles

The chart expects kata-device-provisioner to support multiple profiles in one
release:

```yaml
nvidia:
  enabled: true

kata-device-provisioner:
  profiles:
    HGX-Hx00-PPCIE-TDX:
      enabled: true
      ccMode: ppcie
      nodeSelector:
        kata.feature.node.kubernetes.io/nvidia-hopper: "true"
        kata.feature.node.kubernetes.io/nvidia-nvswitch: "true"
        intel.feature.node.kubernetes.io/tdx: "true"
```

## Installation

Install the chart with:

```sh
helm upgrade --install krab \
  oci://ghcr.io/fidencio/krab \
  --version 0.1.6 \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

The conditional NVIDIA dependencies are consumed from their published
prereleases.
