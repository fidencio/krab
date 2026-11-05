use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub type Result<T> = std::result::Result<T, String>;

pub fn catalog() -> Value {
    serde_json::from_str(include_str!("../../src/generated/catalog.json"))
        .expect("embedded catalog is valid JSON")
}

pub fn validate_schema(schema: &str, value: &Value) -> Result<()> {
    let schema: Value = serde_json::from_str(schema).map_err(|e| e.to_string())?;
    let validator = jsonschema::validator_for(&schema).map_err(|e| e.to_string())?;
    validator.validate(value).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub api_version: String,
    pub vendor: String,
    pub distribution: String,
    #[serde(default = "default_release")]
    pub release: String,
    #[serde(default = "default_namespace")]
    pub namespace: String,
    #[serde(default)]
    pub architectures: Vec<String>,
    #[serde(default)]
    pub selinux: bool,
    #[serde(default)]
    pub runtimes: Vec<String>,
    #[serde(default)]
    pub hardware: BTreeMap<String, Hardware>,
    #[serde(default)]
    pub components: Components,
    #[serde(default)]
    pub runtime: Runtime,
    /// Explicit Helm overrides are schema checked after merging.
    #[serde(default = "empty_object")]
    pub values_overrides: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hardware {
    pub mode: String,
    #[serde(default)]
    pub cpu_tees: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Components {
    pub nfd: Option<bool>,
    pub kata_deploy: Option<bool>,
    pub device_plugin: Option<bool>,
    pub provisioner: Option<bool>,
    pub qgs: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Runtime {
    pub https_proxy: String,
    pub no_proxy: String,
    pub nvidia_dcgm: bool,
    pub erofs_mode: String,
    pub erofs_disk_size: String,
    pub erofs_dmverity: bool,
    pub erofs_fsverity: bool,
    pub install_erofs_utils: bool,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            https_proxy: String::new(),
            no_proxy: String::new(),
            nvidia_dcgm: false,
            erofs_mode: "memory".into(),
            erofs_disk_size: "256M".into(),
            erofs_dmverity: true,
            erofs_fsverity: false,
            install_erofs_utils: false,
        }
    }
}

fn empty_object() -> Value {
    json!({})
}
fn default_release() -> String {
    "krab".into()
}
fn default_namespace() -> String {
    "kata-system".into()
}

pub fn items(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

pub fn find<'a>(values: &'a Value, id: &str) -> Result<&'a Value> {
    items(values)
        .iter()
        .find(|v| v["id"] == id)
        .ok_or_else(|| format!("Unknown choice {id:?}; use 'krab list' to see supported choices"))
}

fn dns_label(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
}

impl Config {
    pub fn parse(source: &str) -> Result<Self> {
        serde_yaml_ng::from_str(source).map_err(|e| format!("Invalid configuration: {e}"))
    }

    pub fn validate<'a>(&self, catalog: &'a Value) -> Result<&'a Value> {
        if self.api_version != "krab/v1alpha1" {
            return Err(format!(
                "Unsupported apiVersion {:?}; expected krab/v1alpha1",
                self.api_version
            ));
        }
        if !dns_label(&self.release, 53) || !dns_label(&self.namespace, 63) {
            return Err(
                "release and namespace must be lowercase DNS labels (maximum 53 and 63 characters)"
                    .into(),
            );
        }
        let vendor = find(&catalog["vendors"], &self.vendor)?;
        find(
            &catalog["plannedArchitecture"]["cluster"]["distributions"],
            &self.distribution,
        )?;
        if !self.values_overrides.is_object() {
            return Err("valuesOverrides must be a mapping".into());
        }
        if !["memory", "disk"].contains(&self.runtime.erofs_mode.as_str()) {
            return Err("runtime.erofsMode must be memory or disk".into());
        }
        if self.runtime.erofs_mode == "disk" && self.runtime.erofs_disk_size.trim().is_empty() {
            return Err("runtime.erofsDiskSize is required in disk mode".into());
        }
        for arch in &self.architectures {
            if !["amd64", "arm64", "ppc64le", "s390x"].contains(&arch.as_str()) {
                return Err(format!("Unknown architecture {arch}"));
            }
        }
        if self.vendor == "custom" && self.architectures.is_empty() {
            return Err("Custom configurations require architectures".into());
        }
        for id in &self.runtimes {
            find(&vendor["runtime"]["shims"], id)?;
        }
        for (id, selection) in &self.hardware {
            let family = find(&vendor["hardwareFamilies"], id)?;
            if family["availability"] != "available" {
                return Err(format!(
                    "Hardware {id} is not available: {}",
                    text(&family["availabilityReason"])
                ));
            }
            if !self.architectures.is_empty()
                && !self
                    .architectures
                    .iter()
                    .any(|a| items(&family["supportedArches"]).contains(&json!(a)))
            {
                return Err(format!(
                    "Hardware {id} does not support the selected architectures"
                ));
            }
            let mode = find(&family["modes"], &selection.mode)?;
            if selection.mode != "off" && selection.cpu_tees.is_empty() {
                return Err(format!(
                    "Hardware {id} mode {} requires cpuTees",
                    selection.mode
                ));
            }
            if selection.mode == "off" && !selection.cpu_tees.is_empty() {
                return Err(format!(
                    "Hardware {id} passthrough mode does not accept cpuTees"
                ));
            }
            for tee in &selection.cpu_tees {
                find(&vendor["runtime"]["cpuTees"], tee)?;
                if !items(&mode["supportedCpuTeeIds"]).contains(&json!(tee)) {
                    return Err(format!(
                        "Hardware {id} mode {} does not support {tee}",
                        selection.mode
                    ));
                }
            }
        }
        let shims = self.shims(vendor)?;
        if self.components.kata_deploy.unwrap_or(true) && shims.is_empty() {
            return Err("Select at least one runtime or hardware profile".into());
        }
        if self.components.kata_deploy.unwrap_or(true) {
            for shim in &shims {
                if !self.architectures.is_empty()
                    && !self
                        .architectures
                        .iter()
                        .any(|a| items(&shim["supportedArches"]).contains(&json!(a)))
                {
                    return Err(format!(
                        "Runtime {} does not support the selected architectures",
                        text(&shim["id"])
                    ));
                }
            }
            for arch in &self.architectures {
                if !shims
                    .iter()
                    .any(|s| items(&s["supportedArches"]).contains(&json!(arch)))
                {
                    return Err(format!("No selected runtime supports {arch}"));
                }
            }
        }
        Ok(vendor)
    }

    pub fn shims<'a>(&self, vendor: &'a Value) -> Result<Vec<&'a Value>> {
        let mut ids = self.runtimes.clone();
        for (id, selection) in &self.hardware {
            let family = find(&vendor["hardwareFamilies"], id)?;
            find(&family["modes"], &selection.mode)?;
            if selection.mode == "off" {
                let base = items(&vendor["runtime"]["shims"])
                    .iter()
                    .find(|s| s["id"] == "qemu-nvidia-gpu-runtime-rs")
                    .ok_or("No NVIDIA passthrough runtime available")?;
                ids.push(text(&base["id"]).into());
            } else {
                for tee in &selection.cpu_tees {
                    ids.push(text(&find(&vendor["runtime"]["cpuTees"], tee)?["shimId"]).into());
                }
            }
        }
        let mut result = Vec::new();
        for id in ids {
            let shim = find(&vendor["runtime"]["shims"], &id)?;
            if !result.contains(&shim) {
                result.push(shim);
            }
        }
        Ok(result)
    }
}
