//! KRAB's short-lived stage in the Kata node pipeline. No Kubernetes token is
//! required: it prepares host configuration before the dispatcher advertises it.
use anyhow::{ensure, Context, Result};
use clap::Parser;
use std::fs;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const OWNER: &str = "etc/krab/deployment-owner";

#[derive(Parser)]
struct Options {
    #[arg(long)]
    host_root: PathBuf,
    #[arg(long)]
    owner: String,
    #[arg(long)]
    install_dir: PathBuf,
    #[arg(long)]
    continuous_conformance: bool,
    #[arg(long)]
    deployment_policy: Option<String>,
    #[arg(long)]
    cpu_tee: Vec<String>,
    #[arg(long)]
    remove: bool,
}

pub fn run(args: &[String]) -> ExitCode {
    let mut options = match Options::try_parse_from(
        std::iter::once("krab-preflight prepare-node".to_string()).chain(args.iter().cloned()),
    ) {
        Ok(options) => options,
        Err(error) => {
            let code = if error.use_stderr() { 2 } else { 0 };
            let _ = error.print();
            return ExitCode::from(code);
        }
    };
    if crate::platform::architecture() != "amd64" {
        options.cpu_tee.clear();
    }
    match prepare(&options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("KRAB node setup failed: {error:#}");
            let _ = fs::write(
                "/dev/termination-log",
                format!("KRAB node setup failed: {error:#}"),
            );
            ExitCode::from(2)
        }
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let parent = path.parent().context("path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("krab-{}", std::process::id()));
    fs::write(&temporary, content)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn prepare(options: &Options) -> Result<()> {
    ensure!(
        options.host_root.is_absolute() && options.install_dir.is_absolute(),
        "Host and Kata directories must be absolute"
    );
    ensure!(
        !options
            .install_dir
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir)),
        "Invalid Kata installation path"
    );
    ensure!(
        !options.owner.is_empty()
            && options
                .owner
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-./".contains(&b)),
        "Invalid deployment owner"
    );
    let owner = options.host_root.join(OWNER);
    fs::create_dir_all(owner.parent().context("owner directory")?)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(options.host_root.join("etc/krab/node-setup.lock"))?;
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0,
        "Cannot lock KRAB node setup: {}",
        std::io::Error::last_os_error()
    );
    let existing = fs::read_to_string(&owner).ok();
    let owned = existing
        .as_ref()
        .is_some_and(|value| value.trim() == options.owner);
    if options.continuous_conformance && !options.remove {
        ensure!(
            existing.is_none() || owned,
            "Host conformance is managed by another KRAB deployment"
        );
    }
    let installation = options
        .host_root
        .join(options.install_dir.strip_prefix("/").unwrap());
    if options.remove {
        if owned {
            crate::service::deployment(&[
                "remove".into(),
                "--host-root".into(),
                options.host_root.display().to_string(),
            ])?;
            fs::remove_file(owner)?;
        }
        return Ok(());
    }
    // Validate all requested profiles before changing any runtime.
    let mut updates = Vec::new();
    for tee in &options.cpu_tee {
        let name = krab_core::cpu::runtime_name(tee).map_err(anyhow::Error::msg)?;
        let base = format!("qemu-nvidia-gpu-{tee}-runtime-rs");
        let source = installation.join(format!(
            "share/defaults/kata-containers/runtime-rs/configuration-{base}.toml"
        ));
        let target = installation.join(format!(
            "share/defaults/kata-containers/custom-runtimes/kata-{name}/config.d"
        ));
        ensure!(
            target.is_dir(),
            "Kata did not prepare the selected CPU handler: {name}"
        );
        let common = target.join("30-kernel-params.toml");
        let params = if common.exists() {
            krab_core::cpu::kernel_params(&fs::read_to_string(common)?)
                .map_err(anyhow::Error::msg)?
        } else {
            None
        };
        let derived = krab_core::cpu::derive(
            &fs::read_to_string(&source).with_context(|| format!("read {}", source.display()))?,
            tee,
            &options.install_dir.display().to_string(),
            params.as_deref(),
        )
        .map_err(anyhow::Error::msg)?;
        updates.push((target.join("40-krab-cpu-profile.toml"), derived.drop_in));
    }
    let mut install_args = Vec::new();
    if options.continuous_conformance {
        let policy = options
            .deployment_policy
            .as_ref()
            .context("Generated deployment policy is missing")?;
        crate::conformance::Options::parse(&[
            "--local".into(),
            "--deployment-policy".into(),
            policy.clone(),
        ])
        .map_err(anyhow::Error::msg)?;
        let unit = options
            .host_root
            .join("etc/systemd/system/krab-conformance.service");
        ensure!(
            !unit.exists() || owned,
            "A manually managed conformance service already exists"
        );
        let checksum = fs::read_to_string("/opt/krab/krab-preflight.sha256")
            .context("read checker digest from the released image")?;
        let checksum = checksum
            .split_whitespace()
            .next()
            .context("empty checker digest")?;
        install_args = vec![
            "install".into(),
            "--checker".into(),
            std::env::current_exe()?.display().to_string(),
            "--checker-sha256".into(),
            checksum.into(),
            "--host-root".into(),
            options.host_root.display().to_string(),
            "--deployment-policy".into(),
            policy.clone(),
        ];
    }
    for (path, content) in updates {
        atomic_write(&path, &content)?;
    }
    if options.continuous_conformance {
        // Claim ownership before activation so a partially failed install can
        // be cleaned by uninstall or by switching the setting off.
        atomic_write(&owner, &format!("{}\n", options.owner))?;
        crate::service::deployment(&install_args)?;
    } else if owned {
        crate::service::deployment(&[
            "remove".into(),
            "--host-root".into(),
            options.host_root.display().to_string(),
        ])?;
        fs::remove_file(owner)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(root: &Path) -> Options {
        Options {
            host_root: root.to_path_buf(),
            owner: "kata-system/krab".into(),
            install_dir: "/opt/kata".into(),
            continuous_conformance: false,
            deployment_policy: None,
            cpu_tee: vec!["tdx".into()],
            remove: false,
        }
    }
    fn setup(root: &Path, tee: &str) -> PathBuf {
        let defaults = root.join("opt/kata/share/defaults/kata-containers");
        fs::create_dir_all(defaults.join("runtime-rs")).unwrap();
        fs::write(defaults.join(format!("runtime-rs/configuration-qemu-nvidia-gpu-{tee}-runtime-rs.toml")),
            format!("[hypervisor.qemu]\nconfidential_guest=true\nsev_snp_guest={}\nkernel_params='root=verified'\n[[hypervisor.qemu.guest_extension_images]]\nname='gpu'\npath='/opt/kata/gpu.img'\n[[hypervisor.qemu.guest_extension_images]]\nname='coco'\npath='/opt/kata/coco.img'\nverity_params='root_hash=trusted'\n", tee=="snp")).unwrap();
        let target = defaults.join(format!(
            "custom-runtimes/kata-qemu-nvidia-cpu-{tee}-runtime-rs/config.d"
        ));
        fs::create_dir_all(&target).unwrap();
        fs::write(
            target.join("30-kernel-params.toml"),
            "[hypervisor.qemu]\nkernel_params='root=verified debug nvrc.dcgm=on'\n",
        )
        .unwrap();
        target.join("40-krab-cpu-profile.toml")
    }
    #[test]
    fn cpu_stage_derives_before_registration_and_validates_all_profiles_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let path = setup(root.path(), "tdx");
        let mut opts = options(root.path());
        opts.cpu_tee.push("snp".into());
        assert!(prepare(&opts).is_err());
        assert!(!path.exists());
        setup(root.path(), "snp");
        prepare(&opts).unwrap();
        let result = fs::read_to_string(&path).unwrap();
        assert!(result.contains("root_hash=trusted"));
        assert!(result.contains("debug"));
        assert!(!result.contains("nvrc.dcgm="));
        assert!(!result.contains("gpu.img"));
        // Reconciliation is repeatable and does not create a host service for CPU profiles alone.
        prepare(&opts).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), result);
        assert!(!root.path().join(OWNER).exists());
    }
    #[test]
    fn refuses_another_deployments_service_and_a_manual_service() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("etc/krab")).unwrap();
        fs::write(root.path().join(OWNER), "other/release\n").unwrap();
        let mut opts = options(root.path());
        opts.remove = true;
        prepare(&opts).unwrap();
        opts.remove = false;
        opts.continuous_conformance = true;
        assert!(prepare(&opts)
            .unwrap_err()
            .to_string()
            .contains("another KRAB"));
        assert!(root.path().join(OWNER).exists());
        fs::remove_file(root.path().join(OWNER)).unwrap();
        opts.cpu_tee.clear();
        opts.deployment_policy =
            Some(r#"[{"name":"cpu","architectures":["amd64"],"requirements":["kvm"]}]"#.into());
        fs::create_dir_all(root.path().join("etc/systemd/system")).unwrap();
        fs::write(
            root.path()
                .join("etc/systemd/system/krab-conformance.service"),
            "manual",
        )
        .unwrap();
        assert!(prepare(&opts)
            .unwrap_err()
            .to_string()
            .contains("manually managed"));
    }
}
