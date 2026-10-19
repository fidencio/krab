use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("krab-conformance-{}-{unique}", std::process::id()));
        fs::create_dir_all(root.join("bin")).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, value: &Value) {
        fs::write(self.0.join(name), serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_krab-preflight"))
            .arg("conformance")
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
    fn offline(&self, report: &Value, requirements: &[&str]) -> (Output, Value) {
        self.write("report.json", report);
        let mut args = vec!["--report", "report.json", "--json"];
        for requirement in requirements {
            args.extend(["--require", requirement]);
        }
        let output = self.run(&args);
        let verdict = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
        (output, verdict)
    }
    fn script(&self, name: &str, text: &str) {
        let path = self.0.join("bin").join(name);
        fs::write(&path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn live(&self, report: &Value, reboot: bool, helm_fails: bool) -> (Output, Value) {
        self.write("live-report.json", report);
        let inventory = json!({"kind":"NodeList", "items": report["scope"]["nodes"].as_array().unwrap().iter().map(|identity| json!({
            "metadata":{"name":identity["name"],"uid":identity["uid"]},
            "status":{"nodeInfo":{"machineID":identity["machineID"],"bootID":identity["bootID"]}}
        })).collect::<Vec<_>>()});
        self.write("inventory.json", &inventory);
        self.script("kubectl", "#!/bin/sh\nset -eu\nprintf 'kubectl %s\\n' \"$*\" >> trace\ncase \"$*\" in\n  'config current-context') echo test-context ;;\n  *' get nodes '*)\n    if test \"$REBOOT\" = true && test -f listed; then sed 's/boot-worker-a/rebooted/g' inventory.json; else cat inventory.json; fi\n    touch listed ;;\n  *' logs '*) cat live-report.json ;;\n  *) echo 'unexpected kubectl invocation' >&2; exit 1 ;;\nesac\n");
        self.script("helm", "#!/bin/sh\nset -eu\nprintf 'helm %s\\n' \"$*\" >> trace\nif test \"$HELM_FAILS\" = true; then echo 'probe Job failed' >&2; exit 1; fi\ncopy=false\nfor arg in \"$@\"; do\n if test \"$copy\" = true; then cp \"$arg\" values.json; copy=false; fi\n if test \"$arg\" = --values; then copy=true; fi\ndone\necho 'Helm progress should never appear in the JSON verdict'\n");
        let output = Command::new(env!("CARGO_BIN_EXE_krab-preflight"))
            .args([
                "conformance",
                "--run",
                "--require",
                "tdx",
                "--json",
                "--chart",
                "/local/chart",
                "--node-selector",
                "pool=cc,zone in (a,b)",
                "--output",
                "verdict.json",
            ])
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    self.0.join("bin").display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("REBOOT", if reboot { "true" } else { "false" })
            .env("HELM_FAILS", if helm_fails { "true" } else { "false" })
            .current_dir(&self.0)
            .output()
            .unwrap();
        let verdict = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
        (output, verdict)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn report() -> Value {
    let probe = |status| json!({"status":status,"reason":"fixture"});
    let nodes = ["worker-a", "worker-b"].iter().map(|name| json!({
        "nodeName":name,"report":{"schemaVersion":2,"kind":"krab-node-precheck",
        "node":{"architecture":"amd64","kernel":"test-kernel","machineID":format!("machine-{name}"),
            "bootID":format!("boot-{name}"),"checkerVersion":env!("CARGO_PKG_VERSION"),"checkedAtUnixSeconds":1},
        "checks":{"kvm":probe("yes"),"tdx":probe("yes"),"snp":probe("no"),"se":probe("no"),"iommufd":probe("yes"),"erofs":probe("yes")},
        "gpus":{"present":probe("yes"),"nvidia":probe("yes"),"cc":probe("yes"),"ppcie":probe("yes"),"nvswitch":probe("no"),
            "devices":[{"name":"NVIDIA H100", "pciBusId":"0000:01:00.0","chip":"H100"}]}}
    })).collect::<Vec<_>>();
    json!({"kind":"krab-cluster-precheck","schemaVersion":2,"nodes":nodes,
        "scope":{"nodeSelector":"kubernetes.io/os=linux","nodes":[
            {"name":"worker-a","uid":"uid-a","machineID":"machine-worker-a","bootID":"boot-worker-a"},
            {"name":"worker-b","uid":"uid-b","machineID":"machine-worker-b","bootID":"boot-worker-b"}]}})
}

#[test]
fn every_node_must_confirm_every_selected_requirement() {
    let fixture = Fixture::new();
    for status in ["no", "unknown", "review"] {
        let mut evidence = report();
        evidence["nodes"][1]["report"]["checks"]["tdx"]["status"] = status.into();
        let (output, verdict) = fixture.offline(&evidence, &["tdx"]);
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(verdict["verdict"], "fail");
        assert_eq!(verdict["passedNodes"], 1);
        assert_eq!(verdict["failedNodes"], 1);
        assert_eq!(verdict["nodes"][1]["failures"][0]["status"], status);
        assert_eq!(verdict["precheck"], evidence);
    }
    let (output, verdict) = fixture.offline(&report(), &["tdx", "gpu-cc"]);
    assert!(output.status.success());
    assert_eq!(verdict["verdict"], "pass");
    assert_eq!(verdict["passedNodes"], 2);
}

#[test]
fn selection_controls_the_verdict_including_mixed_cpu_clusters() {
    let fixture = Fixture::new();
    let mut evidence = report();
    evidence["nodes"][1]["report"]["checks"]["tdx"]["status"] = "no".into();
    evidence["nodes"][1]["report"]["checks"]["snp"]["status"] = "yes".into();
    assert!(fixture.offline(&evidence, &["cc"]).0.status.success());
    assert_eq!(
        fixture.offline(&evidence, &["tdx"]).0.status.code(),
        Some(1)
    );
    assert!(fixture.offline(&evidence, &["gpu-cc"]).0.status.success());
    evidence["nodes"][1]["report"]["gpus"]["cc"]["status"] = "review".into();
    assert!(fixture.offline(&evidence, &["cc"]).0.status.success());
    assert_eq!(
        fixture.offline(&evidence, &["gpu-cc"]).0.status.code(),
        Some(1)
    );
    assert!(fixture
        .offline(&evidence, &["gpu-ppcie"])
        .0
        .status
        .success());
}

#[test]
fn incomplete_duplicate_stale_and_legacy_evidence_never_passes() {
    let fixture = Fixture::new();
    for mutate in [
        |r: &mut Value| {
            r["nodes"].as_array_mut().unwrap().pop();
        },
        |r: &mut Value| {
            r["nodes"][1]["nodeName"] = "worker-a".into();
        },
        |r: &mut Value| {
            r["scope"]["nodes"][1]["uid"] = "uid-a".into();
        },
        |r: &mut Value| {
            r["nodes"][1]["report"]["node"]["bootID"] = "old-boot".into();
        },
        |r: &mut Value| {
            r["nodes"][1]["report"]["node"]["checkerVersion"] = "old-checker".into();
        },
        |r: &mut Value| {
            r["schemaVersion"] = 1.into();
        },
        |r: &mut Value| {
            r.as_object_mut().unwrap().remove("scope");
        },
        |r: &mut Value| {
            r["nodes"][1]["report"]["checks"]["tdx"]["status"] = "invalid".into();
        },
        |r: &mut Value| {
            r["nodes"] = json!([]);
        },
    ] {
        let mut evidence = report();
        mutate(&mut evidence);
        let (output, verdict) = fixture.offline(&evidence, &["tdx"]);
        assert_eq!(output.status.code(), Some(2), "{evidence}");
        assert_eq!(verdict["verdict"], "error");
    }
}

#[test]
fn all_required_prerequisites_are_checked_and_failure_details_are_collected() {
    let fixture = Fixture::new();
    let mut evidence = report();
    for check in ["kvm", "erofs", "iommufd"] {
        evidence["nodes"][1]["report"]["checks"][check]["status"] = "unknown".into();
    }
    evidence["nodes"][1]["report"]["gpus"]["devices"] = json!([]);
    let (output, verdict) = fixture.offline(&evidence, &["tdx", "gpu-cc"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(verdict["nodes"][1]["failures"].as_array().unwrap().len(), 4);
    assert!(
        fixture
            .run(&[
                "--report",
                "report.json",
                "--require",
                "gpu-cc",
                "--gpu-model",
                "H200"
            ])
            .status
            .code()
            == Some(1)
    );
    assert!(fixture.run(&["--report", "report.json"]).status.code() == Some(2));
    assert!(
        fixture
            .run(&[
                "--report",
                "report.json",
                "--require",
                "tdx",
                "--require",
                "snp"
            ])
            .status
            .code()
            == Some(2)
    );
}

#[test]
fn live_run_pins_context_forces_refresh_preserves_selectors_and_saves_all_evidence() {
    let fixture = Fixture::new();
    let (output, verdict) = fixture.live(&report(), false, false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(verdict["source"], "live-cluster");
    assert_eq!(verdict["coverageVerified"], true);
    let saved: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("verdict.json")).unwrap()).unwrap();
    assert_eq!(saved, verdict);
    let values: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("values.json")).unwrap()).unwrap();
    assert_eq!(values["cache"]["forceRefresh"], true);
    assert_eq!(values["nodeSelector"], "pool=cc,zone in (a,b)");
    let trace = fs::read_to_string(fixture.0.join("trace")).unwrap();
    assert!(trace.contains("--kube-context test-context"));
    assert!(trace.contains("--context test-context"));
    assert!(trace.contains("--selector pool=cc,zone in (a,b),kubernetes.io/os=linux"));
}

#[test]
fn node_changes_and_collection_failures_produce_nonpassing_machine_readable_verdicts() {
    for (reboot, helm_fails) in [(true, false), (false, true)] {
        let fixture = Fixture::new();
        let (output, verdict) = fixture.live(&report(), reboot, helm_fails);
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(verdict["verdict"], "error");
        assert!(!verdict["failures"].as_array().unwrap().is_empty());
        assert_eq!(verdict["coverageVerified"], false);
        if reboot {
            assert!(verdict["precheck"].is_object());
        }
    }
}

#[test]
fn job_exit_codes_and_termination_summaries_distinguish_pass_fail_and_collection_error() {
    for (expected, verdict_name) in [(0, "pass"), (1, "fail"), (2, "error")] {
        let fixture = Fixture::new();
        let mut evidence = report();
        if expected == 1 {
            evidence["nodes"][1]["report"]["checks"]["tdx"]["status"] = "no".into();
        }
        fixture.write("report.json", &evidence);
        fs::write(
            fixture.0.join("collection-error.txt"),
            if expected == 2 {
                "Dispatcher Job failed; collection incomplete"
            } else {
                ""
            },
        )
        .unwrap();
        let output = fixture.run(&[
            "--report",
            "report.json",
            "--require",
            "tdx",
            "--json",
            "--collection-error",
            "collection-error.txt",
            "--termination-message",
            "termination.json",
        ]);
        assert_eq!(output.status.code(), Some(expected));
        let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
        let termination: Value =
            serde_json::from_slice(&fs::read(fixture.0.join("termination.json")).unwrap()).unwrap();
        assert_eq!(verdict["verdict"], verdict_name);
        assert_eq!(verdict["source"], "cluster-job");
        assert_eq!(termination["verdict"], verdict_name);
        assert_eq!(termination["exitCode"], expected);
    }
}

#[test]
fn text_output_names_passing_and_failing_nodes() {
    let fixture = Fixture::new();
    let mut evidence = report();
    evidence["nodes"][1]["report"]["checks"]["tdx"]["status"] = "no".into();
    fixture.write("report.json", &evidence);
    let output = fixture.run(&["--report", "report.json", "--require", "tdx"]);
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("worker-a: PASS"));
    assert!(text.contains("worker-b: FAIL"));
    assert!(text.starts_with("FAIL:"));
}

#[test]
fn gpu_or_is_satisfied_on_each_node_and_preserves_mandatory_prerequisites() {
    let fixture = Fixture::new();
    let mut evidence = report();
    evidence["nodes"][0]["report"]["gpus"]["ppcie"]["status"] = "no".into();
    evidence["nodes"][1]["report"]["gpus"]["cc"]["status"] = "no".into();
    fixture.write("report.json", &evidence);
    let args = [
        "--report",
        "report.json",
        "--require-any",
        "gpu-cc,gpu-ppcie",
        "--json",
    ];
    let output = fixture.run(&args);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(verdict["anyOfRequirements"], json!(["gpu-cc", "gpu-ppcie"]));
    assert_eq!(
        verdict["nodes"][0]["matchedAnyOfRequirements"],
        json!(["gpu-cc"])
    );
    assert_eq!(
        verdict["nodes"][1]["matchedAnyOfRequirements"],
        json!(["gpu-ppcie"])
    );
    // One capable node cannot cover another node with no confirmed alternative.
    for status in ["no", "unknown", "review"] {
        evidence["nodes"][1]["report"]["gpus"]["ppcie"]["status"] = status.into();
        fixture.write("report.json", &evidence);
        assert_eq!(fixture.run(&args).status.code(), Some(1));
    }
    evidence["nodes"][1]["report"]["gpus"]["ppcie"]["status"] = "yes".into();
    evidence["nodes"][1]["report"]["checks"]["iommufd"]["status"] = "no".into();
    fixture.write("report.json", &evidence);
    assert_eq!(fixture.run(&args).status.code(), Some(1));
    evidence["nodes"][1]["report"]["checks"]["iommufd"]["status"] = "yes".into();
    evidence["nodes"][1]["report"]["checks"]["tdx"]["status"] = "no".into();
    fixture.write("report.json", &evidence);
    assert_eq!(fixture.run(&args).status.code(), Some(0));
    assert_eq!(
        fixture
            .run(&[
                "--report",
                "report.json",
                "--require",
                "tdx",
                "--require-any",
                "gpu-cc,gpu-ppcie"
            ])
            .status
            .code(),
        Some(1)
    );
    assert_eq!(
        fixture
            .run(&["--report", "report.json", "--require-any", "tdx,snp"])
            .status
            .code(),
        Some(2)
    );
}
