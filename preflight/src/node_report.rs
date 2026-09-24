use crate::output::json_string;
use crate::probe::{Paths, Result};
use crate::Check;
use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

struct Probe {
    status: &'static str,
    reason: String,
}

impl Probe {
    fn new(status: &'static str, reason: &str) -> Self {
        Self {
            status,
            reason: reason.into(),
        }
    }

    fn from_check(check: Check, result: Result) -> Self {
        match result {
            Result::Available => Self::new("yes", &format!("{} is available", check.id())),
            Result::Unavailable(reason) => Self::new("no", &reason),
            Result::Skipped(reason) | Result::Error(reason) => Self::new("unknown", &reason),
        }
    }

    fn json(&self, output: &mut String) {
        output.push_str("{\"status\":");
        json_string(output, self.status);
        output.push_str(",\"reason\":");
        json_string(output, &self.reason);
        output.push('}');
    }
}

struct GpuDevice {
    bus: String,
    name: String,
    chip: Option<String>,
}

struct Inventory {
    devices: Vec<GpuDevice>,
    switch_found: bool,
    cc_yes: bool,
    cc_no: bool,
    ppcie_yes: bool,
    ppcie_no: bool,
}

fn parse_inventory(text: &str) -> Inventory {
    let mut result = Inventory {
        devices: Vec::new(),
        switch_found: false,
        cc_yes: false,
        cc_no: false,
        ppcie_yes: false,
        ppcie_no: false,
    };
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(bus) = fields.next() else { continue };
        let Some(identity) = fields.next() else {
            continue;
        };
        if !identity.starts_with("0x10de:") || !bus.contains(':') || !bus.contains('.') {
            continue;
        }
        let tokens: Vec<_> = line.split_whitespace().collect();
        if tokens.iter().any(|field| field.starts_with("class=0x0680")) {
            result.switch_found = true;
        }
        if !tokens.iter().any(|field| field.starts_with("class=0x0302")) {
            continue;
        }
        let chip = tokens
            .iter()
            .find_map(|field| field.strip_prefix("chip="))
            .filter(|value| *value != "-")
            .map(str::to_owned);
        let name = line.rsplit("  ").next().unwrap_or("").trim();
        result.devices.push(GpuDevice {
            bus: bus.into(),
            name: name.into(),
            chip,
        });
        result.cc_yes |= tokens.contains(&"cc=capable");
        result.cc_no |= tokens.contains(&"cc=n/a");
        result.ppcie_yes |= tokens.contains(&"ppcie=capable");
        result.ppcie_no |= tokens.contains(&"ppcie=n/a");
    }
    result
}

fn pci_fallback(sys: &Path) -> (Probe, Probe) {
    let mut present = Probe::new("unknown", "PCI inventory is unavailable");
    let mut nvidia = Probe::new("unknown", "PCI inventory is unavailable");
    let Ok(entries) = fs::read_dir(sys.join("bus/pci/devices")) else {
        return (present, nvidia);
    };
    let mut readable = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let (Ok(class), Ok(vendor)) = (
            fs::read_to_string(path.join("class")),
            fs::read_to_string(path.join("vendor")),
        ) else {
            continue;
        };
        readable = true;
        if class.trim().starts_with("0x03") {
            present = Probe::new("yes", "Display or compute PCI device found");
            if vendor.trim().eq_ignore_ascii_case("0x10de") {
                nvidia = Probe::new("yes", "NVIDIA GPU found in PCI inventory");
            }
        }
    }
    if readable {
        if present.status == "unknown" {
            present = Probe::new("no", "No display or compute PCI device was found");
        }
        if nvidia.status == "unknown" {
            nvidia = Probe::new("no", "No NVIDIA GPU was found in PCI inventory");
        }
    }
    (present, nvidia)
}

fn inventory(paths: &Paths, architecture: &str) -> Option<Inventory> {
    let default = format!("/opt/krab/kata-device-provisioner-{architecture}");
    let program = std::env::var_os("KRAB_PROVISIONER").unwrap_or_else(|| default.into());
    let output = Command::new(program)
        .args(["status", "--all", "--sysfs"])
        .arg(&paths.sys)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_inventory(&String::from_utf8_lossy(&output.stdout)))
}

