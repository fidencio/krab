use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Output, Stdio};

fn run(args: &[&str], input: Option<&str>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_krab"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        if let Err(error) = child.stdin.take().unwrap().write_all(input.as_bytes()) {
            // Argument errors may exit before reading stdin. Preserve their exit
            // code and stderr, while still rejecting every other write failure.
            assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        }
    }
    child.wait_with_output().unwrap()
}

fn config() -> Value {
    json!({"apiVersion":"krab/v1alpha1", "vendor":"custom", "distribution":"kubeadm",
        "architectures":["amd64"], "runtimes":["qemu-runtime-rs"]})
}

fn generate(config: Value) -> Output {
    run(&["generate", "--config", "-"], Some(&config.to_string()))
}

#[test]
fn generate_offline_and_validate_chart_version() {
    let output = generate(config());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let source = String::from_utf8(output.stdout).unwrap();
    assert!(source.contains(&format!(
        "# KRAB chart version: {}",
        env!("CARGO_PKG_VERSION")
    )));
    let values: Value = serde_yaml_ng::from_str(&source).unwrap();
    assert_eq!(
        values["kata-deploy"]["shims"]["qemu-runtime-rs"]["enabled"],
        true
    );
    assert_eq!(values["nvidia"]["enabled"], false);
}

#[test]
fn malformed_unknown_and_incompatible_choices_fail_without_values() {
    let cases = [
        ("vendor", json!("typo")),
        ("distribution", json!("typo")),
        ("apiVersion", json!("krab/v99")),
        ("runtimes", json!(["missing"])),
        ("architectures", json!(["x86_64"])),
        ("release", json!("../../other")),
        ("valuesOverrides", json!([])),
        ("typo", json!(true)),
        (
            "hardware",
            json!({"grace-blackwell": {"mode":"on","cpuTees":["tdx"]}}),
        ),
    ];
    for (key, value) in cases {
        let mut config = config();
        config[key] = value;
        let output = generate(config);
        assert_eq!(output.status.code(), Some(2), "{key}");
        assert!(output.stdout.is_empty(), "{key}");
        assert!(!output.stderr.is_empty(), "{key}");
    }
    let output = run(&["generate", "--config", "-"], Some("vendor: ["));
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn overrides_are_applied_and_schema_checked() {
    let mut cfg = config();
    cfg["valuesOverrides"] = json!({"kata-deploy":{"debug":true,"nodeSelector":{"pool":"kata"}}});
    let output = generate(cfg.clone());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let values: Value = serde_yaml_ng::from_slice(&output.stdout).unwrap();
    assert_eq!(values["kata-deploy"]["debug"], true);
    assert_eq!(values["kata-deploy"]["nodeSelector"]["pool"], "kata");
    cfg["valuesOverrides"]["kata-deploy"]["enabled"] = json!("yes");
    assert_eq!(generate(cfg).status.code(), Some(2));
}

#[test]
fn install_plan_pins_context_and_never_executes_helm_by_default() {
    let output = run(
        &[
            "install",
            "--config",
            "-",
            "--context",
            "test context; echo nope",
        ],
        Some(&config().to_string()),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(plan["program"], "helm");
    let args = plan["args"].as_array().unwrap();
    assert!(args.contains(&json!("test context; echo nope")));
    assert!(args.contains(&json!(env!("CARGO_PKG_VERSION"))));
    assert!(plan["stdin"]
        .as_str()
        .unwrap()
        .contains("# KRAB values format: 2"));
    assert_eq!(
        run(&["install", "--config", "-"], Some(&config().to_string()))
            .status
            .code(),
        Some(2)
    );
}

#[test]
fn discovery_completions_and_embedded_checks_are_available() {
    let output = run(&["list", "runtimes", "--vendor", "amd", "--json"], None);
    assert!(output.status.success());
    let choices: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!choices.is_empty());
    assert!(choices.iter().all(|v| v["vendor"] == "amd"));
    for args in [
        vec!["precheck", "--help"],
        vec!["conformance", "--help"],
        vec!["completions", "bash"],
    ] {
        let output = run(&args, None);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!output.stdout.is_empty());
    }
    assert_eq!(
        run(&["conformance", "--require", "invalid"], None)
            .status
            .code(),
        Some(2)
    );
}

