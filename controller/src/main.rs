use anyhow::{bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, fs, time::Duration};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    id: String,
    component: String,
    revision: String,
    template: Value,
    labels: BTreeMap<String, String>,
    selectors: Vec<String>,
    nodes: Vec<String>,
    handlers: Vec<String>,
    pending_label: Option<String>,
    pending_value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    version: u32,
    stages: Vec<Stage>,
    parallelism: usize,
    guard_image: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeState {
    identity: [String; 2],
    plan_revision: String,
    blocked: String,
    stages: BTreeMap<String, StageState>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageState {
    revision: String,
    phase: String,
    job: String,
    error: Option<String>,
    verification_started: Option<i64>,
}

type State = BTreeMap<String, NodeState>;

struct Api {
    client: Client,
    base: String,
    token_path: String,
}

impl Api {
    fn in_cluster() -> Result<Self> {
        let credentials = "/var/run/secrets/kubernetes.io/serviceaccount";
        let ca = reqwest::Certificate::from_pem(&fs::read(format!("{credentials}/ca.crt"))?)?;
        let host = env::var("KUBERNETES_SERVICE_HOST")?;
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        Ok(Self {
            client: Client::builder()
                .add_root_certificate(ca)
                .timeout(Duration::from_secs(10))
                .build()?,
            base: format!(
                "https://{host}:{}",
                env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".into())
            ),
            token_path: format!("{credentials}/token"),
        })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        patch: bool,
    ) -> Result<(StatusCode, Value)> {
        // Projected tokens rotate; never keep a token in the client configuration.
        let token = fs::read_to_string(&self.token_path)?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token.trim());
        if let Some(body) = body {
            request = request.json(body);
        }
        if patch {
            request = request.header("Content-Type", "application/json-patch+json");
        }
        let response = request.send().await?;
        let status = response.status();
        let value = response.json().await?;
        Ok((status, value))
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        patch: bool,
    ) -> Result<Value> {
        let (status, value) = self.request(method, path, body, patch).await?;
        ensure!(status.is_success(), "Kubernetes {path}: {status}: {value}");
        Ok(value)
    }

    async fn list(&self, path: &str, selectors: &[(&str, &str)]) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut token = String::new();
        loop {
            let mut url = reqwest::Url::parse(&format!("{}{path}", self.base))?;
            url.query_pairs_mut()
                .append_pair("limit", "500")
                .extend_pairs(selectors.iter().copied());
            if !token.is_empty() {
                url.query_pairs_mut().append_pair("continue", &token);
            }
            let path = format!("{}?{}", url.path(), url.query().unwrap_or_default());
            let page = self.call(Method::GET, &path, None, false).await?;
            items.extend(array(&page["items"]).iter().cloned());
            token = text(&page["metadata"]["continue"]).to_owned();
            if token.is_empty() {
                return Ok(items);
            }
        }
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn identity(node: &Value) -> [String; 2] {
    [
        text(&node["metadata"]["uid"]).into(),
        text(&node["status"]["nodeInfo"]["machineID"]).into(),
    ]
}
fn ready(node: &Value, handlers: &[String]) -> bool {
    array(&node["status"]["conditions"])
        .iter()
        .any(|c| c["type"] == "Ready" && c["status"] == "True")
        && (handlers.is_empty()
            || array(&node["status"]["runtimeHandlers"])
                .iter()
                .any(|h| handlers.iter().any(|name| h["name"] == *name)))
}
fn condition(job: &Value, kind: &str) -> Option<String> {
    array(&job["status"]["conditions"])
        .iter()
        .find(|c| c["type"] == kind && c["status"] == "True")
        .map(|c| {
            c["message"]
                .as_str()
                .or(c["reason"].as_str())
                .unwrap_or(kind)
                .to_owned()
        })
}
fn admitted(node: &Value, pod: &Value) -> bool {
    if let Some(selector) = pod["nodeSelector"].as_object() {
        if selector
            .iter()
            .any(|(key, value)| node["metadata"]["labels"][key] != *value)
        {
            return false;
        }
    }
    array(&node["spec"]["taints"])
        .iter()
        .filter(|t| t["effect"] == "NoSchedule" || t["effect"] == "NoExecute")
        .all(|taint| {
            array(&pod["tolerations"]).iter().any(|t| {
                (text(&t["effect"]).is_empty() || t["effect"] == taint["effect"])
                    && (t["key"] == taint["key"]
                        || (text(&t["key"]).is_empty() && t["operator"] == "Exists"))
                    && (t["operator"] == "Exists" || text(&t["value"]) == text(&taint["value"]))
                    && (taint["effect"] != "NoExecute" || t["tolerationSeconds"].is_null())
            })
        })
}

fn job_for(
    stage: &Stage,
    node: &Value,
    name: &str,
    controller: &str,
    image: &str,
) -> Result<Value> {
    let mut job = stage.template.clone();
    job["metadata"] = json!({"name": name, "labels": {"krab.io/controller": controller}});
    job["spec"]["ttlSecondsAfterFinished"] = json!(3600);
    let pod = &mut job["spec"]["template"]["spec"];
    pod["nodeName"] = node["metadata"]["name"].clone();
    pod["automountServiceAccountToken"] = json!(false);
    pod["serviceAccountName"] = json!(format!("{controller}-worker"));
    for kind in ["containers", "initContainers"] {
        if let Some(containers) = pod[kind].as_array_mut() {
            for container in containers {
                let mut env = array(&container["env"]).to_vec();
                env.retain(|e| {
                    e["name"] != "NODE_MACHINE_ID" && e["name"] != "CONTAINER_RUNTIME_VERSION"
                });
                env.push(json!({"name": "NODE_MACHINE_ID", "value": node["status"]["nodeInfo"]["machineID"]}));
                env.push(json!({"name": "CONTAINER_RUNTIME_VERSION", "value": node["status"]["nodeInfo"]["containerRuntimeVersion"]}));
                container["env"] = json!(env);
            }
        }
    }
    let mut volumes = array(&pod["volumes"]).to_vec();
    ensure!(
        !volumes.iter().any(|v| v["name"] == "krab-machine-identity"),
        "Reserved identity volume in installer"
    );
    volumes.push(json!({"name": "krab-machine-identity", "hostPath": {"path": "/etc/machine-id", "type": "File"}}));
    pod["volumes"] = json!(volumes);
    let mut init = vec![json!({
        "name": "krab-check-machine", "image": image,
        "command": ["/usr/local/bin/krab-controller", "check-machine", text(&node["status"]["nodeInfo"]["machineID"])],
        "volumeMounts": [{"name": "krab-machine-identity", "mountPath": "/host-machine-id", "readOnly": true}],
        "securityContext": {"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532,
            "readOnlyRootFilesystem": true, "allowPrivilegeEscalation": false,
            "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}}
    })];
    init.extend(array(&pod["initContainers"]).iter().cloned());
    pod["initContainers"] = json!(init);
    if !stage.nodes.is_empty() {
        pod["tolerations"] = json!([{"operator": "Exists"}]);
    }
    Ok(job)
}

struct Controller {
    api: Api,
    plan: Plan,
    name: String,
    holder: String,
    jobs_path: String,
    state_path: String,
    lease_path: String,
    plan_revision: String,
}

impl Controller {
    async fn lead(&self) -> Result<bool> {
        let mut lease = self
            .api
            .call(Method::GET, &self.lease_path, None, false)
            .await?;
        let spec = &lease["spec"];
        let expired = DateTime::parse_from_rfc3339(text(&spec["renewTime"]))
            .map(|t| (Utc::now() - t.with_timezone(&Utc)).num_seconds() > 60)
            .unwrap_or(true);
        if !text(&spec["holderIdentity"]).is_empty()
            && spec["holderIdentity"] != self.holder
            && !expired
        {
            return Ok(false);
        }
        lease["spec"] = json!({"holderIdentity": self.holder, "leaseDurationSeconds": 60, "renewTime": Utc::now().to_rfc3339()});
        let (status, value) = self
            .api
            .request(Method::PUT, &self.lease_path, Some(&lease), false)
            .await?;
        if status == StatusCode::CONFLICT {
            return Ok(false);
        }
        ensure!(
            status.is_success(),
            "Lease renewal failed: {status}: {value}"
        );
        Ok(true)
    }

    async fn save(&self, state: &State, config: &mut Value) -> Result<()> {
        let encoded = serde_json::to_string(state)?;
        ensure!(
            encoded.len() <= 700_000,
            "Prototype state capacity exceeded; refusing more work"
        );
        if config["data"].is_null() {
            config["data"] = json!({});
        }
        config["data"]["state.json"] = json!(encoded);
        *config = self
            .api
            .call(Method::PUT, &self.state_path, Some(config), false)
            .await?;
        Ok(())
    }

    async fn labels(&self, node: &Value, labels: &BTreeMap<String, String>) -> Result<()> {
        if labels.is_empty() {
            return Ok(());
        }
        ensure!(self.lead().await?, "Lost leadership before Node patch");
        let mut ops = vec![
            json!({"op": "test", "path": "/metadata/uid", "value": node["metadata"]["uid"]}),
            json!({"op": "test", "path": "/status/nodeInfo/machineID", "value": node["status"]["nodeInfo"]["machineID"]}),
        ];
        if node["metadata"]["labels"].is_null() {
            ops.push(json!({"op": "add", "path": "/metadata/labels", "value": {}}));
        }
        for (key, value) in labels {
            ops.push(json!({"op": "add", "path": format!("/metadata/labels/{}", key.replace('~', "~0").replace('/', "~1")), "value": value}));
        }
        self.api
            .call(
                Method::PATCH,
                &format!("/api/v1/nodes/{}", text(&node["metadata"]["name"])),
                Some(&json!(ops)),
                true,
            )
            .await?;
        Ok(())
    }

    async fn tick(&self) -> Result<()> {
        if !self.lead().await? {
            return Ok(());
        }
        let mut config = self
            .api
            .call(Method::GET, &self.state_path, None, false)
            .await?;
        let mut state: State =
            serde_json::from_str(config["data"]["state.json"].as_str().unwrap_or("{}"))?;
        let selector = format!("krab.io/controller={}", self.name);
        let jobs: BTreeMap<String, Value> = self
            .api
            .list(&self.jobs_path, &[("labelSelector", &selector)])
            .await?
            .into_iter()
            .map(|j| (text(&j["metadata"]["name"]).to_owned(), j))
            .collect();
        let mut running = jobs
            .values()
            .filter(|j| condition(j, "Complete").is_none() && condition(j, "Failed").is_none())
            .count();
        let mut selected: BTreeMap<String, (Value, Vec<&Stage>)> = BTreeMap::new();
        for stage in &self.plan.stages {
            let mut nodes = Vec::new();
            if stage.nodes.is_empty() {
                for selector in &stage.selectors {
                    nodes.extend(
                        self.api
                            .list("/api/v1/nodes", &[("labelSelector", selector)])
                            .await?,
                    );
                }
            } else {
                for name in &stage.nodes {
                    let (status, node) = self
                        .api
                        .request(Method::GET, &format!("/api/v1/nodes/{name}"), None, false)
                        .await?;
                    if status == StatusCode::NOT_FOUND {
                        continue;
                    }
                    ensure!(status.is_success(), "Node read failed: {status}");
                    nodes.push(node);
                }
            }
            for node in nodes {
                let selection = selected
                    .entry(text(&node["metadata"]["name"]).to_owned())
                    .or_insert_with(|| (node, Vec::new()));
                if !selection.1.iter().any(|s| s.id == stage.id) {
                    selection.1.push(stage);
                }
            }
        }
        for (name, (snapshot, stages)) in selected {
            ensure!(self.lead().await?, "Lost leadership");
            let id = identity(&snapshot);
            if id.iter().any(String::is_empty)
                || text(&snapshot["status"]["nodeInfo"]["containerRuntimeVersion"]).is_empty()
                || snapshot["metadata"]["labels"]["kubernetes.io/os"] != "linux"
            {
                continue;
            }
            if state.get(&name).map(|s| s.identity != id).unwrap_or(true) {
                let existing = stages.iter().any(|s| {
                    s.labels
                        .iter()
                        .any(|(k, v)| snapshot["metadata"]["labels"][k] == *v)
                });
                state.insert(
                    name.clone(),
                    NodeState {
                        identity: id.clone(),
                        plan_revision: self.plan_revision.clone(),
                        blocked: if existing {
                            "Existing installation requires explicit adoption".into()
                        } else {
                            String::new()
                        },
                        ..Default::default()
                    },
                );
                self.save(&state, &mut config).await?;
            }
            let record = state.get_mut(&name).context("Missing node state")?;
            if record.plan_revision != self.plan_revision {
                record.blocked =
                    "Configuration changed; existing-node rollout is not supported".into();
            }
            if stages
                .iter()
                .filter(|s| s.component == "kata-device-provisioner")
                .count()
                > 1
            {
                record.blocked = "Multiple GPU provisioning profiles match this node".into();
            }
            if !record.blocked.is_empty() {
                self.save(&state, &mut config).await?;
                continue;
            }
            for stage in stages {
                if let Some(entry) = state[&name].stages.get(&stage.id) {
                    if entry.revision != stage.revision {
                        bail!("Stage revision changed unexpectedly");
                    }
                    if entry.phase == "succeeded" {
                        if ready(&snapshot, &stage.handlers)
                            && stage
                                .labels
                                .iter()
                                .any(|(k, v)| snapshot["metadata"]["labels"][k] != *v)
                        {
                            self.labels(&snapshot, &stage.labels).await?;
                        }
                        continue;
                    }
                    if entry.phase == "failed" {
                        break;
                    }
                    if let Some(job) = jobs.get(&entry.job) {
                        let mut phase = None;
                        let mut error = None;
                        if let Some(reason) = condition(job, "Failed") {
                            phase = Some("failed");
                            error = Some(reason);
                        } else if condition(job, "Complete").is_some() {
                            let current = self
                                .api
                                .call(Method::GET, &format!("/api/v1/nodes/{name}"), None, false)
                                .await?;
                            if identity(&current) == id && ready(&current, &stage.handlers) {
                                self.labels(&current, &stage.labels).await?;
                                phase = Some("succeeded");
                            } else {
                                phase = Some("verifying");
                            }
                        }
                        let entry = state
                            .get_mut(&name)
                            .unwrap()
                            .stages
                            .get_mut(&stage.id)
                            .unwrap();
                        if let Some(phase) = phase {
                            entry.phase = phase.into();
                        }
                        if entry.phase == "verifying" {
                            let started = entry
                                .verification_started
                                .get_or_insert(Utc::now().timestamp());
                            if Utc::now().timestamp() - *started > 600 {
                                entry.phase = "failed".into();
                                error = Some("Node readiness or runtime handlers did not verify within 600 seconds".into());
                            }
                        }
                        entry.error = error;
                        self.save(&state, &mut config).await?;
                        break;
                    }
                    {
                        let entry = state
                            .get_mut(&name)
                            .unwrap()
                            .stages
                            .get_mut(&stage.id)
                            .unwrap();
                        entry.phase = "failed".into();
                        entry.error =
                            Some("Installer Job disappeared before its result was recorded".into());
                        self.save(&state, &mut config).await?;
                        break;
                    }
                }
                if running >= self.plan.parallelism
                    || jobs.values().any(|j| {
                        j["spec"]["template"]["spec"]["nodeName"] == name
                            && condition(j, "Complete").is_none()
                            && condition(j, "Failed").is_none()
                    })
                {
                    break;
                }
                let current = self
                    .api
                    .call(Method::GET, &format!("/api/v1/nodes/{name}"), None, false)
                    .await?;
                if identity(&current) != id || !ready(&current, &[]) {
                    break;
                }
                if stage.nodes.is_empty() {
                    if !admitted(&current, &stage.template["spec"]["template"]["spec"]) {
                        break;
                    }
                    let field = format!("metadata.name={name}");
                    let mut matched = false;
                    for selector in &stage.selectors {
                        if !self
                            .api
                            .list(
                                "/api/v1/nodes",
                                &[("labelSelector", selector), ("fieldSelector", &field)],
                            )
                            .await?
                            .is_empty()
                        {
                            matched = true;
                        }
                    }
                    if !matched {
                        break;
                    }
                }
                let digest = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&json!([
                        self.name,
                        id,
                        stage.id,
                        stage.revision
                    ]))?)
                );
                let job_name = format!("krab-{}", &digest[..32]);
                state
                    .get_mut(&name)
                    .unwrap()
                    .stages
                    .entry(stage.id.clone())
                    .or_insert_with(|| StageState {
                        revision: stage.revision.clone(),
                        phase: "prepared".into(),
                        job: job_name.clone(),
                        error: None,
                        verification_started: None,
                    });
                self.save(&state, &mut config).await?;
                if let Some(key) = &stage.pending_label {
                    self.labels(
                        &current,
                        &BTreeMap::from([(key.clone(), stage.pending_value.clone())]),
                    )
                    .await?;
                }
                let job = job_for(
                    stage,
                    &current,
                    &job_name,
                    &self.name,
                    &self.plan.guard_image,
                )?;
                ensure!(self.lead().await?, "Lost leadership before Job creation");
                let (status, response) = self
                    .api
                    .request(Method::POST, &self.jobs_path, Some(&job), false)
                    .await?;
                if status == StatusCode::CONFLICT {
                    let existing = self
                        .api
                        .call(
                            Method::GET,
                            &format!("{}/{job_name}", self.jobs_path),
                            None,
                            false,
                        )
                        .await?;
                    ensure!(
                        existing["metadata"]["labels"]["krab.io/controller"] == self.name
                            && existing["spec"]["template"]["spec"]["nodeName"] == name,
                        "Job identity collision"
                    );
                } else {
                    ensure!(
                        status.is_success(),
                        "Job creation failed: {status}: {response}"
                    );
                }
                state
                    .get_mut(&name)
                    .unwrap()
                    .stages
                    .get_mut(&stage.id)
                    .unwrap()
                    .phase = "running".into();
                self.save(&state, &mut config).await?;
                running += 1;
                println!(
                    "{}",
                    json!({"node": name, "stage": stage.id, "job": job_name})
                );
                break;
            }
        }
        Ok(())
    }
}

