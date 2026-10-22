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

The KRAB 0.2.2 builder uses generated-values format 2. Regenerate values
with this builder; format 1 and unversioned values are not imported.

Install the chart with:

```sh
helm upgrade --install krab \
  oci://ghcr.io/fidencio/krab \
  --version 0.2.2 \
  --namespace kata-system \
  --create-namespace \
  --values values.yaml
```

The conditional NVIDIA dependencies are consumed from their published
prereleases.

For TDX deployments, generated values enable the pinned
[`intel-tdx-qgs`](https://github.com/intel/confidential-computing.tee.dcap.k8s.qgs)
dependency, including its Intel SGX device plugin. Both target nodes labeled
`intel.feature.node.kubernetes.io/tdx=true`. QGS is disabled by default and for
selections without a TDX runtime.

The upstream default is Offline certificate provisioning. To retrieve
certificates from Intel PCS, configure Online mode in your values:

```yaml
intel-tdx-qgs:
  enabled: true
  tdxQuoteGenerationService:
    mode: Online
  pcsApiKey:
    secretName: intel-pcs-api-key
```

An optional PCS API key belongs in an existing Secret in the release namespace,
under the `api-key` data key. Online mode also supports anonymous requests.
Offline and External modes require certificates supplied separately, as described
in the upstream documentation. If an SGX device plugin is already installed, set
`intel-tdx-qgs.intel-sgx-plugin.enabled=false`.

The builder exposes QGS as an independent Deploy/Skip component. When enabled,
Advanced deployment configuration lets you choose the certificate provisioning
mode, an existing PCS API key secret, and whether to deploy the SGX plugin. These
settings also apply to Custom deployments and survive values import.
