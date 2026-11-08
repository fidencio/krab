export const cocohash = 'root_hash=' + 'a'.repeat(64) + ' salt=' + 'b'.repeat(64)
export const fixture = (tee: string) => `
[hypervisor.qemu]
path = "/opt/kata/bin/qemu-system-x86_64-${tee}-experimental"
kernel = "/opt/kata/share/kata-containers/vmlinuz-nvidia-gpu.container"
image = "/opt/kata/share/kata-containers/kata-containers-nvidia.img"
firmware = "/opt/kata/share/ovmf/${tee}.fd"
confidential_guest = true
sev_snp_guest = ${tee === 'snp'}
kernel_params = 'cgroup_no_v1=all nvrc.smi.srs=1 agent.no_proxy="a b"'
default_memory = 8192
[[hypervisor.qemu.guest_extension_images]]
name = "gpu"
path = "/opt/kata/share/kata-containers/gpu.img"
verity_params = "root_hash=gpu"
[[hypervisor.qemu.guest_extension_images]]
name = "coco"
path = "/opt/kata/share/kata-containers/coco.img"
verity_params = "${cocohash}"
[runtime]
hypervisor_name = "qemu"
pod_resource_api_sock = "/var/lib/kubelet/pod-resources/kubelet.sock"
`
