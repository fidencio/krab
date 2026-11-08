use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn product_profile_controls_discovery_starters_imports_and_explicit_overrides() {
    let directory = std::env::temp_dir().join(format!("krab-product-test-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let profile = directory.join("krab-profile.json");
    fs::write(
        &profile,
        include_str!("../../examples/product-profiles/coco.json"),
    )
    .unwrap();
    let output = directory.join("krab.yaml");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_krab"))
            .arg("--profile")
            .arg(&profile)
            .args(args)
            .output()
            .unwrap()
    };
    let catalog = run(&["list", "catalog", "--json"]);
    assert!(
        catalog.status.success(),
        "{}",
        String::from_utf8_lossy(&catalog.stderr)
    );
    let catalog: Value = serde_json::from_slice(&catalog.stdout).unwrap();
    assert_eq!(catalog["product"]["attribution"], "Powered by KRAB");
    assert_eq!(catalog["vendors"].as_array().unwrap().len(), 1);
    assert_eq!(
        catalog["vendors"][0]["runtime"]["shims"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let created = run(&[
        "init",
        "--non-interactive",
        "--output",
        output.to_str().unwrap(),
    ]);
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let config: Value = serde_yaml_ng::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(config["runtimes"], json!(["qemu-coco-dev-runtime-rs"]));
    assert_eq!(config["release"], "coco");
    assert!(run(&["generate", "--config", output.to_str().unwrap()])
        .status
        .success());
    assert!(!run(&[
        "init",
        "--non-interactive",
        "--runtime",
        "qemu-runtime-rs",
        "--output",
        directory.join("bad.yaml").to_str().unwrap()
    ])
    .status
    .success());
    let mut changed = config.clone();
    changed["advanced"]["images"]["kataDeploy"]["tag"] = json!("other");
    let mut child = Command::new(env!("CARGO_BIN_EXE_krab"))
        .arg("--profile")
        .arg(&profile)
        .args(["generate", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(changed.to_string().as_bytes())
        .unwrap();
    let rejected = child.wait_with_output().unwrap();
    assert_eq!(rejected.status.code(), Some(2));
    assert!(rejected.stdout.is_empty());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("imageOverrides"));
    fs::remove_dir_all(directory).unwrap();
}
