//! CPU-only NVIDIA profiles derived from the installed, integrity-pinned guest
//! configuration. Used by the node installer and by browser/native tests.
use serde::{Deserialize, Serialize};

pub const TEES: [&str; 2] = ["tdx", "snp"];

pub fn tee_for_runtime(id: &str) -> Option<&str> {
    TEES.into_iter()
        .find(|tee| id == format!("qemu-nvidia-cpu-{tee}-runtime-rs"))
}

pub fn runtime_name(tee: &str) -> Result<String, String> {
    if !TEES.contains(&tee) {
        return Err(format!("Unsupported NVIDIA CPU TEE: {tee}"));
    }
    Ok(format!("qemu-nvidia-cpu-{tee}-runtime-rs"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub name: String,
    pub base_config: String,
    pub drop_in: String,
}

pub fn kernel_params(source: &str) -> Result<Option<String>, String> {
    let data: toml::Value = toml::from_str(source).map_err(|e| e.to_string())?;
    Ok(data
        .get("hypervisor")
        .and_then(|v| v.get("qemu"))
        .and_then(|v| v.get("kernel_params"))
        .and_then(toml::Value::as_str)
        .map(str::to_string))
}

/// Remove DCGM arguments while preserving the other boot arguments and their
/// quoting verbatim. GPU handlers' common drop-ins must not enable it here.
fn without_dcgm(source: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut boundaries = Vec::new();
    for (index, ch) in source.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
        } else if quote.is_none() && ch.is_whitespace() {
            if start < index {
                boundaries.push((start, index));
            }
            start = index + ch.len_utf8();
        }
    }
    if quote.is_some() || escaped {
        return Err("Unterminated reference kernel argument".into());
    }
    if start < source.len() {
        boundaries.push((start, source.len()));
    }
    let mut copied = 0;
    for (start, end) in boundaries {
        if source[start..end]
            .trim_matches(['\'', '"'])
            .starts_with("nvrc.dcgm=")
        {
            output.push_str(&source[copied..start]);
            copied = end;
        }
    }
    output.push_str(&source[copied..]);
    Ok(output.trim().to_string())
}

pub fn derive(
    source: &str,
    tee: &str,
    directory: &str,
    effective_params: Option<&str>,
) -> Result<Derived, String> {
    let name = runtime_name(tee)?;
    if !directory.starts_with('/') || directory.split('/').any(|p| p == "..") {
        return Err("The Kata installation directory must be an absolute path".into());
    }
    let data: toml::Value =
        toml::from_str(source).map_err(|e| format!("Invalid Kata reference TOML: {e}"))?;
    let qemu = data
        .get("hypervisor")
        .and_then(|v| v.get("qemu"))
        .ok_or("Reference has no QEMU configuration")?;
    if qemu
        .get("confidential_guest")
        .and_then(toml::Value::as_bool)
        != Some(true)
        || (qemu.get("sev_snp_guest").and_then(toml::Value::as_bool) == Some(true))
            != (tee == "snp")
    {
        return Err("Reference configuration does not match the requested CPU TEE".into());
    }
    let entries = qemu
        .get("guest_extension_images")
        .and_then(toml::Value::as_array)
        .ok_or("Reference has no guest extension list")?;
    let mut seen = std::collections::BTreeSet::new();
    for entry in entries {
        let fields = entry.as_table().ok_or("Guest extensions must be tables")?;
        let name = fields
            .get("name")
            .and_then(toml::Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or("Guest extension name is missing")?;
        if !seen.insert(name) {
            return Err("Duplicate guest extension name".into());
        }
        if fields
            .keys()
            .any(|k| !["name", "path", "verity_params"].contains(&k.as_str()))
        {
            return Err("Unsupported guest extension fields".into());
        }
        if fields.values().any(|v| !v.is_str()) {
            return Err("Guest extension fields must be strings".into());
        }
        let path = fields
            .get("path")
            .and_then(toml::Value::as_str)
            .ok_or("Guest extension path is missing")?;
        if !path.starts_with('/') {
            return Err("Guest extension path must be absolute".into());
        }
        if name == "coco"
            && fields
                .get("verity_params")
                .and_then(toml::Value::as_str)
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err("CoCo integrity metadata is missing".into());
        }
    }
    if !seen.contains("gpu") || !seen.contains("coco") {
        return Err("Reference must include GPU and CoCo extensions".into());
    }
    let params = effective_params
        .or_else(|| qemu.get("kernel_params").and_then(toml::Value::as_str))
        .ok_or("Reference kernel parameters are missing")?;
    let mut lines = vec![
        "# Managed by KRAB: NVIDIA CPU confidential runtime.".into(),
        "[hypervisor.qemu]".into(),
        format!(
            "kernel_params = {}",
            serde_json::to_string(&without_dcgm(params)?).unwrap()
        ),
    ];
    for entry in entries.iter().filter(|e| e["name"].as_str() != Some("gpu")) {
        lines.push("\n[[hypervisor.qemu.guest_extension_images]]".into());
        for (key, value) in entry.as_table().unwrap() {
            let mut value = value.as_str().unwrap().to_string();
            if key == "path" && directory != "/opt/kata" {
                if let Some(rest) = value.strip_prefix("/opt/kata/") {
                    value = format!("{directory}/{rest}");
                }
            }
            lines.push(format!(
                "{key} = {}",
                serde_json::to_string(&value).unwrap()
            ));
        }
    }
    Ok(Derived {
        name,
        base_config: format!("qemu-nvidia-gpu-{tee}-runtime-rs"),
        drop_in: lines.join("\n") + "\n",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_boot_arguments_and_integrity_while_removing_only_gpu_and_dcgm() {
        let source = "[hypervisor.qemu]\nconfidential_guest=true\nkernel_params='root=verified'\n[[hypervisor.qemu.guest_extension_images]]\nname='gpu'\npath='/opt/kata/gpu.img'\n[[hypervisor.qemu.guest_extension_images]]\nname='coco'\npath='/opt/kata/coco.img'\nverity_params='root_hash=trusted salt=123'\n";
        let derived = derive(
            source,
            "tdx",
            "/custom/opt/kata",
            Some("root=verified debug foo=\"two words\" nvrc.dcgm=on agent.proxy=on"),
        )
        .unwrap();
        let data: toml::Value = toml::from_str(&derived.drop_in).unwrap();
        let q = &data["hypervisor"]["qemu"];
        assert_eq!(
            q["kernel_params"].as_str().unwrap(),
            "root=verified debug foo=\"two words\"  agent.proxy=on"
        );
        assert_eq!(q["guest_extension_images"].as_array().unwrap().len(), 1);
        assert_eq!(
            q["guest_extension_images"][0]["path"].as_str().unwrap(),
            "/custom/opt/kata/coco.img"
        );
        assert_eq!(
            q["guest_extension_images"][0]["verity_params"]
                .as_str()
                .unwrap(),
            "root_hash=trusted salt=123"
        );
        assert!(derive(source, "snp", "/opt/kata", None).is_err());
        assert!(derive(
            &source.replace("root_hash=trusted salt=123", ""),
            "tdx",
            "/opt/kata",
            None
        )
        .is_err());
    }
}
