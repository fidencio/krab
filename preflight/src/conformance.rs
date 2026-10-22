//! Strict, selection-driven pre-flight capability conformance.
use crate::report::{self, ClusterReport, Identity, NodeReport, Probe, Status};
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HELP: &str = "Usage: krab-preflight conformance [--require REQUIREMENT ...] [--require-any gpu-cc,gpu-ppcie]
  (--report FILE | --run) [--json] [--output FILE]

Requirements: cc (any supported CPU TEE), tdx, snp, se, gpu-cc, gpu-ppcie, erofs.
Choose one CPU requirement and/or GPU requirements. Every node must pass all
selected requirements and KVM. Require erofs only for runtime classes that need it.
Unknown/review on required checks means fail.
--require-any LIST  Allow either GPU capability on each node: gpu-cc,gpu-ppcie
--gpu-model MODEL   Require a matching GPU model (repeat for alternatives)
--report FILE       Evaluate a v2 cluster pre-check report; '-' reads stdin
--nodes FILE        Also verify coverage against kubectl get nodes -o json
--run               Run fresh pre-flight probes through Helm, then evaluate
--node-selector S   Restrict --run to matching Linux nodes (default: all Linux nodes)
--chart PATH_OR_OCI  Pre-check chart (default: oci://ghcr.io/fidencio/krab-precheck)
--version VERSION   Chart version (default: this binary's version)
--namespace NAME    Pre-check namespace (default: krab-conformance)
--release NAME      Pre-check release (default: krab-conformance)
--context NAME      Kubernetes context (default: current context, pinned for the run)
--output FILE       Save the JSON verdict, node inventory, and pre-check evidence
--json              Write the JSON verdict to stdout instead of text
--termination-message FILE  Write a compact status summary for a Kubernetes container

Exit codes: 0 all nodes pass; 1 complete checks show nonconformance; 2 collection/evidence/CLI/output error.
This verifies reported host prerequisites; it does not launch confidential workloads or attest them.";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Requirement {
    Cc,
    Tdx,
    Snp,
    Se,
    GpuCc,
    GpuPpcie,
    Erofs,
}

impl Requirement {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cc" => Ok(Self::Cc),
            "tdx" => Ok(Self::Tdx),
            "snp" => Ok(Self::Snp),
            "se" => Ok(Self::Se),
            "gpu-cc" => Ok(Self::GpuCc),
            "gpu-ppcie" => Ok(Self::GpuPpcie),
            "erofs" => Ok(Self::Erofs),
            _ => Err(format!("Unknown conformance requirement: {value}")),
        }
    }
    fn gpu(self) -> bool {
        matches!(self, Self::GpuCc | Self::GpuPpcie)
    }
    fn name(self) -> &'static str {
        match self {
            Self::Cc => "cc",
            Self::Tdx => "tdx",
            Self::Snp => "snp",
            Self::Se => "se",
            Self::GpuCc => "gpu-cc",
            Self::GpuPpcie => "gpu-ppcie",
            Self::Erofs => "erofs",
        }
    }
}

pub struct Options {
    pub requirements: Vec<Requirement>,
    pub any_of_requirements: Vec<Requirement>,
    pub gpu_models: Vec<String>,
    report: Option<String>,
    nodes: Option<String>,
    run: bool,
    json: bool,
    output: Option<PathBuf>,
    collection_error: Option<PathBuf>,
    termination_message: Option<PathBuf>,
    chart: String,
    version: String,
    namespace: String,
    release: String,
    context: Option<String>,
    node_selector: String,
}

