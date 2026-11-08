//! Versioned pre-check evidence consumed by conformance.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClusterReport {
    pub kind: ClusterKind,
    pub schema_version: u32,
    pub nodes: Vec<NodeEntry>,
    pub scope: Scope,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum ClusterKind {
    #[serde(rename = "krab-cluster-precheck")]
    Precheck,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeEntry {
    pub node_name: String,
    pub report: NodeReport,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeReport {
    pub kind: NodeKind,
    pub schema_version: u32,
    pub node: Host,
    pub checks: Checks,
    pub gpus: Gpus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub erofs_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Runtime>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum NodeKind {
    #[serde(rename = "krab-node-precheck")]
    Precheck,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Host {
    pub architecture: String,
    pub kernel: String,
    #[serde(rename = "machineID")]
    pub machine_id: String,
    #[serde(rename = "bootID")]
    pub boot_id: String,
    #[serde(rename = "checkerVersion")]
    pub checker_version: String,
    #[serde(rename = "checkedAtUnixSeconds")]
    pub checked_at_unix_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Checks {
    pub kvm: Probe,
    pub tdx: Probe,
    pub snp: Probe,
    pub se: Probe,
    pub iommufd: Probe,
    pub erofs: Probe,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub status: Status,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Yes,
    No,
    Unknown,
    Review,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Gpus {
    pub present: Probe,
    pub nvidia: Probe,
    pub cc: Probe,
    pub ppcie: Probe,
    pub nvswitch: Probe,
    pub devices: Vec<Device>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub pci_bus_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chip: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Runtime {
    pub detected: Vec<String>,
    pub layout: Probe,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub node_selector: String,
    pub nodes: Vec<Identity>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub name: String,
    pub uid: String,
    #[serde(rename = "machineID")]
    pub machine_id: String,
    #[serde(rename = "bootID")]
    pub boot_id: String,
}

pub fn parse(text: &str) -> Result<ClusterReport, String> {
    let report: ClusterReport = serde_json::from_str(text)
        .map_err(|error| format!("Invalid cluster pre-check report: {error}"))?;
    if report.schema_version != 2 || report.nodes.is_empty() {
        return Err("Cluster pre-check report must have schemaVersion 2 and at least one node; rerun pre-flight with this checker".into());
    }
    let mut names = BTreeSet::new();
    if report.scope.node_selector.trim().is_empty() {
        return Err("Cluster pre-check report has no selected node scope".into());
    }
    validate_identities(&report.scope.nodes)?;
    for entry in &report.nodes {
        if entry.node_name.trim().is_empty() || !names.insert(&entry.node_name) {
            return Err("Cluster pre-check report has an empty or duplicate node name".into());
        }
        if entry.report.schema_version != 2 {
            return Err(format!(
                "Unsupported node report version for {}",
                entry.node_name
            ));
        }
        if entry.report.node.machine_id.trim().is_empty()
            || entry.report.node.boot_id.trim().is_empty()
            || entry.report.node.checker_version.trim().is_empty()
            || entry.report.node.checked_at_unix_seconds == 0
        {
            return Err(format!(
                "Incomplete v2 host evidence for {}",
                entry.node_name
            ));
        }
    }
    Ok(report)
}

pub fn validate_identities(nodes: &[Identity]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    let mut uids = BTreeSet::new();
    if nodes.is_empty() {
        return Err("Node inventory is empty".into());
    }
    for node in nodes {
        if node.name.trim().is_empty()
            || node.uid.trim().is_empty()
            || node.machine_id.trim().is_empty()
            || node.boot_id.trim().is_empty()
            || !names.insert(&node.name)
            || !uids.insert(&node.uid)
        {
            return Err("Node inventory has missing identities or duplicate nodes".into());
        }
    }
    Ok(())
}

pub fn inventory(text: &str) -> Result<Vec<Identity>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("Invalid node inventory: {error}"))?;
    if value["kind"] != "NodeList" && value["kind"] != "List" {
        return Err("Node inventory must be kubectl get nodes -o json output".into());
    }
    let items = value["items"]
        .as_array()
        .ok_or("Node inventory has no items")?;
    let mut nodes = Vec::new();
    for item in items {
        let field = |path: &str| {
            item.pointer(path)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned()
        };
        nodes.push(Identity {
            name: field("/metadata/name"),
            uid: field("/metadata/uid"),
            machine_id: field("/status/nodeInfo/machineID"),
            boot_id: field("/status/nodeInfo/bootID"),
        });
    }
    validate_identities(&nodes)?;
    nodes.sort();
    Ok(nodes)
}