#[test]
fn init_does_not_replace_existing_files() {
    let dir = std::env::temp_dir().join(format!("krab-cli-init-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("krab.yaml");
    let path = file.to_str().unwrap();
    assert!(run(&["init", "--non-interactive", "--output", path], None)
        .status
        .success());
    std::fs::write(&file, "keep me").unwrap();
    assert_eq!(
        run(&["init", "--non-interactive", "--output", path], None)
            .status
            .code(),
        Some(2)
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me");
    assert!(run(
        &["init", "--non-interactive", "--output", path, "--force"],
        None
    )
    .status
    .success());
    assert_ne!(std::fs::read_to_string(&file).unwrap(), "keep me");
    std::fs::remove_dir_all(dir).unwrap();
}

fn answers(lines: &[&str]) -> String {
    lines.join("\n") + "\n"
}
fn success(result: &Output) {
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
struct Fixture {
    dir: std::path::PathBuf,
    path: std::path::PathBuf,
    source: String,
}
impl Fixture {
    fn new(name: &str, config: &Value) -> Self {
        let dir = std::env::temp_dir().join(format!("krab-editor-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("krab.yaml");
        let source = format!(
            "# Keep this comment on an unchanged edit.\n{}",
            serde_yaml_ng::to_string(config).unwrap()
        );
        std::fs::write(&path, &source).unwrap();
        Self { dir, path, source }
    }
    fn edit(&self, input: &str) -> Output {
        run(
            &[
                "edit",
                "--interactive",
                "--config",
                self.path.to_str().unwrap(),
            ],
            Some(input),
        )
    }
    fn config(&self) -> Value {
        serde_yaml_ng::from_str(&std::fs::read_to_string(&self.path).unwrap()).unwrap()
    }
    fn unchanged(&self) {
        assert_eq!(std::fs::read_to_string(&self.path).unwrap(), self.source);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).unwrap();
    }
}

#[test]
fn init_collects_essentials_then_opens_overview_and_keeps_stdout_clean() {
    let result = run(
        &["init", "--interactive", "--output", "-"],
        Some(&"\n".repeat(6)),
    );
    success(&result);
    let cfg: Value = serde_yaml_ng::from_slice(&result.stdout).unwrap();
    assert_eq!(cfg["runtimes"], json!(["qemu-runtime-rs"]));
    let ui = String::from_utf8_lossy(&result.stderr);
    assert!(ui.contains("Sections and actions"));
    assert!(ui.contains("unsaved changes"));
    success(&generate(cfg));
}
#[test]
fn sections_revisit_gpu_runtimes_deployment_validate_and_preview() {
    let input = answers(&[
        "nvidia",
        "amd64",
        "k3s",
        "gpu",
        "hopper",
        "ppcie",
        "tdx",
        "runtimes",
        "none",
        "selinux",
        "yes",
        "deployment",
        "gpu-sandbox",
        "kata-test",
        "validate",
        "preview",
        "save",
        "",
        "yes",
    ]);
    let result = run(&["init", "--interactive", "--output", "-"], Some(&input));
    success(&result);
    let cfg: Value = serde_yaml_ng::from_slice(&result.stdout).unwrap();
    assert_eq!(cfg["hardware"]["hopper"]["cpuTees"], json!(["tdx"]));
    assert_eq!(cfg["runtimes"], json!([]));
    assert_eq!(cfg["release"], "gpu-sandbox");
    assert_eq!(cfg["selinux"], true);
    let ui = String::from_utf8_lossy(&result.stderr);
    assert!(ui.contains("Generated Helm values:"));
    assert!(!ui.contains("Grace-Blackwell"));
    success(&generate(cfg));
}
#[test]
fn invalid_answers_and_back_navigation_preserve_current_section() {
    let input = answers(&[
        "bogus",
        "custom",
        "99",
        "amd64",
        "back",
        "arm64",
        "k3s",
        "deployment",
        "BAD_NAME",
        "first",
        "back",
        "second",
        "kata-test",
        "save",
        "",
        "yes",
    ]);
    let result = run(&["init", "--interactive", "--output", "-"], Some(&input));
    success(&result);
    let cfg: Value = serde_yaml_ng::from_slice(&result.stdout).unwrap();
    assert_eq!(cfg["architectures"], json!(["arm64"]));
    assert_eq!(cfg["release"], "second");
    success(&generate(cfg));
}
#[test]
fn edit_opens_overview_and_unchanged_save_preserves_advanced_settings_and_comments() {
    let mut cfg = config();
    cfg["architectures"] = json!(["amd64", "arm64"]);
    cfg["components"] =
        json!({"nfd":false,"kataDeploy":false,"devicePlugin":true,"provisioner":false,"qgs":true});
    cfg["runtime"] = json!({"httpsProxy":"https://old.proxy:8443","erofsMode":"disk","erofsDiskSize":"512M","erofsDmverity":false,"erofsFsverity":true});
    cfg["valuesOverrides"] = json!({"kata-deploy":{"nodeSelector":{"pool":"existing"},"customRuntimes":{"enabled":true,"runtimes":{"special":{"baseConfig":"qemu-runtime-rs","runtimeClass":"custom manifest"}}}}});
    let f = Fixture::new("preserve", &cfg);
    let result = f.edit("\n\n\n");
    success(&result);
    f.unchanged();
    let ui = String::from_utf8_lossy(&result.stderr);
    assert!(ui.contains("no unsaved changes"));
    assert!(!ui.contains("Choose numbers or IDs"));
}
#[test]
fn section_changes_keep_other_sections_and_architecture_changes_reconcile_dependencies() {
    let mut cfg = config();
    cfg["runtimes"] = json!(["qemu-runtime-rs", "qemu-tdx-runtime-rs"]);
    cfg["hardware"] = json!({"hopper":{"mode":"ppcie","cpuTees":["tdx"]}});
    cfg["valuesOverrides"] = json!({"kata-deploy":{"debug":true}});
    let f = Fixture::new("sections", &cfg);
    success(&f.edit(&answers(&[
        "distribution",
        "k3s",
        "deployment",
        "edited",
        "",
        "save",
        "",
        "yes",
    ])));
    let updated = f.config();
    for field in ["hardware", "runtimes", "valuesOverrides"] {
        assert_eq!(updated[field], cfg[field]);
    }
    assert_eq!(updated["release"], "edited");
    let result = f.edit(&answers(&["architectures", "arm64", "save", "", "yes"]));
    success(&result);
    let updated = f.config();
    assert_eq!(updated["hardware"], json!({}));
    assert_eq!(updated["runtimes"], json!(["qemu-runtime-rs"]));
    assert!(String::from_utf8_lossy(&result.stderr).contains("Removed incompatible selections"));
    success(&generate(updated));
}
#[test]
fn invalid_configuration_remains_in_editor_and_can_be_repaired() {
    let f = Fixture::new("repair", &config());
    let result = f.edit(&answers(&[
        "runtimes",
        "none",
        "save",
        "runtimes",
        "qemu-runtime-rs",
        "validate",
        "save",
        "",
        "yes",
    ]));
    success(&result);
    assert!(String::from_utf8_lossy(&result.stderr).contains("Validation [runtimes]"));
    f.unchanged();
}
#[test]
fn init_and_edit_share_direct_advanced_controls_and_return_to_overview() {
    let input = answers(&[
        "components,runtime",
        "disabled",
        "enabled",
        "auto",
        "auto",
        "enabled",
        "https://proxy.test",
        "-",
        "yes",
        "disk",
        "512M",
        "no",
        "yes",
        "yes",
        "save",
        "",
        "yes",
    ]);
    let f = Fixture::new("advanced", &config());
    for args in [
        vec!["init", "--advanced", "--interactive", "--output", "-"],
        vec![
            "edit",
            "--advanced",
            "--interactive",
            "--config",
            f.path.to_str().unwrap(),
            "--output",
            "-",
        ],
    ] {
        let result = run(&args, Some(&input));
        success(&result);
        let cfg: Value = serde_yaml_ng::from_slice(&result.stdout).unwrap();
        assert_eq!(cfg["components"]["nfd"], false);
        assert_eq!(cfg["runtime"]["httpsProxy"], "https://proxy.test");
        assert_eq!(cfg["runtime"]["erofsDiskSize"], "512M");
        success(&generate(cfg));
    }
    f.unchanged();
}
#[test]
fn yaml_and_schema_errors_can_be_repaired_without_losing_other_settings() {
    let f = Fixture::new("overrides", &config());
    let result = f.edit(&answers(&[
        "advanced",
        "overrides",
        "[broken",
        ".",
        "kata-deploy:",
        "  enabled: invalid",
        ".",
        "save",
        "advanced",
        "overrides",
        "kata-deploy:",
        "  debug: true",
        ".",
        "preview",
        "save",
        "",
        "yes",
    ]));
    success(&result);
    let ui = String::from_utf8_lossy(&result.stderr);
    assert!(ui.contains("Invalid YAML"));
    assert!(ui.contains("Validation [advanced]"));
    assert_eq!(f.config()["valuesOverrides"]["kata-deploy"]["debug"], true);
}
#[test]
fn exit_confirms_unsaved_changes_and_section_cancellation_rolls_back_drafts() {
    let f = Fixture::new("exit", &config());
    let result = f.edit(&answers(&[
        "deployment",
        "partial",
        "q",
        "distribution",
        "k3s",
        "exit",
        "no",
        "preview",
        "exit",
        "yes",
    ]));
    success(&result);
    let ui = String::from_utf8_lossy(&result.stderr);
    assert!(ui.contains("Section cancelled; earlier settings kept."));
    assert!(ui.contains("Discard unsaved changes and exit?"));
    assert!(!ui.contains("partial /"));
    f.unchanged();
    success(&f.edit("q\n"));
}
#[test]
fn declining_save_returns_to_overview_and_collision_asks_for_another_name() {
    let f = Fixture::new("save", &config());
    success(&f.edit(&answers(&[
        "distribution",
        "k3s",
        "save",
        "",
        "no",
        "exit",
        "yes",
    ])));
    f.unchanged();
    let occupied = f.dir.join("occupied.yaml");
    std::fs::write(&occupied, "keep this file").unwrap();
    for action in ["init", "edit"] {
        let dest = f.dir.join(format!("{action}-copy.yaml"));
        let input = if action == "init" {
            "\n\n\nsave\n\n"
        } else {
            "save\n\n"
        }
        .to_string()
            + dest.to_str().unwrap()
            + "\nyes\n";
        let mut args = vec![
            action,
            "--interactive",
            "--output",
            occupied.to_str().unwrap(),
        ];
        if action == "edit" {
            args.extend(["--config", f.path.to_str().unwrap()]);
        }
        let result = run(&args, Some(&input));
        success(&result);
        assert!(dest.exists());
        assert!(String::from_utf8_lossy(&result.stderr)
            .contains("already exists. Choose another filename"));
        assert_eq!(
            std::fs::read_to_string(&occupied).unwrap(),
            "keep this file"
        );
    }
    f.unchanged();
}
#[test]
fn eof_and_invalid_sources_leave_files_intact_and_noninteractive_mode_is_explicit() {
    let f = Fixture::new("invalid", &config());
    assert_eq!(f.edit("").status.code(), Some(2));
    f.unchanged();
    std::fs::write(&f.path, "apiVersion: krab/v99\n").unwrap();
    assert_eq!(f.edit("save\n").status.code(), Some(2));
    assert_eq!(
        std::fs::read_to_string(&f.path).unwrap(),
        "apiVersion: krab/v99\n"
    );
    assert_eq!(run(&["init", "--output", "-"], None).status.code(), Some(2));
    success(&run(&["init", "--non-interactive", "--output", "-"], None));
}
