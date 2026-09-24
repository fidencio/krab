use crate::probe::{Paths, Result};
use std::env;
use std::io;
use std::process::Command;

const PROGRAM: &str = "kata-device-provisioner";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Gpu,
    Cc,
    Ppcie,
}

pub fn check(kind: Check, paths: &Paths) -> Result {
    let program = env::var_os("KRAB_PROVISIONER").unwrap_or_else(|| PROGRAM.into());
    let output = match Command::new(&program)
        .arg("status")
        .arg("--sysfs")
        .arg(&paths.sys)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Result::Unavailable(format!(
                "{} executable was not found",
                program.to_string_lossy()
            ));
        }
        Err(error) => return Result::Error(format!("cannot run {PROGRAM} status: {error}")),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Result::Error(format!(
            "{PROGRAM} status exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(stdout) => stdout,
        Err(error) => {
            return Result::Error(format!("{PROGRAM} status emitted invalid UTF-8: {error}"))
        }
    };
    check_status(&stdout, kind)
}

fn check_status(stdout: &str, kind: Check) -> Result {
    let gpus: Vec<_> = stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let address = fields.next()?;
            let _identity = fields.next()?;
            let _class = fields.next()?;
            let provisioning = fields.next()?;
            (provisioning == "nvidia-in-band-cc").then_some((address, line))
        })
        .collect();

    if gpus.is_empty() {
        return Result::Unavailable(
            "kata-device-provisioner found no supported NVIDIA GPUs".into(),
        );
    }
    if kind == Check::Gpu {
        return Result::Available;
    }

    let (field, label) = match kind {
        Check::Cc => ("cc=capable", "CC"),
        Check::Ppcie => ("ppcie=capable", "PPCIE"),
        Check::Gpu => unreachable!(),
    };
    if gpus
        .iter()
        .any(|(_, line)| line.split_whitespace().any(|token| token == field))
    {
        Result::Available
    } else {
        Result::Unavailable(format!(
            "no supported NVIDIA GPU reports {label} capability"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{check_status, Check};
    use crate::probe::Result;

    const H100: &str = "0000:65:00.0  0x10de:2330  class=0x030200  nvidia-in-band-cc  chip=H100  driver=vfio-pci  iommu_group=42  numa=0  cc=capable  ppcie=capable  NVIDIA H100";
    const B200: &str = "0000:66:00.0  0x10de:2901  class=0x030200  nvidia-in-band-cc  chip=B200  driver=vfio-pci  iommu_group=43  numa=0  cc=capable  ppcie=n/a  NVIDIA B200";
    const SWITCH: &str = "0000:67:00.0  0x10de:22a3  class=0x068000  nvidia-in-band-ppcie  chip=-  driver=vfio-pci  iommu_group=44  numa=0  cc=n/a  ppcie=capable  NVSwitch";

    #[test]
    fn status_distinguishes_gpu_cc_and_ppcie_capability() {
        assert!(matches!(check_status(H100, Check::Gpu), Result::Available));
        assert!(matches!(check_status(H100, Check::Cc), Result::Available));
        assert!(matches!(
            check_status(H100, Check::Ppcie),
            Result::Available
        ));
        assert!(matches!(check_status(B200, Check::Cc), Result::Available));
        assert!(matches!(
            check_status(B200, Check::Ppcie),
            Result::Unavailable(_)
        ));
        assert!(matches!(
            check_status(SWITCH, Check::Gpu),
            Result::Unavailable(_)
        ));
        assert!(matches!(
            check_status(SWITCH, Check::Ppcie),
            Result::Unavailable(_)
        ));
        assert!(matches!(
            check_status(
                "no devices to provision (try --all to see what the node has)",
                Check::Gpu
            ),
            Result::Unavailable(_)
        ));
    }
}
