//! Generate managed NVIDIA CPU profiles and deployment conformance policies.
use crate::config::{find, Config, Result};
use serde_json::json;
use serde_json::Value;

/// CPU profiles are normal selections. The node pipeline fills their measured
/// extension metadata from the installed reference before CRI registration.
pub fn apply_presets(
    values: &mut Value,
    config: &Config,
    vendor: &Value,
    catalog: &Value,
    shims: &[&Value],
) -> Result<()> {
    let runtime = &mut values["kata-deploy"];
    let mut tees = Vec::new();
    for shim in shims {
        let id = crate::config::text(&shim["id"]);
        let Some(tee) = crate::cpu::tee_for_runtime(id) else {
            continue;
        };
        tees.push(tee.to_string());
        let base = format!("qemu-nvidia-gpu-{tee}-runtime-rs");
        let handler = format!("kata-{id}");
        let mut selector = shim["nodeSelector"].clone();
        selector["kubernetes.io/arch"] = json!("amd64");
        selector["katacontainers.io/kata-runtime"] = json!("true");
        if config.advanced.continuous_conformance {
            selector["feature.node.kubernetes.io/krab-conformance"] = json!("pass");
        }
        let resource = if tee == "tdx" {
            "tdx.intel.com/keys"
        } else {
            "sev-snp.amd.com/esids"
        };
        let class = json!({"apiVersion":"node.k8s.io/v1", "kind":"RuntimeClass", "metadata":{"name":handler,"labels":{"app.kubernetes.io/managed-by":"kata-deploy"}}, "handler":handler,"scheduling":{"nodeSelector":selector},"overhead":{"podFixed":{resource:"1"}}});
        if runtime["customRuntimes"].is_null() {
            runtime["customRuntimes"] = json!({"enabled":true,"runtimes":{}});
        }
        runtime["customRuntimes"]["enabled"] = json!(true);
        runtime["customRuntimes"]["runtimes"][id] = json!({
            "baseConfig":base,"inheritBaseOverhead":true,
            "dropIn":config.advanced.shim_drop_ins.get(id).map(String::as_str).unwrap_or("# NVIDIA CPU profile prepared by KRAB's node stage.\n"),
            "runtimeClass":serde_yaml_ng::to_string(&class).map_err(|e|e.to_string())?,
            "containerd":{"snapshotter":"nydus"},"crio":{"pullType":"guest-pull"}
        });
        if runtime["shims"][&base].is_null() {
            runtime["shims"][&base] = vendor["runtime"]["chart"]["values"]["shims"][&base].clone();
            runtime["shims"][&base]["enabled"] = json!(false);
        }
    }
    if config.advanced.continuous_conformance {
        for (_, shim) in runtime["shims"].as_object_mut().unwrap().iter_mut() {
            if shim["enabled"] == true {
                if !shim["runtimeClass"].is_object() {
                    shim["runtimeClass"] = json!({});
                }
                if !shim["runtimeClass"]["nodeSelector"].is_object() {
                    shim["runtimeClass"]["nodeSelector"] = json!({});
                }
                shim["runtimeClass"]["nodeSelector"]
                    ["feature.node.kubernetes.io/krab-conformance"] = json!("pass");
            }
        }
        if let Some(custom) = runtime["customRuntimes"]["runtimes"].as_object_mut() {
            for (_, entry) in custom {
                if let Some(source) = entry["runtimeClass"].as_str() {
                    let mut class: Value =
                        serde_yaml_ng::from_str(source).map_err(|e| e.to_string())?;
                    if !class.is_object() {
                        return Err(
                            "Custom RuntimeClass must be a YAML object for continuous conformance"
                                .into(),
                        );
                    }
                    if !class["scheduling"].is_null() && !class["scheduling"].is_object() {
                        return Err("Custom RuntimeClass scheduling must be an object".into());
                    }
                    if !class["scheduling"]["nodeSelector"].is_null()
                        && !class["scheduling"]["nodeSelector"].is_object()
                    {
                        return Err("Custom RuntimeClass nodeSelector must be an object".into());
                    }
                    if class["scheduling"].is_null() {
                        class["scheduling"] = json!({"nodeSelector":{}});
                    }
                    if class["scheduling"]["nodeSelector"].is_null() {
                        class["scheduling"]["nodeSelector"] = json!({});
                    }
                    class["scheduling"]["nodeSelector"]
                        ["feature.node.kubernetes.io/krab-conformance"] = json!("pass");
                    entry["runtimeClass"] =
                        json!(serde_yaml_ng::to_string(&class).map_err(|e| e.to_string())?);
                }
            }
        }
    }
    tees.sort();
    values["global"] = json!({"krab": {
        "continuousConformance": config.advanced.continuous_conformance,
        "nodeImage":format!("ghcr.io/kata-containers/krab-preflight:{}", crate::config::text(&catalog["plannedArchitecture"]["charts"]["krab"]["version"])),
        "nvidiaCpuTees":tees,
        "conformancePolicy": if config.advanced.continuous_conformance { deployment_policy(config, vendor, shims)? } else { Vec::new() },
    }});
    Ok(())
}

fn deployment_policy(config: &Config, vendor: &Value, shims: &[&Value]) -> Result<Vec<Value>> {
    let mut policies = Vec::new();
    let mut bases = shims.to_vec();
    for custom in &config.advanced.custom_runtimes {
        let base = find(&vendor["runtime"]["shims"], &custom.base_config)?;
        if !bases.iter().any(|shim| shim["id"] == base["id"]) {
            bases.push(base);
        }
    }
    for shim in bases {
        let id = crate::config::text(&shim["id"]);
        let mut modes = vec!["".to_string()];
        if id.contains("nvidia-gpu") {
            modes = config
                .hardware
                .values()
                .filter(|s| {
                    if id.contains("-tdx-") {
                        s.cpu_tees.iter().any(|t| t == "tdx")
                    } else if id.contains("-snp-") {
                        s.cpu_tees.iter().any(|t| t == "snp")
                    } else {
                        s.cpu_tees.is_empty()
                    }
                })
                .map(|s| s.mode.clone())
                .collect();
            if modes.is_empty() {
                modes.push(
                    if id.contains("-tdx-") || id.contains("-snp-") {
                        "on"
                    } else {
                        "off"
                    }
                    .into(),
                );
            }
        }
        modes.sort();
        modes.dedup();
        for mode in modes {
            let mut requirements = vec!["kvm"];
            if id.contains("-tdx-") {
                requirements.push("tdx");
            }
            if id.contains("-snp-") {
                requirements.push("snp");
            }
            if id.contains("-se-") {
                requirements.push("se");
            }
            if id.contains("nvidia-gpu") {
                requirements.push(match mode.as_str() {
                    "on" => "gpu-cc",
                    "ppcie" => "gpu-ppcie",
                    _ => "gpu",
                });
            }
            if shim["snapshotter"] == "erofs" {
                requirements.push("erofs");
            }
            let arches: Vec<_> = crate::config::items(&shim["supportedArches"])
                .iter()
                .filter(|a| {
                    config.architectures.is_empty()
                        || config.architectures.iter().any(|s| a.as_str() == Some(s))
                })
                .collect();
            policies.push(json!({"name":format!("{id}{mode}"),"architectures":arches,"requirements":requirements,"gpuModels":[]}));
        }
    }
    policies.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    if policies.is_empty() {
        return Err("Continuous conformance needs a selected runtime".into());
    }
    Ok(policies)
}
