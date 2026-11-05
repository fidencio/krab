import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve('scripts/nvidia-cpu-cc.py')
export const python = [process.env.KRAB_PYTHON, 'python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']
  .find((candidate): candidate is string => Boolean(candidate) &&
    spawnSync(candidate!, ['-c', 'import tomllib']).status === 0)
if (!python) throw new Error('CPU CC tests require Python 3.11+ (or set KRAB_PYTHON)')
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

export function prepare(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'krab-cpu-cc-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const tee of ['snp', 'tdx']) {
    writeFileSync(join(directory, `configuration-qemu-nvidia-gpu-${tee}-runtime-rs.toml`), fixture(tee))
  }
  return directory
}

export function generate(directory: string, tee = 'both') {
  return spawnSync(python, [script, '--config-dir', directory, '--tee', tee], { encoding: 'utf8' })
}