impl Options {
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut options = Self {
            requirements: Vec::new(),
            any_of_requirements: Vec::new(),
            gpu_models: Vec::new(),
            report: None,
            nodes: None,
            run: false,
            json: false,
            output: None,
            collection_error: None,
            termination_message: None,
            chart: "oci://ghcr.io/fidencio/krab-precheck".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            namespace: "krab-conformance".into(),
            release: "krab-conformance".into(),
            context: None,
            node_selector: String::new(),
        };
        let mut args = args.iter();
        let mut live_options = false;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--run" => {
                    options.run = true;
                    continue;
                }
                "--json" => {
                    options.json = true;
                    continue;
                }
                "--require"
                | "--require-any"
                | "--gpu-model"
                | "--report"
                | "--nodes"
                | "--output"
                | "--chart"
                | "--version"
                | "--namespace"
                | "--release"
                | "--context"
                | "--node-selector"
                | "--collection-error"
                | "--termination-message" => {}
                _ => return Err(format!("Unknown conformance option: {arg}")),
            }
            let value = args
                .next()
                .filter(|v| !v.trim().is_empty() && !v.starts_with("--"))
                .ok_or_else(|| format!("{arg} requires a value"))?
                .clone();
            match arg.as_str() {
                "--require" => {
                    let requirement = Requirement::parse(&value)?;
                    if !options.requirements.contains(&requirement) {
                        options.requirements.push(requirement);
                    }
                }
                "--gpu-model" => options.gpu_models.push(value),
                "--require-any" => {
                    for item in value.split(',') {
                        let requirement = Requirement::parse(item.trim())?;
                        if !requirement.gpu() {
                            return Err("--require-any accepts gpu-cc and gpu-ppcie".into());
                        }
                        if !options.any_of_requirements.contains(&requirement) {
                            options.any_of_requirements.push(requirement);
                        }
                    }
                }
                "--report" => options.report = Some(value),
                "--nodes" => options.nodes = Some(value),
                "--output" => options.output = Some(value.into()),
                "--collection-error" => options.collection_error = Some(value.into()),
                "--termination-message" => options.termination_message = Some(value.into()),
                _ => {
                    live_options = true;
                    match arg.as_str() {
                        "--chart" => options.chart = value,
                        "--version" => options.version = value,
                        "--namespace" => options.namespace = value,
                        "--release" => options.release = value,
                        "--context" => options.context = Some(value),
                        "--node-selector" => options.node_selector = value,
                        _ => unreachable!(),
                    }
                }
            }
        }
        if options.requirements.is_empty() && options.any_of_requirements.is_empty() {
            return Err(
                "Choose --require or --require-any; conformance never assumes a CC profile".into(),
            );
        }
        if options
            .requirements
            .iter()
            .filter(|r| {
                matches!(
                    r,
                    Requirement::Cc | Requirement::Tdx | Requirement::Snp | Requirement::Se
                )
            })
            .count()
            > 1
        {
            return Err(
                "Choose one CPU TEE requirement, or cc to allow any supported CPU TEE".into(),
            );
        }
        if !options.gpu_models.is_empty()
            && !options.requirements.iter().any(|r| r.gpu())
            && options.any_of_requirements.is_empty()
        {
            return Err("--gpu-model requires gpu-cc or gpu-ppcie".into());
        }
        if options.run == options.report.is_some() {
            return Err("Choose exactly one of --run or --report FILE".into());
        }
        if !options.run && live_options {
            return Err("Cluster/Helm options require --run".into());
        }
        if options.run && options.nodes.is_some() {
            return Err(
                "--run obtains its own live node inventory; --nodes is for saved reports".into(),
            );
        }
        Ok(options)
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Pass,
    Fail,
    Error,
}

