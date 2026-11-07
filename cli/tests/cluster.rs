use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "krab-cli-cluster-{}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("bin")).unwrap();
        let probe = |status| json!({"status":status,"reason":format!("fixture {status}")});
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let nodes:Vec<_>=["worker-a","worker-b"].iter().map(|name|json!({"nodeName":name,"report":{"kind":"krab-node-precheck","schemaVersion":2,
            "node":{"architecture":"amd64","kernel":"6.12","machineID":format!("machine-{name}"),"bootID":format!("boot-{name}"),"checkerVersion":env!("CARGO_PKG_VERSION"),"checkedAtUnixSeconds":now},
            "checks":{"kvm":probe("yes"),"tdx":probe(if *name=="worker-a" {"yes"}else{"no"}),"snp":probe("no"),"se":probe("no"),"iommufd":probe("yes"),"erofs":probe("no")},
            "gpus":{"present":probe("no"),"nvidia":probe("no"),"cc":probe("no"),"ppcie":probe("no"),"nvswitch":probe("no"),"devices":[]}}})).collect();
        fs::write(root.join("nodes.json"), serde_json::to_vec(&nodes).unwrap()).unwrap();
        fs::write(root.join("kubeconfig"), "fixture").unwrap();
        let fixture = Self(root);
        fixture.script("kubectl",r#"#!/usr/bin/env python3
import json,sys,os
from pathlib import Path
a=sys.argv[1:]
with open('trace','a') as f:f.write(json.dumps(['kubectl',*a])+'\n')
if os.environ.get('FAIL_AUTH'):sys.exit('cluster authentication failed')
if 'current-context' in a: print('test-context');sys.exit()
if 'get-contexts' in a: print('test-context');sys.exit()
nodes=json.loads(Path('nodes.json').read_text())
if 'nodes' in a:
 selector=a[a.index('--selector')+1]
 if 'hostname=host-a' in selector:nodes=nodes[:1]
 print(json.dumps({'kind':'NodeList','items':[{'metadata':{'name':n['nodeName'],'uid':'uid-'+n['nodeName'],'labels':{'kubernetes.io/hostname':'host-a' if n['nodeName']=='worker-a' else 'host-b'}},'status':{'nodeInfo':{'machineID':n['report']['node']['machineID'],'bootID':n['report']['node']['bootID']}}} for n in nodes]}));sys.exit()
if 'logs' in a:
 selector=Path('selected').read_text()
 if 'hostname=host-a' in selector:nodes=nodes[:1]
 print(json.dumps({'kind':'krab-cluster-precheck','schemaVersion':2,'nodes':nodes,'scope':{'nodeSelector':selector+',kubernetes.io/os=linux','nodes':[{'name':n['nodeName'],'uid':'uid-'+n['nodeName'],'machineID':n['report']['node']['machineID'],'bootID':n['report']['node']['bootID']} for n in nodes]}}));sys.exit()
sys.exit('unexpected kubectl command')
"#);
        fixture.script(
            "helm",
            r#"#!/usr/bin/env python3
import sys,json
from pathlib import Path
a=sys.argv[1:]
with open('trace','a') as f:f.write(json.dumps(['helm',*a])+'\n')
if 'version' in a:print('fixture');sys.exit()
v=json.loads(Path(a[a.index('--values')+1]).read_text())
assert v['cache']['forceRefresh']
Path('selected').write_text(v['nodeSelector'])
"#,
        );
        fixture
    }
    fn script(&self, name: &str, text: &str) {
        let path = self.0.join("bin").join(name);
        fs::write(&path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_krab"));
        c.args(args).current_dir(&self.0).env(
            "PATH",
            format!(
                "{}:{}",
                self.0.join("bin").display(),
                std::env::var("PATH").unwrap()
            ),
        );
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn remote_node_precheck_pins_kubeconfig_context_and_resolves_hostname_label() {
    let f = Fixture::new();
    let out = f.run(&[
        "precheck",
        "--node",
        "worker-a",
        "--kubeconfig",
        "kubeconfig",
        "--context",
        "test-context",
        "--output",
        "report.json",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(report["nodes"][0]["nodeName"], "worker-a");
    let trace = fs::read_to_string(f.0.join("trace")).unwrap();
    assert!(trace.contains("hostname=host-a"));
    for line in trace
        .lines()
        .filter(|line| line.contains("upgrade") || line.contains("kubectl"))
    {
        assert!(line.contains("--kubeconfig"));
        assert!(line.contains("kubeconfig"));
    }
    assert!(f.0.join("report.json").exists());
}
#[test]
fn cluster_conformance_lists_only_failed_nodes_and_supports_basic_kvm_policy() {
    let f = Fixture::new();
    let out = f.run(&[
        "conformance",
        "--run",
        "--context",
        "test-context",
        "--kubeconfig",
        "kubeconfig",
        "--require",
        "tdx",
        "--failed-nodes",
    ]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("worker-b: FAIL"));
    assert!(text.contains("tdx"));
    assert!(!text.contains("worker-a: PASS"));
    assert!(f
        .run(&["conformance", "--run", "--require", "kvm"])
        .status
        .success());
}
#[test]
fn unusable_credentials_and_missing_nodes_do_not_install_any_chart() {
    let f = Fixture::new();
    let out = f
        .command(&["precheck", "--node", "worker-a"])
        .env("FAIL_AUTH", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let out = f.run(&["precheck", "--node", "missing", "--context", "test-context"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("was not found"));
    assert!(!fs::read_to_string(f.0.join("trace"))
        .unwrap()
        .contains("upgrade"));
}
