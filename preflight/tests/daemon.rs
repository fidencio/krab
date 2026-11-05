#![cfg(target_os = "linux")]

use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::symlink;
use std::os::unix::net::UnixDatagram;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Host(PathBuf);
impl Host {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "krab-daemon-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for directory in [
            "etc",
            "dev",
            "state",
            "proc/sys/kernel/random",
            "sys/devices",
            "sys/bus/pci/devices",
        ] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        for (path, value) in [
            ("etc/machine-id", "machine-test"),
            ("proc/sys/kernel/random/boot_id", "boot-test"),
            ("proc/sys/kernel/osrelease", "test-kernel"),
            ("proc/cpuinfo", "fixture"),
        ] {
            fs::write(root.join(path), value).unwrap();
        }
        symlink("/dev/null", root.join("dev/kvm")).unwrap();
        let digest = Command::new("/usr/bin/sha256sum")
            .arg(env!("CARGO_BIN_EXE_krab-preflight"))
            .output()
            .unwrap();
        assert!(digest.status.success());
        fs::write(root.join("checker.sha256"), digest.stdout).unwrap();
        Self(root)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_krab-preflight"));
        command
            .args([
                "conformance",
                "--local",
                "--daemon",
                "--require",
                "kvm",
                "--interval-seconds",
                "1",
                "--timeout-seconds",
                "1",
                "--result-ttl-seconds",
                "30",
            ])
            .arg("--integrity-manifest")
            .arg(self.0.join("checker.sha256"))
            .arg("--nfd-output")
            .arg(self.0.join("features/result"))
            .arg("--output")
            .arg(self.0.join("state/latest.json"))
            .env("KRAB_PREFLIGHT_HOST_ROOT", &self.0)
            .env("STATE_DIRECTORY", self.0.join("state"))
            .env_remove("NOTIFY_SOCKET")
            .env_remove("WATCHDOG_USEC")
            .env_remove("WATCHDOG_PID");
        command
    }
    fn result(&self) -> Option<String> {
        fs::read_to_string(self.0.join("features/result")).ok()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn eventually(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !condition() {
        assert!(Instant::now() < deadline, "condition did not converge");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn daemon_rechecks_notifies_enforces_singleton_and_stops_cleanly() {
    let host = Host::new();
    let socket = UnixDatagram::bind(host.0.join("notify.sock")).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut daemon = Running(
        host.command()
            .env("NOTIFY_SOCKET", host.0.join("notify.sock"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    eventually(|| {
        host.result()
            .is_some_and(|text| text.contains("krab.conformance.state=pass"))
    });
    let mut bytes = [0; 1024];
    let length = socket.recv(&mut bytes).unwrap();
    let message = String::from_utf8_lossy(&bytes[..length]);
    assert!(message.contains("READY=1"));
    assert!(message.contains("WATCHDOG=1"));
    let duplicate = host.command().output().unwrap();
    assert_eq!(duplicate.status.code(), Some(2));
    assert!(host
        .result()
        .unwrap()
        .contains("krab.conformance.state=pass"));
    fs::remove_file(host.0.join("dev/kvm")).unwrap();
    eventually(|| {
        host.result()
            .is_some_and(|text| text.contains("krab.conformance.state=fail"))
    });
    assert!(
        daemon.0.try_wait().unwrap().is_none(),
        "nonconformance must not stop the daemon"
    );
    unsafe {
        libc::kill(daemon.0.id() as i32, libc::SIGTERM);
    }
    eventually(|| daemon.0.try_wait().unwrap().is_some());
    assert!(!host.0.join("features/result").exists());
}

#[test]
fn checksum_failure_withdraws_pass_before_any_check_runs() {
    let host = Host::new();
    fs::write(
        host.0.join("checker.sha256"),
        format!(
            "{}  {}\n",
            "0".repeat(64),
            env!("CARGO_BIN_EXE_krab-preflight")
        ),
    )
    .unwrap();
    fs::create_dir_all(host.0.join("features")).unwrap();
    fs::write(host.0.join("features/result"), "old pass").unwrap();
    let output = host.command().output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("integrity verification failed"));
    assert!(host.result().is_none());
    assert!(!host.0.join("state/latest.json").exists());
}

#[test]
fn hung_check_is_killed_and_daemon_exits_for_systemd_to_restart() {
    let host = Host::new();
    let path = host.0.join("proc/sys/kernel/osrelease");
    fs::remove_file(&path).unwrap();
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let started = Instant::now();
    let output = host.command().output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("deadline"));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(host.result().is_none());
}
