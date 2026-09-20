# KRAB Helm chart

KRAB is an umbrella chart for a Kata Containers reference architecture.

## Dependencies

| Dependency | Scope |
| --- | --- |
| node-feature-discovery | Always installed |
| kata-deploy | Always installed |
| kata-device-plugin | Installed when `nvidia.enabled=true` |
| kata-device-provisioner | Installed when `nvidia.enabled=true` |

KRAB owns the shared NFD installation, so
`kata-deploy.node-feature-discovery.enabled` and
`kata-device-provisioner.node-feature-discovery.enabled` must remain `false`.

## NVIDIA profiles

The chart expects kata-device-provisioner to support multiple profiles in one
release:

```yaml
nvidia:
  enabled: true

kata-device-provisioner:
  profiles:
    HGX-Hx00-PPCIE-SNP:
      enabled: true
      ccMode: ppcie
      nodeSelector:
        kata.feature.node.kubernetes.io/nvidia-hopper: "true"
        kata.feature.node.kubernetes.io/nvidia-nvswitch: "true"
        amd.feature.node.kubernetes.io/snp: "true"
```

## Installation

After the conditional upstream charts are published:

```sh
helm upgrade --install krab \
  oci://ghcr.io/fidencio/krab \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

Chart publication is currently guarded because the kata-device-plugin and
multi-profile kata-device-provisioner OCI charts do not exist yet.
