mod cache;
mod conformance;
mod erofs;
mod gpu;
mod ibm_se;
mod iommufd;
mod kvm;
mod node_report;
mod output;
mod platform;
mod probe;
mod report;
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
    "Usage: krab-preflight conformance --help\n\
     or: krab-preflight --node-report\n\
     or: krab-preflight [--json] [--kvm] [--tdx] [--snp] [--ibm-se] [--iommufd] [--erofs] [--gpu] [--gpu-cc] [--gpu-ppcie]\n\
     Select one or more host checks. They do not launch a VM or test a VFIO device.\n\
     --kvm       /dev/kvm exists as a character device\n\
     --tdx       /sys/module/kvm_intel/parameters/tdx is enabled\n\
     --snp       /sys/module/kvm_amd/parameters/sev_snp is enabled\n\
     --ibm-se    /sys/firmware/uv/prot_virt_host is enabled\n\
     --iommufd   /dev/iommu readiness and running-kernel module support\n\
     --erofs     mkfs.erofs contains the mkfs-time and sort options\n\
     --gpu       kata-device-provisioner finds a supported NVIDIA GPU\n\
     --gpu-cc    A supported NVIDIA GPU is CC capable\n\
     --gpu-ppcie A supported NVIDIA GPU is PPCIE capable\n\
     --json      Write one JSON object to stdout\n\
     --node-report  Write a complete KRAB node report\n\
     --cache-dir DIR  Store results in DIR (default: $XDG_CACHE_HOME/krab/preflight or $HOME/.cache/krab/preflight)\n\
     --force-refresh  Repeat checks and replace the cached result\n\
     --no-cache     Run checks without reading or writing cached results\n\
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
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "conformance") {
        return conformance::run(&args[1..]);
    }
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    }
    let (mut cache_options, args) = match cache::parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}\n\n{}", usage());
            return ExitCode::from(2);
        }
    };
    let node_report = args.len() == 1 && args[0] == "--node-report";
    cache_options.quiet = node_report;
    let options = if node_report {
        None
    } else {
        match parse_args(args.clone()) {
            Ok(options) => Some(options),
            Err(error) => {
                eprintln!("{error}\n\n{}", usage());
                return ExitCode::from(2);
            }
        }
    };
    let paths = Paths::default();
    let architecture = platform::architecture();
    // Set the node report's bundled provisioner before deriving the cache identity.
    if node_report && env::var_os("KRAB_PROVISIONER").is_none() {
        env::set_var(
            "KRAB_PROVISIONER",
            format!("/opt/krab/kata-device-provisioner-{architecture}"),
        );
    }
    let result = cache::run(
        &cache_options,
        || cache::identity(&paths, &args, architecture),
        || execute(options.as_ref(), &paths, architecture),
    );
    print!("{}", result.stdout);
    eprint!("{}", result.stderr);
    ExitCode::from(result.status)
}

fn execute(options: Option<&Options>, paths: &Paths, architecture: &str) -> cache::Output {
    let Some(options) = options else {
        match node_report::render(paths, architecture) {
            Ok((report, cacheable)) => {
                return cache::Output {
                    stdout: format!("{report}\n"),
                    stderr: String::new(),
                    status: 0,
                    cacheable,
                };
            }
            Err(error) => {
                return cache::Output {
                    stdout: String::new(),
                    stderr: format!("cannot collect node report: {error}\n"),
                    status: 1,
                    cacheable: false,
                };
            }
        }
    };
    let results: Vec<_> = options
        .checks
        .iter()
        .map(|&check| (check, check.run(paths, architecture)))
        .collect();
    let (stdout, stderr) = if options.json {
        (
            format!("{}\n", output::json(architecture, &results)),
            String::new(),
        )
    } else {
        output::text(architecture, &results)
    };

    let status = if results
        .iter()
        .any(|(_, result)| matches!(result, Result::Unavailable(_) | Result::Error(_)))
    {
        1
    } else {
        0
    };
    cache::Output {
        stdout,
        stderr,
        status,
        cacheable: !results
            .iter()
            .any(|(_, result)| matches!(result, Result::Error(_))),
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
