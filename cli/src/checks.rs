use clap::Parser;
use krab_preflight::cluster::Options;
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

#[derive(Parser)]
#[command(
    name = "krab precheck",
    about = "Run fresh host probes on Kubernetes nodes using the pre-check Helm chart"
)]
struct Remote {
    #[arg(long)]
    node: Option<String>,
    #[arg(long)]
    node_selector: Option<String>,
    #[arg(long)]
    context: Option<String>,
    #[arg(long)]
    kubeconfig: Option<PathBuf>,
    #[arg(long)]
    run: bool,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long)]
    chart: Option<String>,
    #[arg(long)]
    version: Option<String>,
    #[arg(long, default_value = "krab-precheck")]
    namespace: String,
    #[arg(long, default_value = "krab-precheck")]
    release: String,
}

pub fn remote(args: &[String]) -> bool {
    args.iter().any(|a| {
        [
            "--node",
            "--node-selector",
            "--run",
            "--context",
            "--kubeconfig",
        ]
        .iter()
        .any(|flag| a == flag || a.starts_with(&format!("{flag}=")))
    })
}
pub fn run_precheck(args: Vec<String>) -> ExitCode {
    let parsed =
        match Remote::try_parse_from(std::iter::once("krab precheck".to_owned()).chain(args)) {
            Ok(parsed) => parsed,
            Err(error) => {
                let code = error.exit_code() as u8;
                let _ = error.print();
                return ExitCode::from(code);
            }
        };
    if let Some(path) = &parsed.output {
        if path.exists() {
            eprintln!(
                "krab: {} already exists; choose another output filename",
                path.display()
            );
            return ExitCode::from(2);
        }
    }
    let mut options = Options {
        node: parsed.node,
        node_selector: parsed.node_selector.unwrap_or_default(),
        context: parsed.context,
        kubeconfig: parsed.kubeconfig,
        namespace: parsed.namespace,
        release: parsed.release,
        ..Options::default()
    };
    if let Some(chart) = parsed.chart {
        options.chart = chart;
    }
    if let Some(version) = parsed.version {
        options.version = version;
    }
    match krab_preflight::cluster::precheck(&options).and_then(|text| {
        if let Some(path) = parsed.output {
            super::output(Some(&path), &format!("{text}\n"), false)?;
        }
        println!("{text}");
        Ok(())
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("krab precheck: {error}");
            ExitCode::from(2)
        }
    }
}

