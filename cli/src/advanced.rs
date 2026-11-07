//! Advanced website settings. Keep generation covered by CLI/web parity fixtures.
use crate::config::{find, text, Result};
use crate::values::merge;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Advanced {
    pub qgs: Qgs,
    pub containerd_config_dir: String,
    pub containerd_runtime_socket: String,
    pub containerd_config_file_name: String,
    pub containerd_user_drop_in: String,
    pub shim_drop_ins: BTreeMap<String, String>,
    pub custom_runtimes: Vec<CustomRuntime>,
    pub erofs_utils_image: String,
    pub node_selector: Vec<Selector>,
    pub node_affinity: Vec<Affinity>,
    pub tolerations: Vec<Toleration>,
    pub scheduled_reconcile_enabled: bool,
    pub scheduled_reconcile_schedule: String,
    pub images: Images,
    pub debug: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Qgs {
    mode: String,
    pcs_api_key_secret_name: String,
    deploy_sgx_plugin: Option<bool>,
}
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Images {
    kata_deploy: Image,
    nfd: Image,
    device_plugin: Image,
    provisioner: Image,
}
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Image {
    pull_policy: String,
    pull_secrets: Vec<String>,
    reference: String,
    tag: String,
    dispatcher_reference: String,
    dispatcher_tag: String,
    kubectl_reference: String,
    kubectl_tag: String,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomRuntime {
    pub name: String,
    pub base_config: String,
    pub drop_in: String,
    pub runtime_class: String,
    pub crio_pull_type: Option<String>,
    pub inherit_base_overhead: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    key: String,
    value: String,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Affinity {
    key: String,
    operator: String,
    values: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Toleration {
    key: String,
    operator: String,
    value: String,
    effect: String,
}

impl Advanced {
    pub fn validate(&self, vendor: &Value) -> Result<()> {
        let mut names = std::collections::BTreeSet::new();
        for custom in &self.custom_runtimes {
            let name = custom.name.trim();
            if name.is_empty()
                || name.len() > 63
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || name.starts_with('-')
                || name.ends_with('-')
                || !names.insert(name)
            {
                return Err(format!("Invalid or duplicate custom runtime name: {name}"));
            }
            find(&vendor["runtime"]["shims"], &custom.base_config)?;
        }
        if !["", "Online", "Offline", "External"].contains(&self.qgs.mode.as_str()) {
            return Err("QGS mode must be Online, Offline, or External".into());
        }
        for affinity in &self.node_affinity {
            if !["In", "NotIn", "Exists", "DoesNotExist"].contains(&affinity.operator.as_str()) {
                return Err("Invalid node affinity operator".into());
            }
        }
        for toleration in &self.tolerations {
            if !["Exists", "Equal"].contains(&toleration.operator.as_str())
                || !["", "NoSchedule", "PreferNoSchedule", "NoExecute"]
                    .contains(&toleration.effect.as_str())
            {
                return Err("Invalid toleration operator or effect".into());
            }
        }
        Ok(())
    }

    pub fn snapshotter<'a>(&self, custom: &CustomRuntime, vendor: &'a Value) -> Result<&'a str> {
        let snapshotter =
            text(&find(&vendor["runtime"]["shims"], &custom.base_config)?["snapshotter"]);
        Ok(if snapshotter == "default" {
            ""
        } else {
            snapshotter
        })
    }

    pub fn apply(
        &self,
        values: &mut Value,
        vendor: &Value,
        catalog: &Value,
        distribution: &str,
    ) -> Result<()> {
        let deps = &catalog["plannedArchitecture"]["charts"]["krab"]["dependencies"];
        let runtime = &mut values[text(&deps["runtimeValuesKey"])];
        runtime["debug"] = json!(self.debug);
        let generated = text(&runtime["containerd"]["userDropIn"]);
        let drop_in = if !generated.is_empty() && !self.containerd_user_drop_in.trim().is_empty() {
            format!(
                "{}\n\n{}",
                generated.trim_end(),
                self.containerd_user_drop_in
            )
        } else if !self.containerd_user_drop_in.trim().is_empty() {
            self.containerd_user_drop_in.clone()
        } else {
            generated.to_string()
        };
        if distribution == "kubeadm" {
            for (key, value) in [
                ("configDir", &self.containerd_config_dir),
                ("runtimeSocket", &self.containerd_runtime_socket),
                ("configFileName", &self.containerd_config_file_name),
            ] {
                if !value.trim().is_empty() {
                    merge(runtime, &json!({"containerd": {key: value.trim()}}));
                }
            }
            if !drop_in.is_empty() {
                merge(runtime, &json!({"containerd": {"userDropIn": drop_in}}));
            }
        }
        for (id, drop_in) in &self.shim_drop_ins {
            if runtime["shims"][id]["enabled"] == true && !drop_in.trim().is_empty() {
                runtime["shims"][id]["dropIn"] = json!(drop_in);
            }
        }
        if !self.custom_runtimes.is_empty() {
            let mut custom_values = json!({});
            for custom in &self.custom_runtimes {
                let base = &custom.base_config;
                if runtime["shims"][base].is_null() {
                    runtime["shims"][base] =
                        vendor["runtime"]["chart"]["values"]["shims"][base].clone();
                    runtime["shims"][base]["enabled"] = json!(false);
                }
                let mut value = json!({"baseConfig": base, "runtimeClass": custom.runtime_class,
                    "containerd": {"snapshotter": self.snapshotter(custom, vendor)?}});
                if !custom.drop_in.trim().is_empty() {
                    value["dropIn"] = json!(custom.drop_in);
                }
                if let Some(inherit) = custom.inherit_base_overhead {
                    value["inheritBaseOverhead"] = json!(inherit);
                }
                if let Some(pull) = &custom.crio_pull_type {
                    value["crio"] = json!({"pullType": pull});
                }
                custom_values[custom.name.trim()] = value;
            }
            runtime["customRuntimes"] = json!({"enabled": true, "runtimes": custom_values});
        }
        let selector: serde_json::Map<String, Value> = self
            .node_selector
            .iter()
            .filter(|s| !s.key.trim().is_empty())
            .map(|s| (s.key.trim().into(), json!(s.value.trim())))
            .collect();
        if !selector.is_empty() {
            runtime["nodeSelector"] = json!(selector);
        }
        let affinity: Vec<_> = self
            .node_affinity
            .iter()
            .filter(|s| !s.key.trim().is_empty())
            .map(|s| {
                let mut value = json!({"key": s.key.trim(), "operator": s.operator});
                if ["In", "NotIn"].contains(&s.operator.as_str()) {
                    value["values"] = json!(s
                        .values
                        .iter()
                        .map(|v| v.trim())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>());
                }
                value
            })
            .collect();
        if !affinity.is_empty() {
            runtime["affinity"] = json!({"nodeAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": {"nodeSelectorTerms": [{"matchExpressions": affinity}]}}});
        }
        let tolerations: Vec<_> = self
            .tolerations
            .iter()
            .filter(|s| !s.key.trim().is_empty())
            .map(|s| {
                let mut value = json!({"key": s.key.trim(), "operator": s.operator});
                if s.operator == "Equal" {
                    value["value"] = json!(s.value.trim());
                }
                if !s.effect.is_empty() {
                    value["effect"] = json!(s.effect);
                }
                value
            })
            .collect();
        if !tolerations.is_empty() {
            runtime["tolerations"] = json!(tolerations);
        }
        if self.scheduled_reconcile_enabled {
            let schedule = self.scheduled_reconcile_schedule.trim();
            merge(
                runtime,
                &json!({"job": {"reconcile": {"enabled": true, "schedule": if schedule.is_empty() { "*/15 * * * *" } else { schedule }}}}),
            );
        }
        self.images.kata_deploy.apply(runtime, "reference", true);
        let qgs = &mut values["intel-tdx-qgs"];
        if !self.qgs.mode.is_empty() {
            qgs["tdxQuoteGenerationService"] = json!({"mode": self.qgs.mode});
        }
        if !self.qgs.pcs_api_key_secret_name.trim().is_empty() {
            qgs["pcsApiKey"] = json!({"secretName": self.qgs.pcs_api_key_secret_name.trim()});
        }
        if let Some(enabled) = self.qgs.deploy_sgx_plugin {
            qgs["intel-sgx-plugin"] = json!({"enabled": enabled});
        }
        self.images.nfd.apply(
            &mut values[text(&deps["nfdValuesKey"])],
            "repository",
            false,
        );
        self.images.device_plugin.apply(
            &mut values[text(&deps["devicePluginValuesKey"])],
            "repository",
            false,
        );
        let provisioner = &mut values[text(&deps["provisionerValuesKey"])];
        if provisioner["enabled"] == true || provisioner["profiles"].is_object() {
            self.images
                .provisioner
                .apply(provisioner, "reference", true);
        }
        Ok(())
    }
}

impl Image {
    fn apply(&self, target: &mut Value, reference_key: &str, top_policy: bool) {
        for (key, value) in [(reference_key, &self.reference), ("tag", &self.tag)] {
            if !value.trim().is_empty() {
                merge(target, &json!({"image": {key: value.trim()}}));
            }
        }
        if !self.pull_policy.is_empty() {
            merge(
                target,
                &if top_policy {
                    json!({"imagePullPolicy": self.pull_policy})
                } else {
                    json!({"image": {"pullPolicy": self.pull_policy}})
                },
            );
        }
        let secrets: Vec<_> = self
            .pull_secrets
            .iter()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(|v| json!({"name": v}))
            .collect();
        if !secrets.is_empty() {
            target["imagePullSecrets"] = json!(secrets);
        }
        if top_policy {
            for (key, value) in [
                ("reference", &self.kubectl_reference),
                ("tag", &self.kubectl_tag),
            ] {
                if !value.trim().is_empty() {
                    merge(target, &json!({"kubectlImage": {key: value.trim()}}));
                }
            }
            for (key, value) in [
                ("reference", &self.dispatcher_reference),
                ("tag", &self.dispatcher_tag),
            ] {
                if !value.trim().is_empty() {
                    merge(
                        target,
                        &json!({"job": {"dispatcherImage": {key: value.trim()}}}),
                    );
                }
            }
        }
    }
}
