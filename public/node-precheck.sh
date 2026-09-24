#!/usr/bin/env bash
# Read-only node report. The NVIDIA inventory comes from kata-device-provisioner.
set -euo pipefail

host=${KRAB_HOST_ROOT:-/host}
if [[ ! -r $host/proc/cpuinfo || ! -d $host/sys/devices ]]; then
  echo 'host /proc and /sys are required' >&2
  exit 1
fi

probe() { jq -n --arg status "$1" --arg reason "$2" '{status:$status,reason:$reason}'; }
unknown() { probe unknown "$1"; }
arch=$(uname -m)
case $arch in x86_64) arch=amd64;; aarch64) arch=arm64;; esac
kernel=$(uname -r)

provisioner=${KRAB_PROVISIONER:-/opt/krab/kata-device-provisioner-$arch}
export KRAB_PREFLIGHT_HOST_ROOT=$host KRAB_PROVISIONER=$provisioner
preflight=$(/usr/local/bin/krab-preflight --json --kvm --tdx --snp --ibm-se --iommufd --erofs --gpu --gpu-cc --gpu-ppcie) || true
if ! jq -e '.architecture and (.checks | type == "array")' >/dev/null <<<"$preflight"; then
  echo 'krab-preflight did not return a valid report' >&2
  exit 1
fi
preflight_probe() {
  jq -ce --arg id "$1" '
    [.checks[] | select(.check == $id)][0] |
    if . == null then error("missing preflight check: " + $id) else
      {status:(if .status == "available" then "yes" elif .status == "unavailable" then "no" else "unknown" end),
       reason:(.reason // ($id + " is available"))}
    end' <<<"$preflight"
}
kvm=$(preflight_probe kvm)
tdx=$(preflight_probe tdx)
snp=$(preflight_probe snp)
se=$(preflight_probe ibm-se)
iommufd=$(preflight_probe iommufd)
erofs=$(preflight_probe erofs)

erofs_version=''
for binary in /usr/local/bin/mkfs.erofs /usr/bin/mkfs.erofs /bin/mkfs.erofs; do
  if [[ -x $host$binary ]]; then
    version_output=$(chroot "$host" "$binary" -V 2>&1 || true)
    if [[ $version_output =~ ([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then erofs_version=${BASH_REMATCH[1]}; fi
    break
  fi
done

pci=$(lspci -Dnn 2>/dev/null || true)
gpu_pci=$(printf '%s\n' "$pci" | grep -Ei 'VGA|3D controller|Display controller' || true)
nvidia_pci=$(printf '%s\n' "$gpu_pci" | grep -Ei 'NVIDIA|\[10de:' || true)
present=$(unknown 'PCI inventory is unavailable')
nvidia=$(unknown 'PCI inventory is unavailable')
if [[ -n $pci ]]; then
  present=$(probe no 'No display or compute PCI device was found')
  nvidia=$(probe no 'No NVIDIA GPU was found in PCI inventory')
  if [[ -n $gpu_pci ]]; then present=$(probe yes 'Display or compute PCI device found'); fi
  if [[ -n $nvidia_pci ]]; then nvidia=$(probe yes 'NVIDIA GPU found in PCI inventory'); fi
fi

devices='[]'
cc=$(preflight_probe gpu-cc)
ppcie=$(preflight_probe gpu-ppcie)
nvswitch=$(unknown 'Provisioner inventory unavailable')
if [[ -x $provisioner ]]; then
  inventory=$($provisioner status --all --sysfs="$host/sys" 2>/dev/null || true)
  cc_yes=0; cc_no=0; ppcie_yes=0; ppcie_no=0; switch_yes=0
  while IFS= read -r line; do
    [[ $line =~ ^[[:xdigit:]:]+\.[0-9]+[[:space:]]+0x10de: ]] || continue
    bus=${line%% *}
    name=${line##*  }
    if [[ $line == *'class=0x0680'* ]]; then switch_yes=1; fi
    if [[ $line == *'class=0x0302'* ]]; then
      chip=''
      if [[ $line =~ (^|[[:space:]])chip=([^[:space:]]+) ]]; then chip=${BASH_REMATCH[2]}; fi
      devices=$(jq -c --arg bus "$bus" --arg name "$name" --arg chip "$chip" \
        '. + [{pciBusId:$bus,name:$name,chip:(if $chip == "" or $chip == "-" then null else $chip end)}]' <<<"$devices")
      if [[ $line == *'cc=capable'* ]]; then cc_yes=1; fi
      if [[ $line == *'cc=n/a'* ]]; then cc_no=1; fi
      if [[ $line == *'ppcie=capable'* ]]; then ppcie_yes=1; fi
      if [[ $line == *'ppcie=n/a'* ]]; then ppcie_no=1; fi
    fi
  done <<<"$inventory"
  if (( cc_yes && cc_no )); then cc=$(probe review 'Mixed CC-capable and incapable GPUs need per-profile review');
  fi
  if (( ppcie_yes && ppcie_no )); then ppcie=$(probe review 'Mixed PPCIE-capable and incapable GPUs need per-profile review');
  fi
  if (( switch_yes )); then nvswitch=$(probe yes 'Kata device provisioner found an NVSwitch');
  elif [[ -n $inventory ]]; then nvswitch=$(probe no 'No NVSwitch in provisioner inventory'); fi
fi
if [[ $(jq length <<<"$devices") != 0 ]]; then
  present=$(probe yes 'Kata device provisioner found a GPU')
  nvidia=$(probe yes 'Kata device provisioner found an NVIDIA GPU')
fi
if [[ $(preflight_probe gpu | jq -r .status) == yes ]]; then
  present=$(probe yes 'Kata device provisioner found a GPU')
  nvidia=$(probe yes 'Kata device provisioner found an NVIDIA GPU')
fi

jq -n \
  --arg arch "$arch" --arg kernel "$kernel" --arg erofsVersion "$erofs_version" \
  --argjson kvm "$kvm" --argjson tdx "$tdx" --argjson snp "$snp" --argjson se "$se" \
  --argjson iommufd "$iommufd" --argjson erofs "$erofs" \
  --argjson present "$present" --argjson nvidia "$nvidia" --argjson cc "$cc" \
  --argjson ppcie "$ppcie" --argjson nvswitch "$nvswitch" --argjson devices "$devices" \
  '{schemaVersion:1,kind:"krab-node-precheck",node:{architecture:$arch,kernel:$kernel},
    checks:{kvm:$kvm,tdx:$tdx,snp:$snp,se:$se,iommufd:$iommufd,erofs:$erofs},
    erofsVersion:(if $erofsVersion=="" then null else $erofsVersion end),
    gpus:{present:$present,nvidia:$nvidia,cc:$cc,ppcie:$ppcie,nvswitch:$nvswitch,devices:$devices}}'
