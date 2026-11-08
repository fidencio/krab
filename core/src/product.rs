//! Product profiles share available choices and deployment policy across clients.
use crate::config::{find, items, text, Config, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    api_version: String,
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    logo: String,
    #[serde(default)]
    theme: Theme,
    #[serde(default)]
    available: Available,
    #[serde(default)]
    features: Features,
    #[serde(default = "mapping")]
    defaults: Value,
}

fn mapping() -> Value {
    json!({})
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Theme {
    light: Palette,
    dark: Palette,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Palette {
    #[serde(skip_serializing_if = "Option::is_none")]
    page_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panel_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    muted_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    accent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    border: Option<String>,
}

impl Theme {
    fn validate(&self) -> Result<()> {
        for (mode, palette) in [("light", &self.light), ("dark", &self.dark)] {
            let value = serde_json::to_value(palette).map_err(|e| e.to_string())?;
            for (field, color) in value.as_object().ok_or("Invalid product palette")? {
                let color = text(color);
                if !matches!(color.len(), 4 | 7)
                    || !color.starts_with('#')
                    || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(format!(
                        "Product theme.{mode}.{field} must be an opaque hex colour (#RGB or #RRGGBB)"
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Available {
    vendors: Option<Vec<String>>,
    runtimes: Option<Vec<String>>,
    distributions: Option<Vec<String>>,
    architectures: Option<Vec<String>>,
    hardware_families: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Features {
    advanced: bool,
    custom_runtimes: bool,
    continuous_conformance: bool,
    new_nodes: bool,
    image_overrides: bool,
    components: bool,
    helm_overrides: bool,
}
impl Default for Features {
    fn default() -> Self {
        Self {
            advanced: true,
            custom_runtimes: true,
            continuous_conformance: true,
            new_nodes: true,
            image_overrides: true,
            components: true,
            helm_overrides: true,
        }
    }
}
fn selected(allowed: &Option<Vec<String>>, id: &str) -> bool {
    allowed
        .as_ref()
        .is_none_or(|list| list.iter().any(|v| v == id))
}
fn retain(value: &mut Value, allowed: &Option<Vec<String>>, key: &str) {
    if let Some(values) = value.as_array_mut() {
        values.retain(|v| selected(allowed, text(&v[key])));
    }
}
fn arches(value: &mut Value, allowed: &Option<Vec<String>>) {
    if let Some(values) = value.as_array_mut() {
        values.retain(|v| selected(allowed, text(v)));
    }
}
fn check_ids(
    name: &str,
    allowed: &Option<Vec<String>>,
    known: &[String],
    empty: bool,
) -> Result<()> {
    if let Some(ids) = allowed {
        if !empty && ids.is_empty() {
            return Err(format!("Product {name} cannot be empty"));
        }
        for (index, id) in ids.iter().enumerate() {
            if !known.contains(id) {
                return Err(format!("Unknown product {name} choice {id:?}"));
            }
            if ids[..index].contains(id) {
                return Err(format!("Duplicate product {name} choice {id:?}"));
            }
        }
    }
    Ok(())
}

/// Apply an operator-owned profile without changing the pinned upstream catalog.
pub fn apply(catalog: &Value, source: &Value) -> Result<Value> {
    let profile: Profile = serde_json::from_value(source.clone())
        .map_err(|e| format!("Invalid product profile: {e}"))?;
    if profile.api_version != "krab/product/v1alpha1" {
        return Err("Unsupported product profile apiVersion".into());
    }
    if profile.id.is_empty()
        || profile.id.len() > 63
        || !profile
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(
            "Product id must contain lowercase letters, digits, or hyphens (maximum 63 characters)"
                .into(),
        );
    }
    if profile.name.trim().is_empty() || profile.name.len() > 100 || profile.description.len() > 500
    {
        return Err(
            "Product name is required (maximum 100 characters); description maximum is 500".into(),
        );
    }
    if !profile.logo.is_empty()
        && (profile.logo.starts_with("//")
            || profile.logo.contains(':') && !profile.logo.starts_with("https://"))
    {
        return Err("Product logo must be an HTTPS URL or a local website asset path".into());
    }
    if !profile.defaults.is_object() {
        return Err("Product defaults must be a configuration mapping".into());
    }
    profile.theme.validate()?;
    let a = &profile.available;
    let vendors = items(&catalog["vendors"]);
    let ids = |field: &str| {
        vendors
            .iter()
            .flat_map(|v| items(&v[field]).iter())
            .map(|v| text(&v["id"]).to_string())
            .collect::<Vec<_>>()
    };
    check_ids(
        "vendors",
        &a.vendors,
        &vendors
            .iter()
            .map(|v| text(&v["id"]).into())
            .collect::<Vec<_>>(),
        false,
    )?;
    check_ids(
        "runtimes",
        &a.runtimes,
        &vendors
            .iter()
            .flat_map(|v| items(&v["runtime"]["shims"]))
            .map(|s| text(&s["id"]).into())
            .collect::<Vec<_>>(),
        false,
    )?;
    check_ids(
        "hardwareFamilies",
        &a.hardware_families,
        &ids("hardwareFamilies"),
        true,
    )?;
    check_ids(
        "distributions",
        &a.distributions,
        &items(&catalog["plannedArchitecture"]["cluster"]["distributions"])
            .iter()
            .map(|v| text(&v["id"]).into())
            .collect::<Vec<_>>(),
        false,
    )?;
    check_ids(
        "architectures",
        &a.architectures,
        &["amd64", "arm64", "ppc64le", "s390x"].map(String::from),
        false,
    )?;
    let mut result = catalog.clone();
    result
        .as_object_mut()
        .ok_or("Catalog must be a mapping")?
        .remove("product");
    retain(
        &mut result["plannedArchitecture"]["cluster"]["distributions"],
        &a.distributions,
        "id",
    );
    retain(&mut result["vendors"], &a.vendors, "id");
    for vendor in result["vendors"]
        .as_array_mut()
        .ok_or("Catalog vendors must be an array")?
    {
        retain(&mut vendor["runtime"]["shims"], &a.runtimes, "id");
        for shim in vendor["runtime"]["shims"]
            .as_array_mut()
            .ok_or("Catalog runtimes must be an array")?
        {
            arches(&mut shim["supportedArches"], &a.architectures);
        }
        vendor["runtime"]["shims"]
            .as_array_mut()
            .unwrap()
            .retain(|s| !items(&s["supportedArches"]).is_empty());
        let runtime_ids: Vec<_> = items(&vendor["runtime"]["shims"])
            .iter()
            .map(|s| text(&s["id"]).to_string())
            .collect();
        if let Some(tees) = vendor["runtime"]["cpuTees"].as_array_mut() {
            tees.retain(|tee| runtime_ids.iter().any(|id| id == text(&tee["shimId"])));
        }
        let tees: Vec<_> = items(&vendor["runtime"]["cpuTees"])
            .iter()
            .map(|t| text(&t["id"]).to_string())
            .collect();
        retain(&mut vendor["hardwareFamilies"], &a.hardware_families, "id");
        if let Some(families) = vendor["hardwareFamilies"].as_array_mut() {
            for family in families.iter_mut() {
                arches(&mut family["supportedArches"], &a.architectures);
                if let Some(modes) = family["modes"].as_array_mut() {
                    for mode in modes.iter_mut() {
                        if let Some(cpu_tees) = mode["supportedCpuTeeIds"].as_array_mut() {
                            cpu_tees.retain(|t| tees.iter().any(|id| id == text(t)));
                        }
                    }
                    modes.retain(|m| {
                        if m["id"] == "off" {
                            runtime_ids
                                .iter()
                                .any(|id| id == "qemu-nvidia-gpu-runtime-rs")
                        } else {
                            !items(&m["supportedCpuTeeIds"]).is_empty()
                        }
                    });
                }
            }
            families.retain(|f| {
                !items(&f["supportedArches"]).is_empty() && !items(&f["modes"]).is_empty()
            });
        }
    }
    result["vendors"]
        .as_array_mut()
        .unwrap()
        .retain(|v| !items(&v["runtime"]["shims"]).is_empty());
    let vendor = items(&result["vendors"])
        .iter()
        .find(|v| v["id"] == profile.defaults["vendor"])
        .or_else(|| {
            items(&result["vendors"])
                .iter()
                .find(|v| v["id"] == "custom")
        })
        .or_else(|| items(&result["vendors"]).first())
        .ok_or("Product profile leaves no compatible runtime choices")?;
    let distribution = profile.defaults["distribution"]
        .as_str()
        .unwrap_or_else(|| {
            text(&result["plannedArchitecture"]["cluster"]["distributions"][0]["id"])
        });
    let arch = profile.defaults["architectures"][0]
        .as_str()
        .unwrap_or_else(|| text(&vendor["runtime"]["shims"][0]["supportedArches"][0]));
    let mut defaults = serde_json::to_value(crate::starter(
        &result,
        text(&vendor["id"]),
        distribution,
        arch,
    )?)
    .map_err(|e| e.to_string())?;
    crate::values::merge(&mut defaults, &profile.defaults);
    let config: Config = serde_json::from_value(defaults.clone())
        .map_err(|e| format!("Invalid product defaults: {e}"))?;
    crate::values::build(&config, &result).map_err(|e| format!("Invalid product defaults: {e}"))?;
    if config
        .values_overrides
        .as_object()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(
            "Product defaults use typed settings; raw Helm valuesOverrides are not supported"
                .into(),
        );
    }
    result["plannedArchitecture"]["namespace"] = json!(config.namespace);
    result["plannedArchitecture"]["charts"]["krab"]["releaseName"] = json!(config.release);
    let restricted = !profile.features.advanced
        || !profile.features.custom_runtimes
        || !profile.features.continuous_conformance
        || !profile.features.new_nodes
        || !profile.features.image_overrides
        || !profile.features.components
        || !profile.features.helm_overrides
        || a.vendors.is_some()
        || a.runtimes.is_some()
        || a.architectures.is_some()
        || a.distributions.is_some()
        || a.hardware_families.is_some();
    result["product"] = json!({"id": profile.id, "name": profile.name, "description": profile.description,
        "logo": profile.logo, "theme": profile.theme, "features": profile.features, "defaults": defaults,
        "applyDefaults": profile.defaults.as_object().is_some_and(|v| !v.is_empty()),
        "architectures": a.architectures, "restricted": restricted,
        "attribution": "Powered by KRAB", "attributionUrl": "https://github.com/kata-containers/krab"});
    validate(&config, &result)?;
    Ok(result)
}

pub fn enabled(catalog: &Value, feature: &str) -> bool {
    catalog["product"]["features"][feature] != false
}

/// Disabled features are fixed at the operator's defaults, including imported files.
pub fn normalize(config: &Config, catalog: &Value) -> Result<Config> {
    let product = &catalog["product"];
    if !product.is_object() {
        return Ok(config.clone());
    }
    if let Some(allowed) = product["architectures"].as_array() {
        if config
            .architectures
            .iter()
            .any(|a| !allowed.contains(&json!(a)))
        {
            return Err("Architecture is disabled by this product profile".into());
        }
    }
    let mut current = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let defaults = &product["defaults"];
    for (feature, paths) in [
        ("advanced", &["/advanced", "/runtime", "/components"][..]),
        ("customRuntimes", &["/advanced/customRuntimes"][..]),
        (
            "continuousConformance",
            &["/advanced/continuousConformance"][..],
        ),
        (
            "newNodes",
            &[
                "/advanced/scheduledReconcileEnabled",
                "/advanced/scheduledReconcileSchedule",
            ][..],
        ),
        (
            "imageOverrides",
            &["/advanced/images", "/advanced/erofsUtilsImage"][..],
        ),
        ("components", &["/components"][..]),
        ("helmOverrides", &["/valuesOverrides"][..]),
    ] {
        if !enabled(catalog, feature)
            && paths
                .iter()
                .any(|p| current.pointer(p) != defaults.pointer(p))
        {
            let mut fixed = current.clone();
            for path in paths {
                *fixed
                    .pointer_mut(path)
                    .ok_or("Invalid product setting path")? = defaults
                    .pointer(path)
                    .ok_or("Invalid product defaults")?
                    .clone();
            }
            let before: Config =
                serde_json::from_value(current.clone()).map_err(|e| e.to_string())?;
            let after: Config = serde_json::from_value(fixed.clone()).map_err(|e| e.to_string())?;
            // Reuse generation to compare effective settings. An explicit image pin
            // or component boolean can be identical to an automatic default.
            if crate::values::preview(&before, catalog)? != crate::values::preview(&after, catalog)?
            {
                return Err(format!("{feature} is fixed by this product profile"));
            }
            current = fixed;
        }
    }
    if product["restricted"] == true
        && config
            .values_overrides
            .as_object()
            .is_some_and(|v| !v.is_empty())
    {
        return Err("Helm overrides cannot bypass product profile restrictions".into());
    }
    find(&catalog["vendors"], &config.vendor)?;
    serde_json::from_value(current).map_err(|e| e.to_string())
}

pub fn validate(config: &Config, catalog: &Value) -> Result<()> {
    normalize(config, catalog).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Value {
        json!({
            "apiVersion": "krab/product/v1alpha1", "id": "coco-example", "name": "CoCo example",
            "available": {"vendors": ["custom"], "runtimes": ["qemu-coco-dev-runtime-rs"], "architectures": ["amd64"], "hardwareFamilies": []},
            "features": {"customRuntimes": false, "imageOverrides": false, "helmOverrides": false},
            "defaults": {"distribution": "microk8s", "release": "coco"}
        })
    }
    #[test]
    fn profile_filters_choices_and_defaults_without_mutating_the_upstream_catalog() {
        let source = crate::config::catalog();
        let original = source.clone();
        let applied = apply(&source, &profile()).unwrap();
        assert_eq!(source, original);
        assert_eq!(items(&applied["vendors"]).len(), 1);
        assert_eq!(items(&applied["vendors"][0]["runtime"]["shims"]).len(), 1);
        assert!(items(&applied["vendors"][0]["hardwareFamilies"]).is_empty());
        assert_eq!(
            applied["product"]["defaults"]["runtimes"],
            json!(["qemu-coco-dev-runtime-rs"])
        );
        assert_eq!(applied["product"]["defaults"]["release"], "coco");
        let defaults: Config =
            serde_json::from_value(applied["product"]["defaults"].clone()).unwrap();
        crate::values::build(&defaults, &applied).unwrap();
    }
    #[test]
    fn imported_configurations_cannot_restore_disabled_choices_features_or_helm_overrides() {
        let applied = apply(&crate::config::catalog(), &profile()).unwrap();
        let baseline: Config =
            serde_json::from_value(applied["product"]["defaults"].clone()).unwrap();
        let mut changed = baseline.clone();
        changed.runtimes = vec!["qemu-runtime-rs".into()];
        assert!(crate::values::build(&changed, &applied).is_err());
        changed = baseline.clone();
        changed.architectures = vec!["arm64".into()];
        assert!(crate::values::build(&changed, &applied).is_err());
        changed = baseline.clone();
        changed.values_overrides =
            json!({"kata-deploy": {"shims": {"qemu-runtime-rs": {"enabled": true}}}});
        assert!(crate::values::build(&changed, &applied).is_err());
        let mut value = serde_json::to_value(&baseline).unwrap();
        value["advanced"]["images"]["kataDeploy"]["tag"] = json!("other");
        assert!(crate::values::build(&serde_json::from_value(value).unwrap(), &applied).is_err());
    }
    #[test]
    fn explicit_default_images_and_component_booleans_normalize_for_editing() {
        let mut source = profile();
        source["features"]["components"] = json!(false);
        let catalog = apply(&crate::config::catalog(), &source).unwrap();
        let baseline: Config =
            serde_json::from_value(catalog["product"]["defaults"].clone()).unwrap();
        let values = crate::values::build(&baseline, &catalog).unwrap();
        let mut expanded = serde_json::to_value(&baseline).unwrap();
        expanded["components"]["nfd"] = json!(true);
        expanded["advanced"]["images"]["kataDeploy"]["reference"] =
            values["kata-deploy"]["image"]["reference"].clone();
        expanded["advanced"]["images"]["kataDeploy"]["tag"] =
            values["kata-deploy"]["image"]["tag"].clone();
        let expanded: Config = serde_json::from_value(expanded).unwrap();
        assert_eq!(normalize(&expanded, &catalog).unwrap(), baseline);
        crate::values::build(&expanded, &catalog).unwrap();
    }

    #[test]
    fn theme_is_validated_without_changing_deployments() {
        let source = crate::config::catalog();
        let baseline = apply(&source, &profile()).unwrap();
        let mut themed = profile();
        themed["theme"] = json!({"light": {"pageBackground": "#fefefe", "accent": "#369"},
            "dark": {"panelBackground": "#182030", "text": "#eee"}});
        let applied = apply(&source, &themed).unwrap();
        assert_eq!(applied["product"]["theme"], themed["theme"]);
        let config = serde_json::from_value(baseline["product"]["defaults"].clone()).unwrap();
        assert_eq!(
            crate::values::build(&config, &baseline).unwrap(),
            crate::values::build(&config, &applied).unwrap()
        );
        for invalid in [
            json!({"light": {"accent": "red"}}),
            json!({"light": {"accent": "#ffffff00"}}),
            json!({"dark": {"text": "url(https://example.com)"}}),
            json!({"dark": {"pageBackground": "#gggggg"}}),
            json!({"light": {"typo": "#fff"}}),
            json!({"typo": {}}),
        ] {
            themed["theme"] = invalid;
            assert!(apply(&source, &themed).is_err());
        }
    }
    #[test]
    fn profile_typos_empty_products_and_invalid_defaults_fail_closed() {
        for change in [
            json!({"available": {"runtimes": ["typo"]}}),
            json!({"available": {"vendors": []}}),
            json!({"features": {"typo": false}}),
            json!({"defaults": {"vendor": "unknown"}}),
            json!({"defaults": {"advanced": {"debugg": true}}}),
            json!({"attribution": "hide"}),
            json!({"logo": "javascript:alert(1)"}),
        ] {
            let mut p = profile();
            crate::values::merge(&mut p, &change);
            assert!(apply(&crate::config::catalog(), &p).is_err(), "{p}");
        }
    }
}
