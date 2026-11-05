//! Shared live pre-check collection used by the CLI and conformance evaluator.
use crate::report::{self, Identity};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct Options {
    pub chart: String,
    pub version: String,
    pub namespace: String,
    pub release: String,
    pub context: Option<String>,
    pub kubeconfig: Option<PathBuf>,
    pub node_selector: String,
    pub node: Option<String>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            chart: "oci://ghcr.io/fidencio/krab-precheck".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            namespace: "krab-conformance".into(),
            release: "krab-conformance".into(),
            context: None,
            kubeconfig: None,
            node_selector: String::new(),
            node: None,
        }
    }
}
impl Options {
    pub fn kubectl(&self, args: &[String]) -> Result<String, String> {
        let mut connection = Vec::new();
        if let Some(path) = &self.kubeconfig {
            std::fs::File::open(path)
                .map_err(|e| format!("Cannot read kubeconfig {}: {e}", path.display()))?;
            connection.extend(["--kubeconfig".into(), path.to_string_lossy().into_owned()]);
        }
        connection.extend_from_slice(args);
        command("kubectl", &connection)
    }
    pub fn context(&self) -> Result<String, String> {
        let context = match &self.context {
            Some(context) => context.clone(),
            None => self
                .kubectl(&["config".into(), "current-context".into()])?
                .trim()
                .into(),
        };
        if context.is_empty() {
            return Err(
                "No Kubernetes context selected; set KUBECONFIG or pass --kubeconfig/--context"
                    .into(),
            );
        }
        Ok(context)
    }
    pub fn nodes(&self) -> Result<String, String> {
        let selector = if self.node_selector.is_empty() {
            "kubernetes.io/os=linux".into()
        } else {
            format!("{},kubernetes.io/os=linux", self.node_selector)
        };
        self.kubectl(&[
            "--context".into(),
            self.context()?,
            "--request-timeout=15s".into(),
            "get".into(),
            "nodes".into(),
            "--selector".into(),
            selector,
            "-o".into(),
            "json".into(),
        ])
    }
}

pub fn command(program: &str, args: &[String]) -> Result<String, String> {
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

pub fn collect(options: &Options) -> Result<(String, Vec<Identity>, Vec<String>), String> {
    let context = options.context()?;
    // Verify Helm exists before attempting a cluster installation.
    command("helm", &["version".into(), "--short".into()])?;
    let mut selected = options.clone();
    selected.context = Some(context.clone());
    if let Some(node) = &options.node {
        let inventory: serde_json::Value =
            serde_json::from_str(&selected.nodes()?).map_err(|e| e.to_string())?;
        let entry = inventory["items"]
            .as_array()
            .ok_or("Node inventory has no items")?
            .iter()
            .find(|n| n["metadata"]["name"].as_str() == Some(node.as_str()))
            .ok_or_else(|| {
                format!("Linux node {node} was not found in the selected context/scope")
            })?;
        let hostname = entry["metadata"]["labels"]["kubernetes.io/hostname"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("Node has no kubernetes.io/hostname label")?;
        selected.node_selector = if selected.node_selector.is_empty() {
            format!("kubernetes.io/hostname={hostname}")
        } else {
            format!(
                "{},kubernetes.io/hostname={hostname}",
                selected.node_selector
            )
        };
    }
    let options = &selected;
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
        options.kubectl(&args)
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
    if let Some(node) = &options.node {
        if before.len() != 1 || before[0].name != *node {
            return Err("Node hostname label does not uniquely identify the requested node".into());
        }
    }
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
    let mut helm_args = vec![
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
    ];
    if let Some(path) = &options.kubeconfig {
        helm_args.extend(["--kubeconfig".into(), path.to_string_lossy().into_owned()]);
    }
    command("helm", &helm_args)?;
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

/// Collect evidence without interpreting unknown or unavailable optional probes
/// as a conformance failure. Coverage and host identity must still be complete.
pub fn precheck(options: &Options) -> Result<String, String> {
    let (text, expected, errors) = collect(options)?;
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    let report = report::parse(&text)?;
    let mut scope = report.scope.nodes.clone();
    scope.sort();
    if scope != expected || report.nodes.len() != expected.len() {
        return Err("Pre-check evidence does not cover the selected node inventory".into());
    }
    for identity in &expected {
        let entry = report
            .nodes
            .iter()
            .find(|e| e.node_name == identity.name)
            .ok_or_else(|| format!("Missing pre-check report for {}", identity.name))?;
        if entry.report.node.machine_id != identity.machine_id
            || entry.report.node.boot_id != identity.boot_id
        {
            return Err(format!(
                "Pre-check host identity changed for {}",
                identity.name
            ));
        }
    }
    serde_json::to_string_pretty(&report).map_err(|e| e.to_string())
}