fn check_machine(path: &str, expected: &str) -> Result<()> {
    let actual = fs::read_to_string(path)?;
    ensure!(
        !expected.is_empty() && actual.trim() == expected,
        "Host machine identity changed"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("check-machine") {
        return check_machine(
            "/host-machine-id",
            args.get(1).context("Expected machine ID")?,
        );
    }
    let flag = |name: &str| -> Result<String> {
        args.iter()
            .find_map(|a| a.strip_prefix(name).map(str::to_owned))
            .with_context(|| format!("Missing {name}"))
    };
    let plan: Plan = serde_json::from_slice(&fs::read(flag("--plan=")?)?)?;
    ensure!(
        plan.version == 1 && !plan.stages.is_empty() && (1..=100).contains(&plan.parallelism),
        "Invalid v1 plan"
    );
    let name = flag("--name=")?;
    let namespace = env::var("POD_NAMESPACE")?;
    let revision = format!("{:x}", Sha256::digest(serde_json::to_vec(&plan.stages)?));
    let controller = Controller {
        api: Api::in_cluster()?,
        plan,
        holder: env::var("POD_UID")?,
        jobs_path: format!("/apis/batch/v1/namespaces/{namespace}/jobs"),
        state_path: format!("/api/v1/namespaces/{namespace}/configmaps/{name}-state"),
        lease_path: format!(
            "/apis/coordination.k8s.io/v1/namespaces/{namespace}/leases/{name}-leader"
        ),
        name,
        plan_revision: revision,
    };
    loop {
        if let Err(error) = controller.tick().await {
            eprintln!("{}", json!({"error": format!("{error:#}")}));
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    fn node() -> Value {
        json!({"metadata": {"name": "worker", "uid": "node-uid", "labels": {"kubernetes.io/os": "linux"}},
            "status": {"nodeInfo": {"machineID": "machine-a", "containerRuntimeVersion": "containerd://2.0"},
                "conditions": [{"type": "Ready", "status": "True"}], "runtimeHandlers": [{"name": "kata-qemu"}]}})
    }
    fn stage() -> Stage {
        serde_json::from_value(json!({"id": "kata-install", "component": "kata-deploy", "revision": "v1",
            "selectors": [""], "nodes": [], "handlers": ["kata-qemu"], "pendingLabel": null, "pendingValue": "false",
            "labels": {"katacontainers.io/kata-runtime": "true"},
            "template": {"apiVersion": "batch/v1", "kind": "Job", "spec": {"backoffLimit": 0,
                "template": {"spec": {"automountServiceAccountToken": false, "restartPolicy": "Never",
                    "containers": [{"name": "install", "image": "installer:test"}]}}}}})).unwrap()
    }

    #[test]
    fn scheduling_and_readiness_fail_closed() {
        let mut n = node();
        n["spec"] =
            json!({"taints": [{"key": "dedicated", "value": "gpu", "effect": "NoSchedule"}]});
        assert!(!admitted(&n, &json!({})));
        assert!(admitted(
            &n,
            &json!({"tolerations": [{"key": "dedicated", "operator": "Equal", "value": "gpu"}]})
        ));
        n["status"]["runtimeHandlers"] = json!([]);
        assert!(!ready(&n, &["kata-qemu".into()]));
        assert!(ready(&n, &[]));
        n["status"]["conditions"][0]["status"] = json!("False");
        assert!(!ready(&n, &[]));
    }

    #[test]
    fn host_guard_precedes_all_mutating_stages_and_overrides_identity() {
        let mut s = stage();
        s.template["spec"]["template"]["spec"]["initContainers"] = json!([{"name": "mutate", "image": "installer:test",
            "env": [{"name": "NODE_MACHINE_ID", "value": "spoofed"}]}]);
        let job = job_for(
            &s,
            &node(),
            "install-worker",
            "krab-controller",
            "controller:test",
        )
        .unwrap();
        let pod = &job["spec"]["template"]["spec"];
        assert_eq!(pod["initContainers"][0]["name"], "krab-check-machine");
        assert_eq!(pod["initContainers"][1]["env"][0]["value"], "machine-a");
        assert_eq!(pod["automountServiceAccountToken"], false);
        assert_eq!(pod["nodeName"], "worker");
        assert_eq!(pod["serviceAccountName"], "krab-controller-worker");
    }

    #[derive(Default)]
    struct Fake {
        node: Value,
        jobs: Vec<Value>,
        config: Value,
        lease: Value,
        requests: Vec<(String, String)>,
    }
    // Real HTTP requests exercise serialization, durable recovery and the exact
    // endpoints used by the controller without a cluster or host mutations.
    fn controller() -> (Controller, Arc<Mutex<Fake>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let data = Arc::new(Mutex::new(Fake {
            node: node(),
            config: json!({"metadata": {"name": "krab-controller-state", "resourceVersion": "1"}, "data": {}}),
            lease: json!({"metadata": {"resourceVersion": "1"}, "spec": {}}),
            ..Default::default()
        }));
        let weak = Arc::downgrade(&data);
        std::thread::spawn(move || {
            while let Some(data) = weak.upgrade() {
                let (mut socket, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(_) => {
                        drop(data);
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let header_end;
                loop {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(offset) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        header_end = offset + 4;
                        break;
                    }
                }
                let header = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                let length = header
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let count = socket.read(&mut buffer).unwrap();
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let parts: Vec<_> = header.lines().next().unwrap().split_whitespace().collect();
                let (method, path) = (parts[0], parts[1]);
                let body: Value = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
                };
                let mut data = data.lock().unwrap();
                data.requests.push((method.into(), path.into()));
                let response = if path.contains("/leases/") {
                    if method == "PUT" {
                        data.lease = body;
                    }
                    data.lease.clone()
                } else if path.contains("/configmaps/") {
                    if method == "PUT" {
                        data.config = body;
                    }
                    data.config.clone()
                } else if path.starts_with("/api/v1/nodes") {
                    if method == "PATCH" {
                        for op in array(&body) {
                            if op["op"] == "add"
                                && text(&op["path"]).starts_with("/metadata/labels/")
                            {
                                let key = text(&op["path"])[17..]
                                    .replace("~1", "/")
                                    .replace("~0", "~");
                                data.node["metadata"]["labels"][key] = op["value"].clone();
                            }
                        }
                    }
                    if path.starts_with("/api/v1/nodes?") {
                        json!({"items": [data.node], "metadata": {}})
                    } else {
                        data.node.clone()
                    }
                } else if path.contains("/jobs") {
                    if method == "POST" {
                        data.jobs.push(body.clone());
                        body
                    } else {
                        json!({"items": data.jobs, "metadata": {}})
                    }
                } else {
                    panic!("Unexpected endpoint {method} {path}");
                };
                let encoded = serde_json::to_string(&response).unwrap();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", encoded.len(), encoded).unwrap();
            }
        });
        let token_path = format!(
            "/tmp/krab-controller-token-{}",
            base.rsplit(':').next().unwrap()
        );
        fs::write(&token_path, "test-token").unwrap();
        let c = Controller {
            api: Api {
                client: Client::new(),
                base,
                token_path,
            },
            plan: Plan {
                version: 1,
                stages: vec![stage()],
                parallelism: 2,
                guard_image: "controller:test".into(),
            },
            name: "krab-controller".into(),
            holder: "pod-uid".into(),
            plan_revision: "plan-v1".into(),
            jobs_path: "/apis/batch/v1/namespaces/kata-system/jobs".into(),
            state_path: "/api/v1/namespaces/kata-system/configmaps/krab-controller-state".into(),
            lease_path:
                "/apis/coordination.k8s.io/v1/namespaces/kata-system/leases/krab-controller-leader"
                    .into(),
        };
        (c, data)
    }

    #[tokio::test]
    async fn onboarding_recovers_intent_and_retains_success_after_job_ttl() {
        let (c, data) = controller();
        c.tick().await.unwrap();
        assert_eq!(data.lock().unwrap().jobs.len(), 1);
        // Simulate a crash after Job create, before persisting running phase.
        {
            let mut d = data.lock().unwrap();
            let mut state: Value =
                serde_json::from_str(text(&d.config["data"]["state.json"])).unwrap();
            state["worker"]["stages"]["kata-install"]["phase"] = json!("prepared");
            d.config["data"]["state.json"] = json!(serde_json::to_string(&state).unwrap());
            d.jobs[0]["status"] = json!({"conditions": [{"type": "Complete", "status": "True"}]});
        }
        c.tick().await.unwrap();
        {
            let mut d = data.lock().unwrap();
            let state: Value = serde_json::from_str(text(&d.config["data"]["state.json"])).unwrap();
            assert_eq!(
                state["worker"]["stages"]["kata-install"]["phase"],
                "succeeded"
            );
            assert_eq!(
                d.node["metadata"]["labels"]["katacontainers.io/kata-runtime"],
                "true"
            );
            d.jobs.clear();
        }
        c.tick().await.unwrap();
        assert!(data.lock().unwrap().jobs.is_empty());
    }

    #[tokio::test]
    async fn changed_plan_and_missing_jobs_halt_without_reinstalling() {
        let (mut c, data) = controller();
        c.tick().await.unwrap();
        data.lock().unwrap().jobs.clear();
        c.tick().await.unwrap();
        let state: Value =
            serde_json::from_str(text(&data.lock().unwrap().config["data"]["state.json"])).unwrap();
        assert_eq!(state["worker"]["stages"]["kata-install"]["phase"], "failed");
        c.plan_revision = "plan-v2".into();
        c.tick().await.unwrap();
        let state: Value =
            serde_json::from_str(text(&data.lock().unwrap().config["data"]["state.json"])).unwrap();
        assert!(text(&state["worker"]["blocked"]).contains("Configuration changed"));
        assert!(data.lock().unwrap().jobs.is_empty());
    }

    #[tokio::test]
    async fn overlapping_gpu_profiles_and_existing_installations_do_not_run() {
        let (mut c, data) = controller();
        c.plan.stages[0].component = "kata-device-provisioner".into();
        let mut other = c.plan.stages[0].clone();
        other.id = "gpu-other".into();
        c.plan.stages.push(other);
        c.tick().await.unwrap();
        assert!(data.lock().unwrap().jobs.is_empty());
        let (c, data) = controller();
        data.lock().unwrap().node["metadata"]["labels"]["katacontainers.io/kata-runtime"] =
            json!("true");
        c.tick().await.unwrap();
        assert!(data.lock().unwrap().jobs.is_empty());
    }

    #[tokio::test]
    async fn live_leader_prevents_competing_controller() {
        let (c, data) = controller();
        data.lock().unwrap().lease["spec"] =
            json!({"holderIdentity": "other-pod", "renewTime": Utc::now().to_rfc3339()});
        c.tick().await.unwrap();
        assert_eq!(data.lock().unwrap().requests.len(), 1);
        assert!(data.lock().unwrap().jobs.is_empty());
    }

    #[tokio::test]
    async fn ambiguous_submission_does_not_repeat_a_host_operation() {
        let (c, data) = controller();
        c.tick().await.unwrap();
        {
            let mut d = data.lock().unwrap();
            d.jobs.clear();
            let mut state: Value =
                serde_json::from_str(text(&d.config["data"]["state.json"])).unwrap();
            state["worker"]["stages"]["kata-install"]["phase"] = json!("prepared");
            d.config["data"]["state.json"] = json!(serde_json::to_string(&state).unwrap());
        }
        c.tick().await.unwrap();
        assert!(data.lock().unwrap().jobs.is_empty());
        let state: Value =
            serde_json::from_str(text(&data.lock().unwrap().config["data"]["state.json"])).unwrap();
        assert_eq!(state["worker"]["stages"]["kata-install"]["phase"], "failed");
    }

    #[tokio::test]
    async fn bounded_parallelism_and_one_stage_per_node() {
        let (mut c, data) = controller();
        let mut second = stage();
        second.id = "later-stage".into();
        c.plan.stages.push(second);
        c.tick().await.unwrap();
        c.tick().await.unwrap();
        assert_eq!(data.lock().unwrap().jobs.len(), 1);
    }

    #[tokio::test]
    async fn reused_node_name_does_not_overlap_an_old_installer() {
        let (c, data) = controller();
        c.tick().await.unwrap();
        {
            let mut d = data.lock().unwrap();
            d.node["metadata"]["uid"] = json!("replacement-uid");
            d.node["status"]["nodeInfo"]["machineID"] = json!("machine-b");
        }
        c.tick().await.unwrap();
        assert_eq!(data.lock().unwrap().jobs.len(), 1);
        {
            let mut d = data.lock().unwrap();
            d.jobs[0]["status"] = json!({"conditions": [{"type": "Failed", "status": "True"}]});
        }
        c.tick().await.unwrap();
        let d = data.lock().unwrap();
        assert_eq!(d.jobs.len(), 2);
        assert_ne!(d.jobs[0]["metadata"]["name"], d.jobs[1]["metadata"]["name"]);
        assert_eq!(
            d.jobs[1]["spec"]["template"]["spec"]["initContainers"][0]["command"][2],
            "machine-b"
        );
    }
}
