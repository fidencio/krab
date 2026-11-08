use crate::probe::{self, Paths};
use std::fs;
use std::io;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;

const MODULE_SETUP: &str = "Run sudo modprobe iommufd, then persist it with echo iommufd | sudo tee /etc/modules-load.d/iommufd.conf and rerun the precheck";

fn module_name(path: &str) -> bool {
    matches!(
        Path::new(path).file_name().and_then(|name| name.to_str()),
        Some("iommufd.ko" | "iommufd.ko.gz" | "iommufd.ko.xz" | "iommufd.ko.zst")
    )
}

pub fn check(paths: &Paths) -> probe::Result {
    let device = paths.dev.join("iommu");
    match fs::metadata(&device) {
        Ok(metadata) if metadata.file_type().is_char_device() => return probe::Result::Available,
        Ok(_) => {
            return probe::Result::Unavailable(format!(
                "{} is not a character device",
                device.display()
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return probe::Result::Error(format!("cannot inspect {}: {error}", device.display()))
        }
    }

    if paths.sys.join("class/misc/iommu/dev").is_file() || paths.sys.join("module/iommufd").is_dir()
    {
        return probe::Result::Skipped(format!(
            "IOMMUFD is registered or loaded in the host kernel, but {} is absent; check the host device node and the probe's /dev mount",
            device.display()
        ));
    }

    let release = match fs::read_to_string(paths.host_root.join("proc/sys/kernel/osrelease")) {
        Ok(release) if !release.trim().is_empty() && !release.contains('/') => release,
        _ => return probe::Result::Skipped(format!(
            "{} is absent and the running host kernel version could not be read; check modinfo iommufd on the host",
            device.display()
        )),
    };
    let release = release.trim();
    let modules = paths.host_root.join("lib/modules").join(release);

    // Ubuntu ships IOMMUFD as a module. An unloaded module has neither /dev/iommu
    // nor a sysfs device, but it is not evidence of an unsupported kernel.
    let indexed_module = fs::read_to_string(modules.join("modules.dep"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once(':').map(|(path, _)| path))
        .any(|path| module_name(path) && modules.join(path).is_file());
    let installed_module = indexed_module
        || ["ko", "ko.gz", "ko.xz", "ko.zst"].iter().any(|extension| {
            modules
                .join(format!("kernel/drivers/iommu/iommufd/iommufd.{extension}"))
                .is_file()
        });
    if installed_module {
        return probe::Result::Skipped(format!(
            "IOMMUFD module is installed for kernel {release}, but {} is absent. {MODULE_SETUP}",
            device.display()
        ));
    }

    let builtin = fs::read_to_string(modules.join("modules.builtin"))
        .unwrap_or_default()
        .lines()
        .any(module_name);
    if builtin {
        return probe::Result::Skipped(format!(
            "IOMMUFD is built into kernel {release}, but {} is absent; check host device registration and the probe's /dev mount",
            device.display()
        ));
    }

    for config_path in [
        paths.host_root.join(format!("boot/config-{release}")),
        modules.join("config"),
        modules.join("build/.config"),
    ] {
        let Ok(config) = fs::read_to_string(&config_path) else {
            continue;
        };
        for line in config.lines().map(str::trim) {
            match line {
                "CONFIG_IOMMUFD=m" => return probe::Result::Skipped(format!(
                    "Kernel {release} supports modular IOMMUFD, but the module and {} were not found; install the matching kernel modules if needed. {MODULE_SETUP}",
                    device.display()
                )),
                "CONFIG_IOMMUFD=y" => return probe::Result::Skipped(format!(
                    "Kernel {release} enables IOMMUFD, but {} is absent; check host device registration and the probe's /dev mount",
                    device.display()
                )),
                "# CONFIG_IOMMUFD is not set" | "CONFIG_IOMMUFD=n" => {
                    return probe::Result::Unavailable(format!(
                        "Kernel {release} has CONFIG_IOMMUFD disabled in {}",
                        config_path.display()
                    ));
                }
                _ => {}
            }
        }
    }

    probe::Result::Skipped(format!(
        "{} is absent; IOMMUFD support could not be confirmed from kernel {release}'s module files or configuration. Check modinfo iommufd on the host",
        device.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Host(Paths);
    impl Host {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("krab-iommufd-{}-{unique}", std::process::id()));
            let host = Self(Paths {
                dev: root.join("dev"),
                sys: root.join("sys"),
                host_root: root,
            });
            fs::create_dir_all(&host.0.dev).unwrap();
            host.write("proc/sys/kernel/osrelease", "7.0.0-38-generic\n");
            host
        }
        fn write(&self, name: &str, contents: &str) {
            let path = self.0.host_root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }
    impl Drop for Host {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0.host_root).unwrap();
        }
    }

    #[test]
    fn ubuntu_unloaded_compressed_module_needs_persistent_setup_not_rejection() {
        let host = Host::new();
        host.write(
            "lib/modules/7.0.0-38-generic/kernel/drivers/iommu/iommufd/iommufd.ko.zst",
            "module",
        );
        match check(&host.0) {
            probe::Result::Skipped(reason) => {
                assert!(reason.contains("module is installed"));
                assert!(reason.contains("sudo modprobe iommufd"));
                assert!(reason.contains("/etc/modules-load.d/iommufd.conf"));
            }
            _ => panic!("an unloaded installed module must require operator setup"),
        }
        symlink("/dev/null", host.0.dev.join("iommu")).unwrap();
        assert!(matches!(check(&host.0), probe::Result::Available));
    }

    #[test]
    fn module_index_supports_nonstandard_install_paths() {
        let host = Host::new();
        host.write(
            "lib/modules/7.0.0-38-generic/updates/iommufd.ko.xz",
            "module",
        );
        host.write(
            "lib/modules/7.0.0-38-generic/modules.dep",
            "updates/iommufd.ko.xz:\n",
        );
        assert!(
            matches!(check(&host.0), probe::Result::Skipped(reason) if reason.contains("module is installed"))
        );
    }

    #[test]
    fn another_kernel_module_does_not_confirm_the_running_kernel() {
        let host = Host::new();
        host.write(
            "lib/modules/old-kernel/kernel/drivers/iommu/iommufd/iommufd.ko",
            "module",
        );
        assert!(
            matches!(check(&host.0), probe::Result::Skipped(reason) if reason.contains("could not be confirmed"))
        );
    }

    #[test]
    fn unavailable_kernel_metadata_is_unknown() {
        let host = Host::new();
        assert!(matches!(check(&host.0), probe::Result::Skipped(_)));
        fs::remove_file(host.0.host_root.join("proc/sys/kernel/osrelease")).unwrap();
        assert!(matches!(check(&host.0), probe::Result::Skipped(_)));
    }

    #[test]
    fn explicit_disabled_kernel_configuration_is_unavailable() {
        let host = Host::new();
        host.write(
            "boot/config-7.0.0-38-generic",
            "# CONFIG_IOMMUFD is not set\n",
        );
        assert!(matches!(check(&host.0), probe::Result::Unavailable(_)));
    }

    #[test]
    fn enabled_configurations_and_builtin_modules_do_not_claim_a_missing_device_is_ready() {
        let host = Host::new();
        for setting in ["CONFIG_IOMMUFD=m\n", "CONFIG_IOMMUFD=y\n"] {
            host.write("boot/config-7.0.0-38-generic", setting);
            assert!(matches!(check(&host.0), probe::Result::Skipped(_)));
        }
        host.write(
            "lib/modules/7.0.0-38-generic/modules.builtin",
            "kernel/drivers/iommu/iommufd/iommufd.ko\n",
        );
        assert!(
            matches!(check(&host.0), probe::Result::Skipped(reason) if reason.contains("built into"))
        );
    }

    #[test]
    fn registered_device_missing_from_dev_needs_mount_review() {
        let host = Host::new();
        host.write("sys/class/misc/iommu/dev", "10:264\n");
        assert!(
            matches!(check(&host.0), probe::Result::Skipped(reason) if reason.contains("registered"))
        );
    }

    #[test]
    fn ordinary_file_is_not_iommufd() {
        let host = Host::new();
        host.write("dev/iommu", "not a device");
        assert!(matches!(check(&host.0), probe::Result::Unavailable(_)));
    }
}
