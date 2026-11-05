// Copyright (c) 2026 Kata Containers contributors
// SPDX-License-Identifier: Apache-2.0

use anyhow::{bail, ensure, Context, Result};
use clap::{Args, Parser, Subcommand};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const BIN: &str = "opt/krab/conformance";
const STATE: &str = "var/lib/krab/conformance";
const FEATURE: &str = "run/krab/features/conformance";
const LINK: &str = "etc/kubernetes/node-feature-discovery/features.d/krab-conformance";
const UNIT: &str = "etc/systemd/system/krab-conformance.service";
const ENABLED: &str = "etc/systemd/system/multi-user.target.wants/krab-conformance.service";
const UNIT_NAME: &str = "krab-conformance.service";
const MANIFEST: &str = "etc/krab/conformance.sha256";

#[derive(Parser)]
#[command(
    name = "krab-preflight conformance",
    about = "Manage the KRAB host conformance service"
)]
struct Installer {
    #[command(subcommand)]
    action: Action,
}

pub fn run(args: &[String]) -> std::process::ExitCode {
    let cli = match Installer::try_parse_from(
        std::iter::once("krab-preflight conformance".to_string()).chain(args.iter().cloned()),
    ) {
        Ok(cli) => cli,
        Err(error) => {
            let code = if error.use_stderr() { 2 } else { 0 };
            let _ = error.print();
            return std::process::ExitCode::from(code);
        }
    };
    match dispatch(cli.action) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Host conformance setup failed: {error:#}");
            std::process::ExitCode::from(2)
        }
    }
}

#[derive(Subcommand)]
enum Action {
    /// Install only the checker, its checksum and a supervised host daemon.
    Install {
        /// Linux checker artifact to install (default: this executable).
        #[arg(long)]
        checker: Option<PathBuf>,
        /// Expected digest from a trusted build or release manifest.
        #[arg(long)]
        checker_sha256: Option<String>,
        #[arg(long, default_value = "/")]
        host_root: PathBuf,
        /// Prepare an offline host filesystem; enable boot startup without contacting systemd.
        #[arg(long)]
        offline: bool,
        #[command(flatten)]
        policy: Policy,
    },
    /// Stop and remove the host service; retain diagnostic evidence.
    Remove {
        #[arg(long, default_value = "/")]
        host_root: PathBuf,
        /// Remove files from an offline host after its daemon has been stopped.
        #[arg(long)]
        offline: bool,
    },
}

#[derive(Args, Clone)]
struct Policy {
    #[arg(long = "require", value_parser = ["kvm", "cc", "tdx", "snp", "se", "gpu-cc", "gpu-ppcie", "erofs"])]
    requirements: Vec<String>,
    #[arg(long, value_delimiter = ',', value_parser = ["gpu-cc", "gpu-ppcie"])]
    require_any: Vec<String>,
    #[arg(long)]
    gpu_model: Vec<String>,
    #[arg(long, default_value_t = 60)]
    interval_seconds: u64,
    #[arg(long, default_value_t = 30)]
    timeout_seconds: u64,
    #[arg(long, default_value_t = 180)]
    ttl_seconds: u64,
}

impl Policy {
    fn validate(&self) -> Result<()> {
        // Installation must accept exactly the policies and limits the daemon accepts.
        crate::conformance::Options::parse(&self.daemon_arguments()).map_err(anyhow::Error::msg)?;
        Ok(())
    }

    fn daemon_arguments(&self) -> Vec<String> {
        let mut args = vec![
            "--local".into(),
            "--daemon".into(),
            "--output".into(),
            format!("/{STATE}/latest.json"),
            "--nfd-output".into(),
            format!("/{FEATURE}"),
            "--result-ttl-seconds".into(),
            self.ttl_seconds.to_string(),
            "--integrity-manifest".into(),
            format!("/{MANIFEST}"),
            "--interval-seconds".into(),
            self.interval_seconds.to_string(),
            "--timeout-seconds".into(),
            self.timeout_seconds.to_string(),
        ];
        args.extend(self.arguments());
        args
    }

    fn arguments(&self) -> Vec<String> {
        let mut args = Vec::new();
        for requirement in &self.requirements {
            args.extend(["--require".into(), requirement.clone()]);
        }
        if !self.require_any.is_empty() {
            args.extend(["--require-any".into(), self.require_any.join(",")]);
        }
        for model in &self.gpu_model {
            args.extend(["--gpu-model".into(), model.clone()]);
        }
        args
    }
}

