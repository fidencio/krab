"""Exercise the standalone release binary against disposable host evidence."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("--architecture", choices=["amd64", "arm64"], required=True)
args = parser.parse_args()
binary = str(args.binary.resolve())
version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())["version"]

with tempfile.TemporaryDirectory(prefix="krab-release-smoke-") as directory:
    root = Path(directory)
    for name in ["etc", "dev", "proc/sys/kernel/random", "sys/devices", "sys/bus/pci/devices"]:
        (root / name).mkdir(parents=True, exist_ok=True)
    for name, value in {
        "etc/machine-id": "release-smoke-machine",
        "proc/sys/kernel/random/boot_id": "release-smoke-boot",
        "proc/sys/kernel/osrelease": "release-smoke-kernel",
        "proc/cpuinfo": "fixture",
    }.items():
        (root / name).write_text(value)
    for name in ["kvm", "iommu"]:
        (root / "dev" / name).symlink_to("/dev/null")
    device = root / "sys/bus/pci/devices/0000:65:00.0"
    device.mkdir()
    for name, value in {
        "vendor": "0x10de", "device": "0x2330", "class": "0x030200",
        "reset": "unchanged", "driver_override": "unchanged",
    }.items():
        (device / name).write_text(value)
    env = {**os.environ, "KRAB_PREFLIGHT_HOST_ROOT": str(root),
           "KRAB_PROVISIONER": str(root / "absent-provisioner")}
    # The full CLI does not accept the focused checker's top-level probe flags.
    probe = subprocess.run([binary, "--kvm", "--json", "--no-cache"], env=env,
                           capture_output=True, text=True, timeout=15, check=True)
    assert json.loads(probe.stdout)["checks"][0]["status"] == "available"
    feature = root / "conformance.feature"
    for expected, code in [("pass", 0), ("fail", 1), ("error", 2)]:
        if expected == "fail":
            (root / "dev/kvm").unlink()
        if expected == "error":
            (root / "etc/machine-id").unlink()
        result = subprocess.run([
            binary, "conformance", "--local", "--json", "--require", "gpu-cc",
            "--nfd-output", str(feature),
        ], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == code, result.stderr
        verdict = json.loads(result.stdout)
        assert verdict["verdict"] == expected, verdict
        assert f"krab.conformance.state={expected}\n" in feature.read_text()
        if expected == "pass":
            node = verdict["precheck"]["node"]
            assert node["checkerVersion"] == version, node
            assert node["architecture"] == args.architecture, node
    for name in ["reset", "driver_override"]:
        assert (device / name).read_text() == "unchanged"
    assert not (device / "resource0").exists()
print(f"Standalone {args.architecture} checker: PASS/FAIL/ERROR and NFD smoke checks passed")