pub fn collect(
    options: &Options,
    requirements: &[String],
    conformance: bool,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    use std::io::Read;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.args([
        if conformance {
            "conformance"
        } else {
            "precheck"
        },
        "--run",
        "--json",
        "--context",
        &options.context()?,
    ]);
    if let Some(path) = &options.kubeconfig {
        command.arg("--kubeconfig").arg(path);
    }
    if !options.node_selector.is_empty() {
        command.args(["--node-selector", &options.node_selector]);
    }
    if let Some(node) = &options.node {
        command.args(["--node", node]);
    }
    command.args([
        "--namespace",
        &options.namespace,
        "--release",
        &options.release,
    ]);
    for requirement in requirements.iter().filter(|_| conformance) {
        command.args(["--require", requirement]);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let output = std::thread::spawn(move || {
        let mut data = String::new();
        stdout.read_to_string(&mut data).map(|_| data)
    });
    let errors = std::thread::spawn(move || {
        let mut data = String::new();
        stderr.read_to_string(&mut data).map(|_| data)
    });
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if cancelled.load(Ordering::Relaxed) {
            #[cfg(unix)]
            if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::Term);
            }
            let _ = child.kill();
            let _ = child.wait();
            // Collection subprocesses share a group, so kubectl/Helm readers end too.
            let _ = output.join();
            let _ = errors.join();
            return Err("Collection cancelled. The pre-check Helm release and any running cluster Jobs remain in the cluster.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let text = output
        .join()
        .map_err(|_| "Cannot read check output")?
        .map_err(|e| e.to_string())?;
    let error = errors
        .join()
        .map_err(|_| "Cannot read check errors")?
        .map_err(|e| e.to_string())?;
    if serde_json::from_str::<Value>(&text).is_ok() {
        Ok(text)
    } else {
        Err(error.trim().to_owned())
    }
}

pub fn report_lines(
    text: &str,
    failed_only: bool,
) -> Result<(String, Vec<(String, String)>), String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let conformance = value["kind"] == "krab-cc-conformance";
    let summary = if conformance {
        format!(
            "{} · {} nodes · {} passed · {} failed · {} errors",
            value["verdict"].as_str().unwrap_or("error").to_uppercase(),
            value["totalNodes"],
            value["passedNodes"],
            value["failedNodes"],
            value["errorNodes"]
        )
    } else {
        format!(
            "Pre-check reports · {} nodes (capability evidence, not a conformance verdict)",
            value["nodes"].as_array().map_or(0, Vec::len)
        )
    };
    let mut rows = Vec::new();
    if let Some(nodes) = value["nodes"].as_array() {
        for node in nodes {
            let name = node["nodeName"].as_str().unwrap_or("unknown");
            let status = node["verdict"].as_str().unwrap_or("report");
            if conformance && failed_only && status == "pass" {
                continue;
            }
            let mut detail = format!("{name} · {}\n", status.to_uppercase());
            if conformance {
                if let Some(failures) = node["failures"].as_array() {
                    for finding in failures {
                        detail.push_str(&format!(
                            "\n{}: {}",
                            finding["check"].as_str().unwrap_or("evidence"),
                            finding["reason"].as_str().unwrap_or("unknown")
                        ));
                    }
                }
                if status == "pass" {
                    detail.push_str("\nAll selected prerequisites passed.");
                }
            } else {
                for section in ["checks", "gpus"] {
                    if let Some(checks) = node["report"][section].as_object() {
                        for (check, evidence) in checks {
                            if evidence.is_object() && evidence["status"].is_string() {
                                detail.push_str(&format!(
                                    "\n{check}: {} · {}",
                                    evidence["status"].as_str().unwrap(),
                                    evidence["reason"].as_str().unwrap_or("")
                                ));
                            }
                        }
                    }
                }
            }
            rows.push((format!("{:<6} {name}", status.to_uppercase()), detail));
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    if let Some(failures) = value["failures"].as_array() {
        for finding in failures {
            rows.push((
                format!(
                    "ERROR  {}",
                    finding["check"].as_str().unwrap_or("collection")
                ),
                finding["reason"].as_str().unwrap_or("unknown").into(),
            ));
        }
    }
    if rows.is_empty() {
        rows.push((
            "No failed nodes".into(),
            "All selected nodes passed. Press f to see every node.".into(),
        ));
    }
    Ok((summary, rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn failure_view_excludes_passing_nodes_and_preserves_reasons_and_collection_errors() {
        let source = json!({"kind":"krab-cc-conformance","verdict":"error","totalNodes":3,"passedNodes":1,"failedNodes":1,"errorNodes":1,
            "nodes":[{"nodeName":"ready","verdict":"pass","failures":[]},
                {"nodeName":"worker-b","verdict":"fail","failures":[{"check":"tdx","reason":"TDX is disabled"}]},
                {"nodeName":"worker-c","verdict":"error","failures":[{"check":"evidence","reason":"Missing node report"}]}],
            "failures":[{"check":"coverage","reason":"Coverage could not be verified"}]}).to_string();
        let (summary, failed) = report_lines(&source, true).unwrap();
        assert!(summary.contains("1 failed"));
        assert_eq!(failed.len(), 3);
        assert!(!failed.iter().any(|(name, _)| name.contains("ready")));
        assert!(failed
            .iter()
            .any(|(_, reason)| reason.contains("TDX is disabled")));
        assert!(failed
            .iter()
            .any(|(_, reason)| reason.contains("Missing node report")));
        assert_eq!(report_lines(&source, false).unwrap().1.len(), 4);
    }
}