fn dispatch(action: Action) -> Result<()> {
    match action {
        Action::Install {
            checker,
            checker_sha256,
            host_root,
            policy,
            offline,
        } => {
            let checker = checker.map(Ok).unwrap_or_else(std::env::current_exe)?;
            let prepared = prepare(&host_root, &checker, checker_sha256.as_deref(), &policy)?;
            if !offline {
                require_live_host(&host_root)?;
                if host_root.join(UNIT).exists() {
                    systemctl(&host_root, &["stop", UNIT_NAME])?;
                }
            }
            install_prepared(&host_root, prepared)?;
            if !offline {
                systemctl(&host_root, &["daemon-reload"])?;
                systemctl(&host_root, &["enable", "--now", UNIT_NAME])?;
                systemctl(&host_root, &["is-active", "--quiet", UNIT_NAME])?;
            }
            Ok(())
        }
        Action::Remove { host_root, offline } => {
            if offline {
                remove_files(&host_root)
            } else {
                remove(&host_root)
            }
        }
    }
}

fn lock(root: &Path) -> Result<File> {
    fs::create_dir_all(root.join(STATE))?;
    fs::set_permissions(root.join(STATE), fs::Permissions::from_mode(0o700))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join(STATE).join("lock"))?;
    // An advisory kernel lock is released even after SIGKILL; stale lock files are harmless.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!(
            "another conformance operation is running: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(file)
}

fn atomic_write(path: &Path, contents: &[u8], mode: u32) -> Result<()> {
    let parent = path
        .parent()
        .context("output requires a parent directory")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".conformance-{}-{}", std::process::id(), now()?));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.with_context(|| format!("write {}", path.display()))
}

fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn unit_quote(value: &str) -> Result<String> {
    ensure!(
        !value.contains(['\n', '\r', '%', '$', '\0']),
        "systemd arguments cannot contain control characters, dollar or percent signs"
    );
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn unit(policy: &Policy) -> Result<String> {
    let mut args = vec![format!("/{BIN}/krab-preflight"), "conformance".into()];
    args.extend(policy.daemon_arguments());
    let command = args
        .iter()
        .map(|s| unit_quote(s))
        .collect::<Result<Vec<_>>>()?
        .join(" ");
    Ok(format!("[Unit]\nDescription=Continuous host conformance for NFD\nAfter=local-fs.target systemd-modules-load.service\nStartLimitIntervalSec=0\n\n[Service]\nType=notify\nNotifyAccess=main\nDynamicUser=yes\nUser=krab-conformance\nStateDirectory=krab/conformance\nStateDirectoryMode=0700\nRuntimeDirectory=krab/features\nRuntimeDirectoryMode=0755\nRuntimeDirectoryPreserve=yes\nExecStartPre=/usr/bin/sha256sum --check --strict /{MANIFEST}\nExecStart={command}\nExecStopPost=/usr/bin/rm -f /{FEATURE}\nRestart=always\nRestartSec=5s\nWatchdogSec=30s\nTimeoutStartSec=30s\nTimeoutStopSec=10s\nKillMode=control-group\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nRestrictAddressFamilies=AF_UNIX\nLimitCORE=0\n\n[Install]\nWantedBy=multi-user.target\n"))
}

fn require_live_host(root: &Path) -> Result<()> {
    ensure!(root.join("run/systemd/system").is_dir() && root.join("proc/1/ns/mnt").exists(),
        "live activation requires the host systemd manager and host /proc; use --offline only when preparing a stopped host filesystem");
    Ok(())
}

fn systemctl(root: &Path, args: &[&str]) -> Result<()> {
    let mut command = Command::new("/usr/bin/systemctl");
    command.args(args);
    if root.canonicalize()? != Path::new("/") {
        let namespace =
            File::open(root.join("proc/1/ns/mnt")).context("open host PID 1 mount namespace")?;
        let host_root = File::open(root.join("proc/1/root")).context("open host PID 1 root")?;
        // systemctl must see the host's /run and PID 1 root, rather than a provisioning container's.
        unsafe {
            command.pre_exec(move || {
                if libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNS) != 0
                    || libc::fchdir(host_root.as_raw_fd()) != 0
                    || libc::chroot(c".".as_ptr()) != 0
                    || libc::chdir(c"/".as_ptr()) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let output = command
        .output()
        .context("run host systemctl (mounted hosts require CAP_SYS_ADMIN and CAP_SYS_CHROOT)")?;
    ensure!(
        output.status.success(),
        "systemctl {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

struct Prepared {
    checker: Vec<u8>,
    digest: String,
    unit: String,
}

#[cfg(test)]
fn install(root: &Path, checker: &Path, expected: Option<&str>, policy: &Policy) -> Result<()> {
    install_prepared(root, prepare(root, checker, expected, policy)?)
}

fn prepare(
    root: &Path,
    checker: &Path,
    expected: Option<&str>,
    policy: &Policy,
) -> Result<Prepared> {
    policy.validate()?;
    let unit = unit(policy)?;
    let checker = fs::read(checker).context("read Linux krab-preflight checker binary")?;
    let digest = format!("{:x}", Sha256::digest(&checker));
    if let Some(expected) = expected {
        ensure!(
            expected.len() == 64 && expected.bytes().all(|c| c.is_ascii_hexdigit()),
            "--checker-sha256 requires 64 hexadecimal characters"
        );
        ensure!(
            digest.eq_ignore_ascii_case(expected),
            "checker SHA-256 does not match the expected artifact"
        );
    }
    for tool in ["usr/bin/systemctl", "usr/bin/sha256sum", "usr/bin/rm"] {
        ensure!(root.join(tool).is_file(), "host requires /{tool}");
    }
    Ok(Prepared {
        checker,
        digest,
        unit,
    })
}

fn install_prepared(
    root: &Path,
    Prepared {
        checker,
        digest,
        unit,
    }: Prepared,
) -> Result<()> {
    let _lock = lock(root)?;
    // Withdraw old evidence before changing the checker or desired policy.
    remove_file(&root.join(FEATURE))?;
    atomic_write(&root.join(BIN).join("krab-preflight"), &checker, 0o755)?;
    atomic_write(
        &root.join(MANIFEST),
        format!("{digest}  /{BIN}/krab-preflight\n").as_bytes(),
        0o644,
    )?;
    fs::create_dir_all(root.join(STATE))?;
    fs::set_permissions(root.join(STATE), fs::Permissions::from_mode(0o700))?;
    fs::create_dir_all(root.join(FEATURE).parent().context("feature parent")?)?;
    let link = root.join(LINK);
    fs::create_dir_all(link.parent().context("feature link parent")?)?;
    remove_file(&link)?;
    // /run is volatile. NFD must mount this target directory as well as features.d.
    symlink(format!("/{FEATURE}"), &link)?;
    atomic_write(&root.join(UNIT), unit.as_bytes(), 0o644)?;
    let enabled = root.join(ENABLED);
    fs::create_dir_all(enabled.parent().context("unit enablement parent")?)?;
    remove_file(&enabled)?;
    symlink("../krab-conformance.service", enabled)?;
    println!("installed systemd conformance daemon; NFD needs a read-only mount of /run/krab/features at the same container path");
    Ok(())
}

fn remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn remove(root: &Path) -> Result<()> {
    let installed = root.join(UNIT).exists();
    if installed {
        require_live_host(root)?;
        systemctl(root, &["disable", "--now", UNIT_NAME])?;
    }
    remove_files(root)?;
    if installed {
        systemctl(root, &["daemon-reload"])?;
    }
    Ok(())
}

fn remove_files(root: &Path) -> Result<()> {
    if !root.join(STATE).exists() && !root.join(UNIT).exists() {
        return Ok(());
    }
    let _lock = lock(root)?;
    for path in [LINK, FEATURE, MANIFEST, UNIT, ENABLED] {
        remove_file(&root.join(path))?;
    }
    remove_file(&root.join(BIN).join("krab-preflight"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::{fixture, rstest};
    use tempfile::TempDir;

    #[fixture]
    fn host() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("usr/bin")).unwrap();
        fs::create_dir_all(root.path().join("bin")).unwrap();
        fs::write(root.path().join("bin/sh"), "fixture").unwrap();
        for tool in ["systemctl", "sha256sum", "rm"] {
            fs::write(root.path().join("usr/bin").join(tool), "fixture").unwrap();
        }
        fs::write(root.path().join("checker"), "checker fixture").unwrap();
        root
    }

    #[fixture]
    fn policy() -> Policy {
        use clap::Parser;
        let cli = Installer::try_parse_from([
            "krab-preflight conformance",
            "install",
            "--checker",
            "/fixture/checker",
            "--require",
            "cc",
            "--require-any",
            "gpu-cc,gpu-ppcie",
        ])
        .unwrap();
        match cli.action {
            Action::Install { policy, .. } => policy,
            _ => panic!("expected conformance install"),
        }
    }

    #[rstest]
    fn installs_supervised_daemon_and_removes_only_owned_files(host: TempDir, policy: Policy) {
        let root = host.path();
        install(root, &root.join("checker"), None, &policy).unwrap();
        let text = fs::read_to_string(root.join(UNIT)).unwrap();
        assert!(text.contains("Type=notify"));
        assert!(text.contains("Restart=always"));
        assert!(text.contains("WatchdogSec=30s"));
        assert!(text.contains("DynamicUser=yes"));
        assert!(text.contains("RuntimeDirectoryPreserve=yes"));
        assert!(text.contains("--daemon"));
        assert!(text.contains("\"--interval-seconds\" \"60\""));
        assert!(text.contains("\"--timeout-seconds\" \"30\""));
        assert!(text.contains("\"--result-ttl-seconds\" \"180\""));
        assert!(text.contains("krab-preflight"));
        assert!(text.contains("--local"));
        assert!(text.contains("ExecStartPre=/usr/bin/sha256sum --check --strict"));
        assert_eq!(
            fs::read_link(root.join(ENABLED)).unwrap(),
            PathBuf::from("../krab-conformance.service")
        );
        assert!(!text.contains("KRAB_PROVISIONER"));
        assert!(!root.join(BIN).join("kata-device-provisioner").exists());
        assert!(root.join(MANIFEST).exists());
        assert!(text.contains("gpu-cc,gpu-ppcie"));
        assert!(!text.contains("'conformance' 'run'"));
        assert_eq!(
            fs::read_link(root.join(LINK)).unwrap(),
            PathBuf::from(format!("/{FEATURE}"))
        );
        assert_eq!(
            fs::metadata(root.join(BIN).join("krab-preflight"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        fs::write(root.join(FEATURE), "old pass").unwrap();
        install(root, &root.join("checker"), None, &policy).unwrap();
        assert!(!root.join(FEATURE).exists());
        assert!(!root.join(BIN).join("kata-device-provisioner").exists());
        fs::write(root.join(STATE).join("latest.json"), "evidence").unwrap();
        let other = root.join(LINK).parent().unwrap().join("other-vendor");
        fs::write(&other, "keep").unwrap();
        remove_files(root).unwrap();
        remove_files(root).unwrap();
        assert!(!root.join(UNIT).exists());
        assert!(!root.join(ENABLED).exists());
        assert!(!root.join(MANIFEST).exists());
        assert!(fs::symlink_metadata(root.join(LINK)).is_err());
        assert!(!root.join(BIN).join("krab-preflight").exists());
        assert!(root.join(STATE).join("latest.json").exists());
        assert!(other.exists());
    }

    #[rstest]
    fn installation_respects_the_daemon_lock(host: TempDir, policy: Policy) {
        let held = lock(host.path()).unwrap();
        assert!(install(host.path(), &host.path().join("checker"), None, &policy).is_err());
        assert!(!host.path().join(UNIT).exists());
        drop(held);
        install(host.path(), &host.path().join("checker"), None, &policy).unwrap();
    }

    #[rstest]
    fn pins_and_records_the_installed_checker_digest(host: TempDir, policy: Policy) {
        let digest = format!("{:x}", Sha256::digest(b"checker fixture"));
        assert!(install(
            host.path(),
            &host.path().join("checker"),
            Some(&"0".repeat(64)),
            &policy
        )
        .is_err());
        assert!(!host.path().join(UNIT).exists());
        install(
            host.path(),
            &host.path().join("checker"),
            Some(&digest),
            &policy,
        )
        .unwrap();
        let expected = format!("{digest}  /{BIN}/krab-preflight\n");
        assert_eq!(
            fs::read_to_string(host.path().join(MANIFEST)).unwrap(),
            expected
        );
        assert_eq!(
            fs::metadata(host.path().join(MANIFEST))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[rstest]
    #[case::percent("H100%newline")]
    #[case::newline("H100\nroot bad")]
    fn rejects_unit_control_characters_before_installing(
        host: TempDir,
        mut policy: Policy,
        #[case] model: &str,
    ) {
        policy.gpu_model.push(model.into());
        assert!(install(host.path(), &host.path().join("checker"), None, &policy).is_err());
        assert!(!host.path().join(UNIT).exists());
    }

    #[rstest]
    #[case::too_short(105, 30)]
    #[case::zero_timeout(600, 0)]
    #[case::excessive_timeout(600, 86401)]
    fn rejects_unusable_schedule_limits(
        mut policy: Policy,
        #[case] ttl: u64,
        #[case] timeout: u64,
    ) {
        policy.ttl_seconds = ttl;
        policy.timeout_seconds = timeout;
        assert!(policy.validate().is_err());
    }
}
