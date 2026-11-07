use crate::config::{find, items, text, validate_schema, Config, Result};
use serde_json::{json, Map, Value};

/// Helm-style recursive mapping merge; sequences and scalars replace defaults.
pub fn merge(target: &mut Value, overlay: &Value) {
    if let (Some(dst), Some(src)) = (target.as_object_mut(), overlay.as_object()) {
        for (key, value) in src {
            merge(dst.entry(key).or_insert(Value::Null), value);
        }
    } else {
        *target = overlay.clone();
    }
}

pub fn build(config: &Config, catalog: &Value) -> Result<Value> {
    let vendor = config.validate(catalog)?;
    let architecture = &catalog["plannedArchitecture"];
    let shims = config.shims(vendor)?;
    let gpu = !config.hardware.is_empty();
    let plugin = config.components.device_plugin.unwrap_or(gpu);
    let provisioner = config.components.provisioner.unwrap_or(gpu);
    let qgs = config.components.qgs.unwrap_or_else(|| {
        shims.iter().any(|s| text(&s["id"]).contains("-tdx-"))
            || config
                .advanced
                .custom_runtimes
                .iter()
                .any(|s| s.base_config.contains("-tdx-"))
    });
    let mut runtime = vendor["runtime"]["chart"]["values"].clone();
    runtime["deploymentMode"] = json!("job");
    runtime["debug"] = json!(false);
    runtime["k8sDistribution"] = find(
        &architecture["cluster"]["distributions"],
        &config.distribution,
    )?["kataDeployValue"]
        .clone();
    runtime["selinux"] = json!({"enabled": config.selinux});
    let mut selected = json!({"disableAll": true});
    for shim in &shims {
        let id = text(&shim["id"]);
        let mut value = runtime["shims"][id].clone();
        if !value.is_object() {
            return Err(format!("Catalog has no configuration for runtime {id}"));
        }
        value["enabled"] = json!(true);
        if value["agent"].is_object() {
            value["agent"]["httpsProxy"] = json!(config.runtime.https_proxy.trim());
            value["agent"]["noProxy"] = json!(config.runtime.no_proxy.trim());
        }
        if id.contains("nvidia-gpu") {
            if !value["nvrc"].is_object() {
                value["nvrc"] = json!({});
            }
            value["nvrc"]["enableDCGM"] = json!(config.runtime.nvidia_dcgm);
        }
        selected[id] = value;
    }
    runtime["shims"] = selected;
    let arches: Vec<String> = if config.vendor == "custom" {
        config.architectures.clone()
    } else {
        shims
            .iter()
            .flat_map(|s| {
                items(&s["supportedArches"])
                    .iter()
                    .map(|a| text(a).to_string())
            })
            .collect()
    };
    let mut defaults = json!({});
    for arch in arches {
        let candidates: Vec<_> = shims
            .iter()
            .filter(|s| {
                let id = text(&s["id"]);
                items(&s["supportedArches"]).contains(&json!(arch))
                    && (config.vendor != "custom"
                        || (!id.split('-').any(|p| ["snp", "tdx", "se"].contains(&p))
                            && !id.contains("nvidia-gpu")))
            })
            .collect();
        if let Some(shim) = candidates
            .iter()
            .find(|s| s["id"] == runtime["defaultShim"][&arch])
            .or(candidates.first())
        {
            defaults[&arch] = shim["id"].clone();
        }
    }
    runtime.as_object_mut().unwrap().remove("defaultShim");
    if !defaults.as_object().unwrap().is_empty() {
        runtime["defaultShim"] = defaults;
    }
    runtime.as_object_mut().unwrap().remove("customRuntimes");
    let mut snapshotters = Vec::new();
    for shim in &shims {
        let snapshotter = text(&shim["snapshotter"]);
        if !snapshotter.is_empty()
            && snapshotter != "default"
            && !snapshotters.contains(&snapshotter)
        {
            snapshotters.push(snapshotter);
        }
    }
    for custom in &config.advanced.custom_runtimes {
        let snapshotter = config.advanced.snapshotter(custom, vendor)?;
        if !snapshotter.is_empty()
            && snapshotter != "default"
            && !snapshotters.contains(&snapshotter)
        {
            snapshotters.push(snapshotter);
        }
    }
    if snapshotters.is_empty() {
        runtime.as_object_mut().unwrap().remove("snapshotter");
        runtime.as_object_mut().unwrap().remove("containerd");
    } else if runtime["snapshotter"].is_object() {
        runtime["snapshotter"]["setup"] = json!(snapshotters);
        runtime["snapshotter"]
            .as_object_mut()
            .unwrap()
            .remove("erofsMergeMode");
        if snapshotters.contains(&"erofs") {
            runtime["snapshotter"]["erofsSnapshotterMode"] = json!(config.runtime.erofs_mode);
            runtime["snapshotter"]["erofsDmverity"] = json!(config.runtime.erofs_dmverity);
            let mut drop_in = format!(
                "[plugins.'io.containerd.snapshotter.v1.erofs']\n  enable_fsverity = {}\n",
                config.runtime.erofs_fsverity
            );
            if config.runtime.erofs_mode == "disk" {
                drop_in.push_str(&format!(
                    "  default_size = {:?}\n",
                    config.runtime.erofs_disk_size.trim()
                ));
            }
            if !runtime["containerd"].is_object() {
                runtime["containerd"] = json!({});
            }
            runtime["containerd"]["userDropIn"] = json!(drop_in);
        } else {
            runtime["snapshotter"]
                .as_object_mut()
                .unwrap()
                .remove("erofsSnapshotterMode");
            runtime["snapshotter"]
                .as_object_mut()
                .unwrap()
                .remove("erofsDmverity");
            runtime.as_object_mut().unwrap().remove("containerd");
        }
    }
    if config.runtime.install_erofs_utils && snapshotters.contains(&"erofs") {
        let lock: Value =
            serde_json::from_str(include_str!("../../upstream/erofs-utils-image.lock.json"))
                .map_err(|e| e.to_string())?;
        if !runtime["nodeBinaries"].is_object() {
            runtime["nodeBinaries"] = json!({});
        }
        runtime["nodeBinaries"]["erofs-utils"] = json!({
            "image": if config.advanced.erofs_utils_image.trim().is_empty() {
                format!("{}:{}@{}", text(&lock["reference"]), text(&lock["tag"]), text(&lock["digest"]))
            } else { config.advanced.erofs_utils_image.trim().to_string() },
            "binaries": ["mkfs.erofs"], "pullPolicy": "IfNotPresent"
        });
    }
    if runtime["node-feature-discovery"].is_object() {
        runtime["node-feature-discovery"]["enabled"] = json!(false);
    }
    let mut profiles = Map::new();
    for (id, selection) in &config.hardware {
        let family = find(&vendor["hardwareFamilies"], id)?;
        let mode = find(&family["modes"], &selection.mode)?;
        let mut value = json!({"enabled": true});
        merge(&mut value, &mode["values"]);
        if selection.mode == "off" {
            profiles.insert(text(&mode["profileName"]).into(), value);
        } else {
            for tee in &selection.cpu_tees {
                let mut profile = value.clone();
                let tee = find(&vendor["runtime"]["cpuTees"], tee)?;
                let mut selector = tee["nodeSelector"].clone();
                selector
                    .as_object_mut()
                    .unwrap()
                    .remove("nvidia.com/cc.ready.state");
                if !profile["nodeSelector"].is_object() {
                    profile["nodeSelector"] = json!({});
                }
                merge(&mut profile["nodeSelector"], &selector);
                profiles.insert(
                    format!(
                        "{}-{}",
                        text(&mode["profileName"]),
                        text(&tee["id"]).to_uppercase()
                    ),
                    profile,
                );
            }
        }
    }
    runtime["enabled"] = json!(config.components.kata_deploy.unwrap_or(true));
    let deps = &architecture["charts"]["krab"]["dependencies"];
    let mut values = json!({
        "intel-tdx-qgs": {"enabled": qgs}
    });
    values[text(&deps["nvidiaValuesKey"])] = json!({"enabled": gpu || plugin || provisioner});
    values[text(&deps["runtimeValuesKey"])] = runtime;
    values[text(&deps["nfdValuesKey"])] = json!({
        "enabled": config.components.nfd.unwrap_or(true),
        "image": architecture["charts"]["nfd"]["image"]
    });
    let mut plugin_values = vendor["devicePlugin"]["values"].clone();
    plugin_values["enabled"] = json!(plugin);
    values[text(&deps["devicePluginValuesKey"])] = plugin_values;
    let mut provisioner_values = if provisioner || gpu {
        vendor["provisioner"]["values"].clone()
    } else {
        json!({})
    };
    provisioner_values["enabled"] = json!(provisioner);
    if provisioner || gpu {
        provisioner_values["node-feature-discovery"] = json!({"enabled": false});
        provisioner_values["profiles"] = json!(profiles);
    }
    values[text(&deps["provisionerValuesKey"])] = provisioner_values;
    config
        .advanced
        .apply(&mut values, vendor, catalog, &config.distribution)?;
    merge(&mut values, &config.values_overrides);
    validate_schema(
        include_str!("../../charts/krab/values.schema.json"),
        &values,
    )
    .map_err(|e| format!("Generated values do not match the chart schema: {e}"))?;
    Ok(values)
}

pub fn render(config: &Config, catalog: &Value) -> Result<String> {
    let values = build(config, catalog)?;
    let architecture = &catalog["plannedArchitecture"];
    let body = serde_yaml_ng::to_string(&values).map_err(|e| e.to_string())?;
    Ok(format!(
        "# {}\n# KRAB values format: 2\n# KRAB chart version: {}\n# KRAB selection: {}\n{}",
        text(&architecture["notice"]),
        text(&architecture["charts"]["krab"]["version"]),
        config.vendor,
        body
    ))
}