pub fn render(paths: &Paths, architecture: &str) -> io::Result<String> {
    if !paths.host_root.join("proc/cpuinfo").is_file() || !paths.sys.join("devices").is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "host /proc and /sys are required",
        ));
    }
    let kernel = fs::read_to_string(paths.host_root.join("proc/sys/kernel/osrelease"))?;
    if std::env::var_os("KRAB_PROVISIONER").is_none() {
        std::env::set_var(
            "KRAB_PROVISIONER",
            format!("/opt/krab/kata-device-provisioner-{architecture}"),
        );
    }
    let checks = [
        ("kvm", Check::Kvm),
        ("tdx", Check::Tdx),
        ("snp", Check::Snp),
        ("se", Check::IbmSe),
        ("iommufd", Check::Iommufd),
        ("erofs", Check::Erofs),
    ];
    let (mut present, mut nvidia) = pci_fallback(&paths.sys);
    let mut cc = Probe::from_check(Check::GpuCc, Check::GpuCc.run(paths, architecture));
    let mut ppcie = Probe::from_check(Check::GpuPpcie, Check::GpuPpcie.run(paths, architecture));
    let gpu = Probe::from_check(Check::Gpu, Check::Gpu.run(paths, architecture));
    let mut nvswitch = Probe::new("unknown", "Provisioner inventory unavailable");
    let inventory = inventory(paths, architecture);
    if let Some(ref inventory) = inventory {
        if inventory.cc_yes && inventory.cc_no {
            cc = Probe::new(
                "review",
                "Mixed CC-capable and incapable GPUs need per-profile review",
            );
        }
        if inventory.ppcie_yes && inventory.ppcie_no {
            ppcie = Probe::new(
                "review",
                "Mixed PPCIE-capable and incapable GPUs need per-profile review",
            );
        }
        nvswitch = if inventory.switch_found {
            Probe::new("yes", "Kata device provisioner found an NVSwitch")
        } else {
            Probe::new("no", "No NVSwitch in provisioner inventory")
        };
        if !inventory.devices.is_empty() {
            present = Probe::new("yes", "Kata device provisioner found a GPU");
            nvidia = Probe::new("yes", "Kata device provisioner found an NVIDIA GPU");
        }
    }
    if gpu.status == "yes" {
        present = Probe::new("yes", "Kata device provisioner found a GPU");
        nvidia = Probe::new("yes", "Kata device provisioner found an NVIDIA GPU");
    }

    let mut output = String::from(
        "{\"schemaVersion\":1,\"kind\":\"krab-node-precheck\",\"node\":{\"architecture\":",
    );
    json_string(&mut output, architecture);
    output.push_str(",\"kernel\":");
    json_string(&mut output, kernel.trim());
    output.push_str("},\"checks\":{");
    for (index, (name, check)) in checks.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        json_string(&mut output, name);
        output.push(':');
        Probe::from_check(*check, check.run(paths, architecture)).json(&mut output);
    }
    output.push_str("},\"erofsVersion\":null,\"gpus\":{");
    for (index, (name, probe)) in [
        ("present", &present),
        ("nvidia", &nvidia),
        ("cc", &cc),
        ("ppcie", &ppcie),
        ("nvswitch", &nvswitch),
    ]
    .iter()
    .enumerate()
    {
        if index != 0 {
            output.push(',');
        }
        json_string(&mut output, name);
        output.push(':');
        probe.json(&mut output);
    }
    output.push_str(",\"devices\":[");
    if let Some(inventory) = inventory {
        for (index, device) in inventory.devices.iter().enumerate() {
            if index != 0 {
                output.push(',');
            }
            output.push_str("{\"pciBusId\":");
            json_string(&mut output, &device.bus);
            output.push_str(",\"name\":");
            json_string(&mut output, &device.name);
            output.push_str(",\"chip\":");
            if let Some(chip) = &device.chip {
                json_string(&mut output, chip);
            } else {
                output.push_str("null");
            }
            output.push('}');
        }
    }
    output.push_str("]}}");
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::parse_inventory;

    #[test]
    fn inventory_keeps_gpu_models_and_mixed_modes() {
        let text = "0000:65:00.0  0x10de:2330  class=0x030200  nvidia-in-band-cc  chip=H100  cc=capable  ppcie=capable  NVIDIA H100\n\
                    0000:66:00.0  0x10de:2901  class=0x030200  nvidia-in-band-cc  chip=B200  cc=n/a  ppcie=n/a  NVIDIA B200\n\
                    0000:67:00.0  0x10de:22a3  class=0x068000  nvidia-in-band-ppcie  chip=-  NVSwitch";
        let result = parse_inventory(text);
        assert_eq!(result.devices.len(), 2);
        assert_eq!(result.devices[0].chip.as_deref(), Some("H100"));
        assert!(result.switch_found);
        assert!(result.cc_yes && result.cc_no);
        assert!(result.ppcie_yes && result.ppcie_no);
    }
}
