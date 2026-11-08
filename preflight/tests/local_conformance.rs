use serde_json::Value;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Host(PathBuf);
impl Host {
    fn new(kvm: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "krab-local-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for directory in [
            "etc",
            "dev",
            "proc/sys/kernel/random",
            "sys/devices",
            "sys/bus/pci/devices",
            "bin",
        ] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        for (name, value) in [
            ("etc/machine-id", "machine-test"),
            ("proc/sys/kernel/random/boot_id", "boot-test"),
            ("proc/sys/kernel/osrelease", "test-kernel"),
            ("proc/cpuinfo", "fixture"),
        ] {
            fs::write(root.join(name), value).unwrap();
        }
        if kvm {
            symlink("/dev/null", root.join("dev/kvm")).unwrap();
        }
        Self(root)
    }
    fn run(&self, extra: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_krab-preflight"))
            .args(["conformance", "--local", "--json", "--require", "kvm"])
            .args(extra)
            .env("KRAB_PREFLIGHT_HOST_ROOT", &self.0)
            .env("KRAB_PROVISIONER", self.0.join("absent-provisioner"))
            .output()
            .unwrap()
    }
}

#[test]
#[cfg(target_os = "linux")]
fn gpu_conformance_works_without_a_provisioner_and_never_writes_device_state() {
    for (id, capability, expected) in [
        ("2330", "gpu-cc", "pass"),
        ("2330", "gpu-ppcie", "pass"),
        ("2901", "gpu-cc", "pass"),
        ("2901", "gpu-ppcie", "fail"),
        ("20b0", "gpu-cc", "fail"),
    ] {
        let host = Host::new(true);
        symlink("/dev/null", host.0.join("dev/iommu")).unwrap();
        let device = host.0.join("sys/bus/pci/devices/0000:65:00.0");
        fs::create_dir_all(&device).unwrap();
        for (name, value) in [
            ("vendor", "0x10de"),
            ("class", "0x030200"),
            ("device", &format!("0x{id}")),
            ("reset", "unchanged"),
            ("driver_override", "unchanged"),
        ] {
            fs::write(device.join(name), value).unwrap();
        }
        let output = host.run(&["--require", capability]);
        let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(verdict["verdict"], expected, "{id} {capability}: {verdict}");
        assert_eq!(
            verdict["precheck"]["gpus"]["devices"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        for name in ["reset", "driver_override"] {
            assert_eq!(fs::read_to_string(device.join(name)).unwrap(), "unchanged");
        }
        assert!(!device.join("resource0").exists());
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
#[cfg(target_os = "linux")]
fn unreadable_pci_entry_cannot_hide_behind_a_conforming_gpu() {
    let host = Host::new(true);
    symlink("/dev/null", host.0.join("dev/iommu")).unwrap();
    for address in ["0000:65:00.0", "0000:66:00.0"] {
        let device = host.0.join("sys/bus/pci/devices").join(address);
        fs::create_dir_all(&device).unwrap();
        fs::write(device.join("vendor"), "0x10de").unwrap();
        fs::write(device.join("class"), "0x030200").unwrap();
        fs::write(device.join("device"), "0x2330").unwrap();
    }
    assert_eq!(host.run(&["--require", "gpu-cc"]).status.code(), Some(0));
    fs::remove_file(host.0.join("sys/bus/pci/devices/0000:66:00.0/device")).unwrap();
    let output = host.run(&["--require", "gpu-cc"]);
    assert_eq!(output.status.code(), Some(1));
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(verdict["precheck"]["gpus"]["cc"]["status"], "unknown");
    assert!(verdict["precheck"]["gpus"]["cc"]["reason"]
        .as_str()
        .unwrap()
        .contains("Cannot read PCI inventory"));
}

#[test]
fn local_mode_collects_fresh_evidence_and_reuses_the_conformance_policy() {
    let host = Host::new(true);
    let output = host.run(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(verdict["kind"], "krab-local-conformance");
    assert_eq!(verdict["verdict"], "pass");
    assert_eq!(verdict["precheck"]["node"]["bootID"], "boot-test");
    assert!(
        verdict["precheck"]["node"]["checkedAtUnixSeconds"]
            .as_u64()
            .unwrap()
            > 0
    );
    fs::remove_file(host.0.join("dev/kvm")).unwrap();
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(1));
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(verdict["verdict"], "fail");
}

#[test]
fn missing_host_identity_is_a_structured_collection_error() {
    let host = Host::new(true);
    fs::remove_file(host.0.join("proc/sys/kernel/random/boot_id")).unwrap();
    let output = host.run(&[]);
    assert_eq!(output.status.code(), Some(2));
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(verdict["verdict"], "error");
    assert!(verdict["precheck"].is_null());
}

#[test]
fn local_mode_rejects_cluster_inputs_and_multiple_sources() {
    let host = Host::new(true);
    for args in [
        vec!["--run"],
        vec!["--report", "old.json"],
        vec!["--nodes", "nodes.json"],
        vec!["--context", "production"],
    ] {
        assert_eq!(host.run(&args).status.code(), Some(2));
    }
}

#[test]
fn nfd_output_replaces_pass_with_fail_and_collection_error() {
    let host = Host::new(true);
    let features = host.0.join("run/features/conformance");
    let evidence = host.0.join("state/latest.json");
    let args = [
        "--nfd-output",
        features.to_str().unwrap(),
        "--output",
        evidence.to_str().unwrap(),
    ];
    for expected in ["pass", "fail", "error"] {
        match expected {
            "fail" => fs::remove_file(host.0.join("dev/kvm")).unwrap(),
            "error" => fs::remove_file(host.0.join("etc/machine-id")).unwrap(),
            _ => {}
        }
        let output = host.run(&args);
        assert_eq!(
            output.status.code(),
            Some(match expected {
                "pass" => 0,
                "fail" => 1,
                _ => 2,
            })
        );
        let text = fs::read_to_string(&features).unwrap();
        assert!(text.starts_with("# +expiry-time="));
        assert!(text.contains(&format!("krab.conformance.state={expected}\n")));
        let report: Value = serde_json::from_slice(&fs::read(&evidence).unwrap()).unwrap();
        assert_eq!(report["verdict"], expected);
    }
    assert_eq!(fs::read_dir(features.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn evidence_write_error_cannot_leave_a_pass_label() {
    let host = Host::new(true);
    let features = host.0.join("features");
    assert_eq!(
        host.run(&["--nfd-output", features.to_str().unwrap()])
            .status
            .code(),
        Some(0)
    );
    let output = host.run(&[
        "--nfd-output",
        features.to_str().unwrap(),
        "--output",
        host.0.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(2));
    assert!(fs::read_to_string(features)
        .unwrap()
        .contains("krab.conformance.state=error"));
}

#[test]
fn invalid_expiry_or_shared_output_paths_are_rejected() {
    let host = Host::new(true);
    for args in [
        vec!["--result-ttl-seconds", "0"],
        vec!["--result-ttl-seconds", "86401"],
        vec!["--nfd-output", "same", "--output", "same"],
    ] {
        assert_eq!(host.run(&args).status.code(), Some(2));
    }
}