impl Decision {
    fn exit_code(self) -> u8 {
        match self {
            Self::Pass => 0,
            Self::Fail => 1,
            Self::Error => 2,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Fail => "FAIL",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Finding {
    check: String,
    status: Status,
    reason: String,
}

impl Finding {
    fn unknown(check: &str, reason: impl Into<String>) -> Self {
        Self {
            check: check.into(),
            status: Status::Unknown,
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeVerdict {
    node_name: String,
    verdict: Decision,
    failures: Vec<Finding>,
    matched_any_of_requirements: Vec<Requirement>,
    checks: Vec<CheckEvidence>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    kind: &'static str,
    schema_version: u32,
    evaluated_at_unix_seconds: u64,
    pub verdict: Decision,
    requirements: Vec<Requirement>,
    any_of_requirements: Vec<Requirement>,
    gpu_models: Vec<String>,
    source: &'static str,
    coverage_verified: bool,
    total_nodes: usize,
    passed_nodes: usize,
    failed_nodes: usize,
    error_nodes: usize,
    failures: Vec<Finding>,
    nodes: Vec<NodeVerdict>,
    node_inventory: Vec<Identity>,
    precheck: Option<ClusterReport>,
}

/// Probe evidence and its role in the selected conformance policy.
/// A not-required probe may have been collected; its result cannot fail the node.
#[derive(Debug, Serialize)]
struct CheckEvidence {
    check: &'static str,
    evaluation: &'static str,
    status: Status,
    reason: String,
}

fn check_evidence(options: &Options, report: &NodeReport) -> Vec<CheckEvidence> {
    let selected = |requirement| options.requirements.contains(&requirement);
    let gpu =
        options.requirements.iter().any(|r| r.gpu()) || !options.any_of_requirements.is_empty();
    let cpu_alternative =
        |architecture| selected(Requirement::Cc) && report.node.architecture == architecture;
    let role = |required, alternative| {
        if required {
            "required"
        } else if alternative {
            "alternative"
        } else {
            "not-required"
        }
    };
    let gpu_role = |requirement| {
        role(
            selected(requirement),
            options.any_of_requirements.contains(&requirement),
        )
    };
    let mut probes = vec![
        ("kvm", &report.checks.kvm, "required"),
        (
            "erofs",
            &report.checks.erofs,
            role(selected(Requirement::Erofs), false),
        ),
        (
            "tdx",
            &report.checks.tdx,
            role(selected(Requirement::Tdx), cpu_alternative("amd64")),
        ),
        (
            "snp",
            &report.checks.snp,
            role(selected(Requirement::Snp), cpu_alternative("amd64")),
        ),
        (
            "se",
            &report.checks.se,
            role(selected(Requirement::Se), cpu_alternative("s390x")),
        ),
        ("iommufd", &report.checks.iommufd, role(gpu, false)),
        ("gpu-present", &report.gpus.present, role(gpu, false)),
        ("nvidia", &report.gpus.nvidia, role(gpu, false)),
        ("gpu-cc", &report.gpus.cc, gpu_role(Requirement::GpuCc)),
        (
            "gpu-ppcie",
            &report.gpus.ppcie,
            gpu_role(Requirement::GpuPpcie),
        ),
        ("nvswitch", &report.gpus.nvswitch, "not-required"),
    ];
    if let Some(runtime) = &report.runtime {
        probes.push(("runtime-layout", &runtime.layout, "required"));
    }
    probes
        .into_iter()
        .map(|(check, probe, evaluation)| CheckEvidence {
            check,
            evaluation,
            status: probe.status,
            reason: probe.reason.clone(),
        })
        .collect()
}

fn require(failures: &mut Vec<Finding>, check: &str, probe: &Probe) {
    if probe.status != Status::Yes {
        failures.push(Finding {
            check: check.into(),
            status: probe.status,
            reason: probe.reason.clone(),
        });
    }
}

fn gpu_failures(report: &NodeReport, requirement: Requirement) -> Vec<Finding> {
    let mut failures = Vec::new();
    let architecture = report.node.architecture.as_str();
    require(&mut failures, "iommufd", &report.checks.iommufd);
    require(&mut failures, "gpu-present", &report.gpus.present);
    require(&mut failures, "nvidia", &report.gpus.nvidia);
    if requirement == Requirement::GpuCc {
        require(&mut failures, "gpu-cc", &report.gpus.cc);
    } else {
        require(&mut failures, "gpu-ppcie", &report.gpus.ppcie);
    }
    if !crate::platform::supports_gpu(architecture) {
        failures.push(Finding::unknown(
            "architecture",
            format!("GPU checking is unsupported on {architecture}"),
        ));
    }
    if report.gpus.devices.is_empty()
        || report
            .gpus
            .devices
            .iter()
            .any(|d| d.name.trim().is_empty() || d.pci_bus_id.trim().is_empty())
    {
        failures.push(Finding::unknown(
            "gpu-inventory",
            "A complete GPU inventory is required",
        ));
    }
    failures
}

fn evaluate_node(
    options: &Options,
    report: &NodeReport,
    identity: Option<&Identity>,
) -> (Vec<Finding>, Vec<Requirement>) {
    let mut failures = Vec::new();
    require(&mut failures, "kvm", &report.checks.kvm);
    if let Some(runtime) = &report.runtime {
        require(&mut failures, "runtime-layout", &runtime.layout);
    }
    if report.node.kernel.trim().is_empty() || report.node.checked_at_unix_seconds == 0 {
        failures.push(Finding::unknown(
            "host-evidence",
            "Kernel or collection time is missing",
        ));
    }
    if report.node.checker_version != env!("CARGO_PKG_VERSION") {
        failures.push(Finding::unknown(
            "checker-version",
            format!(
                "Expected checker {}, found {}; rerun pre-flight",
                env!("CARGO_PKG_VERSION"),
                report.node.checker_version
            ),
        ));
    }
    if let Some(identity) = identity {
        if report.node.machine_id != identity.machine_id || report.node.boot_id != identity.boot_id
        {
            failures.push(Finding::unknown(
                "host-identity",
                "Report machine/boot identity does not match the selected node",
            ));
        }
    }
    for requirement in &options.requirements {
        let architecture = report.node.architecture.as_str();
        match requirement {
            Requirement::Erofs => require(&mut failures, "erofs", &report.checks.erofs),
            Requirement::Cc => {
                let probes: Vec<(&str, &Probe)> = match architecture {
                    "amd64" => vec![("tdx", &report.checks.tdx), ("snp", &report.checks.snp)],
                    "s390x" => vec![("se", &report.checks.se)],
                    _ => vec![],
                };
                if !probes.iter().any(|(_, probe)| probe.status == Status::Yes) {
                    failures.push(Finding::unknown(
                        "cc",
                        format!(
                            "No supported CPU TEE is confirmed on {architecture}: {}",
                            probes
                                .iter()
                                .map(|(name, probe)| format!(
                                    "{name}: {:?} ({})",
                                    probe.status, probe.reason
                                ))
                                .collect::<Vec<_>>()
                                .join("; ")
                        ),
                    ));
                }
            }
            Requirement::Tdx | Requirement::Snp | Requirement::Se => {
                let (check, probe, expected) = match requirement {
                    Requirement::Tdx => ("tdx", &report.checks.tdx, "amd64"),
                    Requirement::Snp => ("snp", &report.checks.snp, "amd64"),
                    _ => ("se", &report.checks.se, "s390x"),
                };
                require(&mut failures, check, probe);
                if architecture != expected {
                    failures.push(Finding::unknown(
                        "architecture",
                        format!("{check} requires {expected}, found {architecture}"),
                    ));
                }
            }
            Requirement::GpuCc | Requirement::GpuPpcie => {
                failures.extend(gpu_failures(report, *requirement));
            }
        }
    }
    if !options.gpu_models.is_empty()
        && !report.gpus.devices.iter().any(|device| {
            options.gpu_models.iter().any(|model| {
                device
                    .chip
                    .as_ref()
                    .is_some_and(|chip| chip.eq_ignore_ascii_case(model))
                    || device
                        .name
                        .split(|c: char| !c.is_alphanumeric())
                        .any(|token| token.eq_ignore_ascii_case(model))
            })
        })
    {
        failures.push(Finding::unknown(
            "gpu-model",
            format!(
                "No GPU matches the selected models: {}",
                options.gpu_models.join(", ")
            ),
        ));
    }
    let mut matched = Vec::new();
    let mut alternatives = Vec::new();
    for requirement in &options.any_of_requirements {
        let issues = gpu_failures(report, *requirement);
        if issues.is_empty() {
            matched.push(*requirement);
        } else {
            alternatives.push(format!(
                "{}: {}",
                requirement.name(),
                issues
                    .iter()
                    .map(|issue| format!("{} {:?}: {}", issue.check, issue.status, issue.reason))
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
    }
    if !options.any_of_requirements.is_empty() && matched.is_empty() {
        failures.push(Finding::unknown(
            "require-any",
            format!("No GPU alternative passed: {}", alternatives.join(" | ")),
        ));
    }
    (failures, matched)
}

pub fn evaluate(
    options: &Options,
    report: Option<ClusterReport>,
    expected: Option<Vec<Identity>>,
    errors: Vec<String>,
) -> Verdict {
    let mut failures: Vec<_> = errors
        .into_iter()
        .map(|e| Finding::unknown("collection", e))
        .collect();
    let mut nodes = Vec::new();
    let mut inventory = expected.unwrap_or_else(|| {
        report
            .as_ref()
            .map(|r| r.scope.nodes.clone())
            .unwrap_or_default()
    });
    inventory.sort();
    let mut coverage_verified = false;
    if let Some(report) = &report {
        if report.scope.node_selector.trim().is_empty() {
            failures.push(Finding::unknown(
                "scope",
                "The report must identify its selected node scope",
            ));
        }
        let scope_validation = report::validate_identities(&report.scope.nodes);
        let inventory_validation = report::validate_identities(&inventory);
        if let Err(error) = scope_validation.and(inventory_validation) {
            failures.push(Finding::unknown("coverage", error));
        } else {
            let mut snapshot = report.scope.nodes.clone();
            snapshot.sort();
            let reported: BTreeSet<_> = report.nodes.iter().map(|n| n.node_name.as_str()).collect();
            let expected: BTreeSet<_> = inventory.iter().map(|n| n.name.as_str()).collect();
            coverage_verified =
                failures.is_empty() && snapshot == inventory && reported == expected;
            if !coverage_verified {
                failures.push(Finding::unknown("coverage", format!("Node identities or report coverage differ from inventory. Missing: {:?}; unexpected: {:?}",
                    expected.difference(&reported).collect::<Vec<_>>(), reported.difference(&expected).collect::<Vec<_>>())));
            }
        }
        for entry in &report.nodes {
            let (issues, matched_any_of_requirements) = evaluate_node(
                options,
                &entry.report,
                inventory.iter().find(|node| node.name == entry.node_name),
            );
            nodes.push(NodeVerdict {
                node_name: entry.node_name.clone(),
                verdict: if issues.iter().any(|issue| {
                    matches!(
                        issue.check.as_str(),
                        "host-identity" | "checker-version" | "host-evidence"
                    )
                }) {
                    Decision::Error
                } else if issues.is_empty() {
                    Decision::Pass
                } else {
                    Decision::Fail
                },
                failures: issues,
                matched_any_of_requirements,
                checks: check_evidence(options, &entry.report),
            });
        }
    } else {
        failures.push(Finding::unknown(
            "evidence",
            "No valid v2 cluster pre-check evidence was collected",
        ));
    }
    nodes.sort_by(|a, b| a.node_name.cmp(&b.node_name));
    let passed_nodes = nodes
        .iter()
        .filter(|node| node.verdict == Decision::Pass)
        .count();
    let failed_nodes = nodes
        .iter()
        .filter(|node| node.verdict == Decision::Fail)
        .count();
    let error_nodes = nodes
        .iter()
        .filter(|node| node.verdict == Decision::Error)
        .count();
    Verdict {
        kind: "krab-cc-conformance",
        schema_version: 1,
        evaluated_at_unix_seconds: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        verdict: if !coverage_verified
            || !failures.is_empty()
            || nodes.is_empty()
            || error_nodes > 0
        {
            Decision::Error
        } else if failed_nodes == 0 {
            Decision::Pass
        } else {
            Decision::Fail
        },
        requirements: options.requirements.clone(),
        any_of_requirements: options.any_of_requirements.clone(),
        gpu_models: options.gpu_models.clone(),
        source: if options.run {
            "live-cluster"
        } else if options.collection_error.is_some() {
            "cluster-job"
        } else {
            "saved-report"
        },
        coverage_verified,
        total_nodes: nodes.len(),
        passed_nodes,
        failed_nodes,
        error_nodes,
        failures,
        nodes,
        node_inventory: inventory,
        precheck: report,
    }
}

fn read(path: &str) -> Result<String, String> {
    if path == "-" {
        let mut text = String::new();
        std::io::stdin()
            .take(50_000_001)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        if text.len() > 50_000_000 {
            return Err("Report exceeds 50 MB limit".into());
        }
        Ok(text)
    } else {
        fs::read_to_string(path).map_err(|error| format!("Cannot read {path}: {error}"))
    }
}

fn command(program: &str, args: &[String]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Cannot run {program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} failed ({}): {} {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&output.stdout).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("{program} emitted invalid UTF-8: {e}"))
}

struct ValuesFile(PathBuf);
impl Drop for ValuesFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn collect(options: &Options) -> Result<(String, Vec<Identity>, Vec<String>), String> {
    let context = match &options.context {
        Some(context) => context.clone(),
        None => command("kubectl", &["config".into(), "current-context".into()])?
            .trim()
            .to_owned(),
    };
    if context.is_empty() {
        return Err("No Kubernetes context selected".into());
    }
    let selector = if options.node_selector.is_empty() {
        "kubernetes.io/os=linux".into()
    } else {
        format!("{},kubernetes.io/os=linux", options.node_selector)
    };
    let kubectl = |tail: Vec<String>| {
        let mut args = vec![
            "--context".into(),
            context.clone(),
            "--request-timeout=60s".into(),
        ];
        args.extend(tail);
        command("kubectl", &args)
    };
    let list = || {
        kubectl(vec![
            "get".into(),
            "nodes".into(),
            "--selector".into(),
            selector.clone(),
            "-o".into(),
            "json".into(),
        ])
    };
    let before = report::inventory(&list()?)?;
    let values = ValuesFile(std::env::temp_dir().join(
        format!("krab-conformance-{}-{}.json", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()),
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&values.0)
        .map_err(|e| e.to_string())?;
    let content = serde_json::json!({"nodeSelector":options.node_selector,"cache":{"enabled":true,"forceRefresh":true}});
    file.write_all(content.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    command(
        "helm",
        &[
            "upgrade".into(),
            "--install".into(),
            options.release.clone(),
            options.chart.clone(),
            "--version".into(),
            options.version.clone(),
            "--namespace".into(),
            options.namespace.clone(),
            "--create-namespace".into(),
            "--kube-context".into(),
            context.clone(),
            "--timeout".into(),
            "35m".into(),
            "--wait".into(),
            "--values".into(),
            values.0.to_string_lossy().into_owned(),
        ],
    )?;
    let name: String = options.release.chars().take(45).collect();
    let text = kubectl(vec![
        "--namespace".into(),
        options.namespace.clone(),
        "logs".into(),
        format!("job/{}-results", name.trim_end_matches('-')),
    ])?;
    let errors = match list().and_then(|text| report::inventory(&text)) {
        Ok(after) if before == after => vec![],
        Ok(_) => vec!["Selected nodes or machine/boot identities changed during pre-flight; rerun conformance".into()],
        Err(error) => vec![format!("Cannot verify final node inventory: {error}")],
    };
    Ok((text, before, errors))
}

pub fn run(args: &[String]) -> ExitCode {
    if args == ["--help"] || args == ["-h"] {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let options = match Options::parse(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    let mut errors = Vec::new();
    if let Some(path) = &options.collection_error {
        match fs::read_to_string(path) {
            Ok(message) if !message.trim().is_empty() => errors.push(message.trim().to_owned()),
            Ok(_) => {}
            Err(error) => errors.push(format!(
                "Cannot read collection status {}: {error}",
                path.display()
            )),
        }
    }
    let (text, expected) = if options.run {
        match collect(&options) {
            Ok((text, inventory, issues)) => {
                errors.extend(issues);
                (Some(text), Some(inventory))
            }
            Err(error) => {
                errors.push(error);
                (None, None)
            }
        }
    } else {
        let text = match read(options.report.as_deref().unwrap()) {
            Ok(text) => Some(text),
            Err(error) => {
                errors.push(error);
                None
            }
        };
        let expected = options
            .nodes
            .as_deref()
            .map(|path| read(path).and_then(|text| report::inventory(&text)));
        let expected = match expected {
            Some(Ok(inventory)) => Some(inventory),
            Some(Err(error)) => {
                errors.push(error);
                None
            }
            None => None,
        };
        (text, expected)
    };
    let report = text.and_then(|text| match report::parse(&text) {
        Ok(report) => Some(report),
        Err(error) => {
            errors.push(error);
            None
        }
    });
    let verdict = evaluate(&options, report, expected, errors);
    let json = serde_json::to_string_pretty(&verdict).expect("conformance verdict is serializable");
    if let Some(path) = &options.output {
        if let Err(error) = fs::write(path, format!("{json}\n")) {
            eprintln!("Cannot write verdict to {}: {error}", path.display());
            return ExitCode::from(2);
        }
    }
    if let Some(path) = &options.termination_message {
        let message = serde_json::json!({"verdict":verdict.verdict,"exitCode":verdict.verdict.exit_code(),
            "totalNodes":verdict.total_nodes,"passedNodes":verdict.passed_nodes,
            "failedNodes":verdict.failed_nodes,"errorNodes":verdict.error_nodes,
            "coverageVerified":verdict.coverage_verified});
        if let Err(error) = fs::write(path, message.to_string()) {
            eprintln!("Cannot write termination message: {error}");
            return ExitCode::from(2);
        }
    }
    if options.json {
        println!("{json}");
    } else {
        println!(
            "{}: CC pre-flight capability conformance ({})",
            verdict.verdict.label(),
            verdict.source
        );
        println!(
            "{} nodes: {} passed, {} failed, {} errors; coverage verified: {}",
            verdict.total_nodes,
            verdict.passed_nodes,
            verdict.failed_nodes,
            verdict.error_nodes,
            verdict.coverage_verified
        );
        for issue in &verdict.failures {
            println!("  {}: {}", issue.check, issue.reason);
        }
        for node in &verdict.nodes {
            println!("  {}: {}", node.node_name, node.verdict.label());
            for check in &node.checks {
                println!(
                    "    {} [{}]: {:?}: {}",
                    check.check, check.evaluation, check.status, check.reason
                );
            }
            for issue in &node.failures {
                println!(
                    "  {} / {}: {:?}: {}",
                    node.node_name, issue.check, issue.status, issue.reason
                );
            }
        }
        println!("Evidence covers reported host prerequisites; workload launch and attestation are untested.");
    }
    ExitCode::from(verdict.verdict.exit_code())
}
