#![cfg(target_os = "linux")]

use std::fs;
use std::process::Command;

#[test]
fn cli_self_installs_offline_and_removes_itself_preserving_evidence() {
    let host = tempfile::tempdir().unwrap();
    let root = host.path();
    fs::create_dir_all(root.join("usr/bin")).unwrap();
    for tool in ["systemctl", "sha256sum", "rm"] {
        fs::write(root.join("usr/bin").join(tool), "offline fixture").unwrap();
    }
    let checker = env!("CARGO_BIN_EXE_krab-preflight");
    let install = |extra: &[&str]| {
        Command::new(checker)
            .args(["conformance", "install", "--offline", "--host-root"])
            .arg(root)
            .args(["--require", "kvm"])
            .args(extra)
            .output()
            .unwrap()
    };
    let installed = root.join("opt/krab/conformance/krab-preflight");
    let unit = root.join("etc/systemd/system/krab-conformance.service");
    let bad = install(&["--checker-sha256", &"0".repeat(64)]);
    assert_eq!(bad.status.code(), Some(2));
    assert!(!installed.exists());
    assert!(!unit.exists());

    let result = install(&[]);
    assert!(result.status.success(), "{:?}", result);
    assert_eq!(fs::read(&installed).unwrap(), fs::read(checker).unwrap());
    let unit_before = fs::read(&unit).unwrap();
    assert!(!install(&["--require", "snp", "--require", "tdx"])
        .status
        .success());
    assert_eq!(fs::read(&unit).unwrap(), unit_before);
    let evidence = root.join("var/lib/krab/conformance/latest.json");
    fs::write(&evidence, "saved diagnostic evidence").unwrap();
    let remove = Command::new(&installed)
        .args(["conformance", "remove", "--offline", "--host-root"])
        .arg(root)
        .output()
        .unwrap();
    assert!(remove.status.success(), "{:?}", remove);
    assert!(!installed.exists());
    assert!(!unit.exists());
    assert_eq!(
        fs::read_to_string(evidence).unwrap(),
        "saved diagnostic evidence"
    );
    assert!(!root.join("opt/kata-device-provisioner").exists());
}
