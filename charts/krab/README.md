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
    HGX-Hx00-PPCIE-TDX:
      enabled: true
      ccMode: ppcie
      nodeSelector:
        kata.feature.node.kubernetes.io/nvidia-hopper: "true"
        kata.feature.node.kubernetes.io/nvidia-nvswitch: "true"
        intel.feature.node.kubernetes.io/tdx: "true"
```

## Installation

After the remaining conditional upstream chart is published:

```sh
helm upgrade --install krab \
  oci://ghcr.io/fidencio/krab \
  --version 0.1.0-alpha.0 \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

Chart publication is currently guarded because the kata-device-plugin OCI chart
does not exist yet. The multi-profile kata-device-provisioner chart is consumed
from its published alpha release.
