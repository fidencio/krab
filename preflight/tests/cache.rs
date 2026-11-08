//! Exercise the real CLI with a counted provisioner and isolated host filesystem.
#![cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("krab-cli-cache-{}-{unique}", std::process::id()));
        for dir in ["etc", "proc/sys/kernel/random", "sys/devices"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("etc/machine-id"), "test-machine").unwrap();
        fs::write(root.join("proc/sys/kernel/random/boot_id"), "boot-1").unwrap();
        fs::write(root.join("proc/sys/kernel/osrelease"), "test-kernel").unwrap();
        fs::write(root.join("proc/cpuinfo"), "test-cpu").unwrap();
        let provisioner = root.join("provisioner");
        fs::write(&provisioner, "#!/bin/sh\nprintf 'called\\n' >> \"$COUNT_FILE\"\nif test -f \"$FAILURE_FILE\"; then echo 'temporary failure' >&2; exit 1; fi\nprintf '0000:65:00.0  0x10de:2330  class=0x030200  nvidia-in-band-cc  chip=H100  cc=capable  ppcie=capable  NVIDIA H100\\n'\n").unwrap();
        fs::set_permissions(provisioner, fs::Permissions::from_mode(0o755)).unwrap();
        Self(root)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_krab-preflight"));
        command
            .args(args)
            .arg("--cache-dir")
            .arg(self.0.join("cache"))
            .env("KRAB_PREFLIGHT_HOST_ROOT", &self.0)
            .env("KRAB_PROVISIONER", self.0.join("provisioner"))
            .env("COUNT_FILE", self.0.join("count"))
            .env("FAILURE_FILE", self.0.join("fail"));
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn count(&self) -> usize {
        fs::read_to_string(self.0.join("count"))
            .unwrap_or_default()
            .lines()
            .count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn node_reports_reuse_probes_and_refresh_after_reboot_machine_change_or_force() {
    let fixture = Fixture::new();
    let first = fixture.run(&["--node-report"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(String::from_utf8_lossy(&first.stdout).contains("krab-node-precheck"));
    let calls = fixture.count();
    assert!(calls > 0);
    let cached = fixture.run(&["--node-report"]);
    assert_eq!(cached.stdout, first.stdout);
    assert!(
        cached.stderr.is_empty(),
        "Node report logs must contain only JSON"
    );
    assert_eq!(fixture.count(), calls);

    fixture.run(&["--node-report", "--force-refresh"]);
    assert_eq!(fixture.count(), calls * 2);
    fs::write(fixture.0.join("proc/sys/kernel/random/boot_id"), "boot-2").unwrap();
    fixture.run(&["--node-report"]);
    assert_eq!(fixture.count(), calls * 3);
    fs::write(fixture.0.join("etc/machine-id"), "replacement-machine").unwrap();
    fixture.run(&["--node-report"]);
    assert_eq!(fixture.count(), calls * 4);
}

#[test]
fn selected_checks_formats_corruption_and_unavailable_capabilities_keep_cli_semantics() {
    let fixture = Fixture::new();
    let args = ["--json", "--gpu"];
    let first = fixture.run(&args);
    assert!(first.status.success());
    assert_eq!(fixture.run(&args).stdout, first.stdout);
    assert_eq!(fixture.count(), 1);
    fixture.run(&["--gpu"]); // Text output needs a different entry.
    fixture.run(&["--json", "--gpu", "--gpu-cc"]); // Different selection.
    assert_eq!(fixture.count(), 4);

    for entry in fs::read_dir(fixture.0.join("cache")).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension == "cache")
        {
            fs::write(path, "truncated").unwrap();
        }
    }
    fixture.run(&args);
    assert_eq!(fixture.count(), 5);

    let negative = fixture.run(&["--json", "--snp"]);
    assert_eq!(negative.status.code(), Some(1));
    let cached = fixture.run(&["--json", "--snp"]);
    assert_eq!(cached.stdout, negative.stdout);
    assert_eq!(cached.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&cached.stderr).contains("Reusing cached"));
}

#[test]
fn failed_refreshes_retry_instead_of_reusing_old_success() {
    let fixture = Fixture::new();
    assert!(fixture.run(&["--json", "--gpu"]).status.success());
    fs::write(fixture.0.join("fail"), "fail").unwrap();
    assert_eq!(
        fixture
            .run(&["--json", "--gpu", "--force-refresh"])
            .status
            .code(),
        Some(1)
    );
    assert_eq!(fixture.run(&["--json", "--gpu"]).status.code(), Some(1));
    assert_eq!(fixture.count(), 3);
    // The versioned node report can succeed with unknown fields; those errors
    // must still prevent cache reuse.
    fixture.run(&["--node-report"]);
    let calls = fixture.count();
    fixture.run(&["--node-report"]);
    assert!(fixture.count() > calls);
    fs::remove_file(fixture.0.join("fail")).unwrap();
    assert!(fixture.run(&["--json", "--gpu"]).status.success());
}

#[test]
fn concurrent_invocations_share_one_probe_and_no_cache_always_runs_fresh() {
    let fixture = Fixture::new();
    let first = fixture
        .command(&["--json", "--gpu"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let second = fixture
        .command(&["--json", "--gpu"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let first = first.wait_with_output().unwrap();
    let second = second.wait_with_output().unwrap();
    assert!(first.status.success() && second.status.success());
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(fixture.count(), 1);

    let mut command = Command::new(env!("CARGO_BIN_EXE_krab-preflight"));
    command
        .args(["--json", "--gpu", "--no-cache"])
        .env("KRAB_PREFLIGHT_HOST_ROOT", &fixture.0)
        .env("KRAB_PROVISIONER", fixture.0.join("provisioner"))
        .env("COUNT_FILE", fixture.0.join("count"))
        .env("FAILURE_FILE", fixture.0.join("fail"));
    for _ in 0..2 {
        assert!(command.output().unwrap().status.success());
    }
    assert_eq!(fixture.count(), 3);
}

#[test]
fn missing_identity_and_unavailable_cache_run_fresh_without_changing_results() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.0.join("etc/machine-id")).unwrap();
    for _ in 0..2 {
        let result = fixture.run(&["--json", "--gpu"]);
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr)
            .contains("host identity or boot ID is unavailable"));
    }
    assert_eq!(fixture.count(), 2);
    fs::write(fixture.0.join("etc/machine-id"), "restored-machine").unwrap();
    // An ordinary file cannot serve as a cache directory, even when running as root.
    let result = fixture
        .command(&["--json", "--gpu"])
        .arg("--cache-dir")
        .arg(fixture.0.join("etc/machine-id"))
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("cache unavailable"));
    assert_eq!(fixture.count(), 3);
}
