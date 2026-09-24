mod erofs;
mod gpu;
mod ibm_se;
mod iommufd;
mod kvm;
mod output;
mod platform;
mod probe;
mod snp;
mod tdx;

use probe::{Paths, Result};
use std::env;
use std::process::ExitCode;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    Kvm,
    Tdx,
    Snp,
    IbmSe,
    Iommufd,
    Erofs,
    Gpu,
    GpuCc,
    GpuPpcie,
}

impl Check {
    fn id(self) -> &'static str {
        match self {
            Self::Kvm => "kvm",
            Self::Tdx => "tdx",
            Self::Snp => "snp",
            Self::IbmSe => "ibm-se",
            Self::Iommufd => "iommufd",
            Self::Erofs => "erofs",
            Self::Gpu => "gpu",
            Self::GpuCc => "gpu-cc",
            Self::GpuPpcie => "gpu-ppcie",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Kvm => "KVM",
            Self::Tdx => "TDX",
            Self::Snp => "SNP",
            Self::IbmSe => "IBM Secure Execution",
            Self::Iommufd => "IOMMUFD",
            Self::Erofs => "EROFS utilities",
            Self::Gpu => "NVIDIA GPU",
            Self::GpuCc => "NVIDIA GPU CC",
            Self::GpuPpcie => "NVIDIA GPU PPCIE",
        }
    }

    fn run(self, paths: &Paths, architecture: &str) -> Result {
        match self {
            Self::Kvm => kvm::check(paths),
            Self::Tdx => tdx::check(paths),
            Self::Snp => snp::check(paths),
            Self::IbmSe => ibm_se::check(paths),
            Self::Iommufd => iommufd::check(paths),
            Self::Erofs => erofs::check(paths),
            Self::Gpu | Self::GpuCc | Self::GpuPpcie if !platform::supports_gpu(architecture) => {
                Result::Skipped(format!("GPU checks are not supported on {architecture}"))
            }
            Self::Gpu => gpu::check(gpu::Check::Gpu, paths),
            Self::GpuCc => gpu::check(gpu::Check::Cc, paths),
            Self::GpuPpcie => gpu::check(gpu::Check::Ppcie, paths),
        }
    }
}

struct Options {
    checks: Vec<Check>,
    json: bool,
}

fn usage() -> &'static str {
    "Usage: krab-preflight [--json] [--kvm] [--tdx] [--snp] [--ibm-se] [--iommufd] [--erofs] [--gpu] [--gpu-cc] [--gpu-ppcie]\n\
     Select one or more host checks. They do not launch a VM or test a VFIO device.\n\
     --kvm       /dev/kvm exists as a character device\n\
     --tdx       /sys/module/kvm_intel/parameters/tdx is enabled\n\
     --snp       /sys/module/kvm_amd/parameters/sev_snp is enabled\n\
     --ibm-se    /sys/firmware/uv/prot_virt_host is enabled\n\
     --iommufd   /dev/iommu exists as a character device\n\
     --erofs     mkfs.erofs contains the mkfs-time and sort options\n\
     --gpu       kata-device-provisioner finds a supported NVIDIA GPU\n\
     --gpu-cc    A supported NVIDIA GPU is CC capable\n\
     --gpu-ppcie A supported NVIDIA GPU is PPCIE capable\n\
     --json      Write one JSON object to stdout\n\
     --help      Show this help"
}

fn parse_args(args: impl IntoIterator<Item = String>) -> std::result::Result<Options, String> {
    let mut checks = Vec::new();
    let mut json = false;
    for arg in args {
        let check = match arg.as_str() {
            "--json" => {
                json = true;
                continue;
            }
            "--kvm" => Check::Kvm,
            "--tdx" => Check::Tdx,
            "--snp" => Check::Snp,
            "--ibm-se" => Check::IbmSe,
            "--iommufd" => Check::Iommufd,
            "--erofs" => Check::Erofs,
            "--gpu" => Check::Gpu,
            "--gpu-cc" => Check::GpuCc,
            "--gpu-ppcie" => Check::GpuPpcie,
            _ => return Err(format!("unknown option: {arg}")),
        };
        if !checks.contains(&check) {
            checks.push(check);
        }
    }
    if checks.is_empty() {
        Err("select at least one check".into())
    } else {
        Ok(Options { checks, json })
    }
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    }

    let options = match parse_args(args.drain(..)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}\n\n{}", usage());
            return ExitCode::from(2);
        }
    };

    let paths = Paths::default();
    let architecture = platform::architecture();
    let results: Vec<_> = options
        .checks
        .into_iter()
        .map(|check| (check, check.run(&paths, architecture)))
        .collect();
    if options.json {
        println!("{}", output::json(architecture, &results));
    } else {
        output::text(architecture, &results);
    }

    if results
        .iter()
        .any(|(_, result)| matches!(result, Result::Unavailable(_) | Result::Error(_)))
    {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_args, Check};
    use crate::probe::{Paths, Result};

    #[test]
    fn flags_select_only_the_requested_checks() {
        let options = parse_args(["--snp".into(), "--kvm".into(), "--snp".into()]).unwrap();
        assert_eq!(options.checks.len(), 2);
        assert!(matches!(options.checks[0], Check::Snp));
        assert!(matches!(options.checks[1], Check::Kvm));
        assert!(!options.json);
    }

    #[test]
    fn json_can_be_combined_with_a_check() {
        let options = parse_args(["--json".into(), "--snp".into()]).unwrap();
        assert!(options.json);
        assert!(matches!(options.checks[0], Check::Snp));
    }

    #[test]
    fn gpu_checks_skip_on_other_architectures() {
        let paths = Paths::default();
        for check in [Check::Gpu, Check::GpuCc, Check::GpuPpcie] {
            assert!(matches!(check.run(&paths, "s390x"), Result::Skipped(_)));
            assert!(matches!(check.run(&paths, "ppc64le"), Result::Skipped(_)));
        }
    }
}
