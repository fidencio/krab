#![cfg(target_os = "linux")]

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

struct Host(PathBuf);

impl Host {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("krab-service-cli-{}-{unique}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_krab"))
            .args(args)
            .args(["--offline", "--host-root"])
            .arg(&self.0)
            .output()
            .unwrap()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn full_cli_requires_an_explicit_checker_before_touching_the_host() {
    let host = Host::new();
    for args in [
        vec!["conformance", "install", "--require", "kvm"],
        vec!["precheck", "conformance", "install", "--require", "kvm"],
    ] {
        let output = host.run(&args);
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("--checker"));
        assert_eq!(fs::read_dir(&host.0).unwrap().count(), 0);
    }
    let help = Command::new(env!("CARGO_BIN_EXE_krab"))
        .args(["conformance", "install", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let help = String::from_utf8(help.stdout).unwrap();
    assert!(help.contains("krab conformance install"));
    assert!(help.contains("--checker <CHECKER>"));
    assert!(!help.contains("default: this executable"));
}

#[test]
fn full_cli_installs_the_selected_artifact_and_can_remove_it() {
    let host = Host::new();
    fs::create_dir_all(host.0.join("usr/bin")).unwrap();
    for tool in ["systemctl", "sha256sum", "rm"] {
        fs::write(host.0.join("usr/bin").join(tool), "offline host tool").unwrap();
    }
    let checker = host.0.join("checker-fixture");
    fs::write(&checker, "explicit checker artifact").unwrap();
    let output = host.run(&[
        "conformance",
        "install",
        "--require",
        "kvm",
        "--checker",
        checker.to_str().unwrap(),
    ]);
    assert!(output.status.success(), "{output:?}");
    let installed = host.0.join("opt/krab/conformance/krab-preflight");
    assert_eq!(fs::read(&installed).unwrap(), fs::read(checker).unwrap());
    let output = host.run(&["conformance", "remove"]);
    assert!(output.status.success(), "{output:?}");
    assert!(!installed.exists());
}
