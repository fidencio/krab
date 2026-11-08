# NVIDIA CPU confidential workloads

Select **NVIDIA CPU TDX** or **NVIDIA CPU SNP** in the website’s runtime choices,
or in the terminal editor. These CPU-only profiles do not require a GPU.

```sh
krab init --non-interactive --runtime qemu-nvidia-cpu-tdx-runtime-rs --output krab.yaml
krab generate --config krab.yaml --output values.yaml
krab install --config krab.yaml --context my-cluster
```

Use `qemu-nvidia-cpu-snp-runtime-rs` for SNP; repeat `--runtime` to select both.
Review the printed plan, then add `--execute` to deploy. TDX selects QGS
automatically. CPU-only selections do not enable GPU provisioning.

KRAB prepares profiles automatically on each node after Kata installs its
artifacts, before CRI registration. The shared Rust implementation derives the
CPU profile from the installed, matching NVIDIA confidential GPU reference:
it keeps the confidential kernel, firmware, CoCo extension and integrity
metadata, CPU TEE selectors and extended resource, inherited overhead, Nydus,
and CRI-O guest-pull settings. It removes the GPU guest extension and DCGM boot
argument. No Python helper, profile upload, or existing deployment is required.

These are experimental KRAB profiles using Kata’s custom runtime support,
not new upstream shim names. Kata may stage the GPU extension artifact, but the
CPU profile does not attach it to its guest. Validate guest boot and attestation
on compatible TDX/SNP hosts before running workloads.
