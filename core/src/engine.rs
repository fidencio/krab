use crate::config::{self, Config, Result};
use crate::{advanced, values};
use serde_json::{json, Value};

pub fn starter(catalog: &Value, vendor_id: &str, distribution: &str, arch: &str) -> Result<Config> {
    let vendor = config::find(&catalog["vendors"], vendor_id)?;
    let shims = config::items(&vendor["runtime"]["shims"]);
    let shim = shims.iter().find(|s| {
        config::items(&s["supportedArches"]).contains(&json!(arch)) &&
            if vendor_id == "custom" { s["id"] == "qemu-runtime-rs" } else { s["userSelectable"] == true || config::items(&vendor["hardwareFamilies"]).is_empty() }
    }).or_else(|| shims.iter().find(|s| config::items(&s["supportedArches"]).contains(&json!(arch)))).ok_or("No starter runtime for this vendor/architecture; use 'krab list runtimes --json' to construct a configuration")?;
    let config: Config = serde_json::from_value(json!({
        "apiVersion": "krab/v1alpha1", "vendor": vendor_id, "distribution": distribution,
        "architectures": [arch], "runtimes": [shim["id"]]
    }))
    .map_err(|e| e.to_string())?;
    let mut config = config;
    if catalog["product"]["defaults"].is_object() {
        let mut value = serde_json::to_value(&config).map_err(|e| e.to_string())?;
        for field in ["advanced", "runtime", "components", "release", "namespace"] {
            value[field] = catalog["product"]["defaults"][field].clone();
        }
        config = serde_json::from_value(value).map_err(|e| e.to_string())?;
    }
    values::build(&config, catalog)?;
    Ok(config)
}

fn website_defaults() -> Result<Value> {
    let runtime = serde_json::to_value(config::Runtime::default()).map_err(|e| e.to_string())?;
    let mut advanced =
        serde_json::to_value(advanced::Advanced::default()).map_err(|e| e.to_string())?;
    advanced["components"] =
        serde_json::to_value(config::Components::default()).map_err(|e| e.to_string())?;
    for (web, native) in [
        ("erofsSnapshotterMode", "erofsMode"),
        ("erofsDiskSize", "erofsDiskSize"),
        ("erofsDmverity", "erofsDmverity"),
        ("erofsEnableFsverity", "erofsFsverity"),
        ("installErofsUtils", "installErofsUtils"),
    ] {
        advanced[web] = runtime[native].clone();
    }
    for component in ["nfd", "devicePlugin", "provisioner"] {
        let image = advanced["images"][component]
            .as_object_mut()
            .expect("image defaults are mappings");
        image.remove("kubectlReference");
        image.remove("kubectlTag");
    }
    Ok(advanced)
}

/// JSON boundary shared by browser clients and direct native engine tests.
pub fn request(source: &str) -> Result<Value> {
    let request: Value = serde_json::from_str(source).map_err(|e| e.to_string())?;
    let embedded = config::catalog();
    let catalog = request.get("catalog").unwrap_or(&embedded);
    match request["operation"].as_str().unwrap_or("generate") {
        "deriveCpuCc" => serde_json::to_value(crate::cpu::derive(
            request["data"]["source"]
                .as_str()
                .ok_or("Reference configuration is missing")?,
            request["data"]["tee"]
                .as_str()
                .ok_or("CPU TEE is missing")?,
            request["data"]["directory"].as_str().unwrap_or("/opt/kata"),
            request["data"]["kernelParams"].as_str(),
        )?)
        .map_err(|e| e.to_string()),
        "catalog" => Ok(embedded),
        "product" => crate::product::apply(catalog, &request["data"]),
        "normalizeProduct" => {
            let config: Config =
                serde_json::from_value(request["config"].clone()).map_err(|e| e.to_string())?;
            let config = crate::product::normalize(&config, catalog)?;
            config.validate(catalog)?;
            serde_json::to_value(config).map_err(|e| e.to_string())
        }
        "defaults" => website_defaults(),
        "schema" => {
            config::validate_schema(
                include_str!("../../charts/krab/values.schema.json"),
                &request["data"],
            )?;
            Ok(Value::Null)
        }
        "version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "preview" | "validate" | "generate" | "render" | "renderPreview" => {
            let config: Config =
                serde_json::from_value(request["config"].clone()).map_err(|e| e.to_string())?;
            if request["operation"] == "render" {
                return Ok(json!(values::render(&config, catalog)?));
            }
            if request["operation"] == "renderPreview" {
                return Ok(json!(values::render_preview(&config, catalog)?));
            }
            if request["operation"] == "preview" {
                values::preview(&config, catalog)
            } else {
                values::build(&config, catalog)
            }
        }
        operation => Err(format!("Unknown engine operation: {operation}")),
    }
}

// A tiny owned-buffer ABI avoids JavaScript glue packages and keeps this Wasm
// model independent of filesystem, shell, and network access. Standard binding
// glue supplies browser randomness used by the shared schema validator.
#[cfg(target_arch = "wasm32")]
mod browser {
    #[no_mangle]
    pub extern "C" fn krab_alloc(length: usize) -> *mut u8 {
        Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
    }

    #[no_mangle]
    pub unsafe extern "C" fn krab_free(pointer: *mut u8, length: usize) {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }

    #[no_mangle]
    pub unsafe extern "C" fn krab_request(pointer: *const u8, length: usize) -> u64 {
        let input = std::slice::from_raw_parts(pointer, length);
        let result = std::str::from_utf8(input)
            .map_err(|e| e.to_string())
            .and_then(super::request);
        let response = match result {
            Ok(value) => serde_json::json!({"value": value}),
            Err(error) => serde_json::json!({"error": error}),
        };
        let bytes = serde_json::to_vec(&response)
            .expect("engine response serializes")
            .into_boxed_slice();
        let length = bytes.len() as u64;
        let pointer = Box::into_raw(bytes) as *mut u8;
        ((pointer as u64) << 32) | length
    }
}
