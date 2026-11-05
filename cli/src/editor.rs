use crate::config::{find, items, text, Config, Hardware, Result};
use crate::values;
use serde_json::{json, Value};
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

pub(super) struct Choice {
    pub(super) id: String,
    pub(super) label: String,
}

impl Choice {
    fn catalog(value: &Value) -> Self {
        let id = text(&value["id"]).to_string();
        let label = text(&value["displayName"]);
        Self {
            label: if label.is_empty() || label == id {
                id.clone()
            } else {
                format!("{label} ({id})")
            },
            id,
        }
    }
}

struct Prompts<R, W> {
    input: R,
    output: W,
    history: Vec<String>,
    cursor: usize,
    previous: Option<String>,
}

const BACK: &str = "\0wizard-back";
const CANCEL: &str = "\0wizard-cancel";

impl<R: BufRead, W: Write> Prompts<R, W> {
    fn say(&mut self, message: &str) -> Result<()> {
        if self.cursor < self.history.len() {
            return Ok(());
        }
        writeln!(self.output, "{message}").map_err(|e| e.to_string())
    }

    fn answer(&mut self, label: &str, default: &str) -> Result<String> {
        if self.cursor < self.history.len() {
            let answer = self.history[self.cursor].clone();
            self.cursor += 1;
            return Ok(answer);
        }
        let default = self.previous.take().unwrap_or_else(|| default.into());
        loop {
            write!(self.output, "{label} [{default}]: ").map_err(|e| e.to_string())?;
            self.output.flush().map_err(|e| e.to_string())?;
            let mut line = String::new();
            if self.input.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("Setup cancelled: input ended; no configuration written".into());
            }
            if self.navigation(line.trim())? {
                continue;
            }
            let answer = if line.trim().is_empty() {
                default.clone()
            } else {
                line.trim().into()
            };
            self.history.push(answer.clone());
            self.cursor += 1;
            return Ok(answer);
        }
    }

    fn navigation(&mut self, answer: &str) -> Result<bool> {
        match answer.to_lowercase().as_str() {
            "q" | "quit" => Err(CANCEL.into()),
            "back" | ":back" => {
                if let Some(previous) = self.history.pop() {
                    self.previous = Some(previous);
                    self.cursor = 0;
                    Err(BACK.into())
                } else {
                    self.say("You are at the first question.")?;
                    Ok(true)
                }
            }
            "?" => {
                self.say("Enter back to revisit the previous question, Enter to keep the displayed answer, or q to cancel. Changes are saved only after confirmation.")?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn retry(&mut self) {
        self.history.pop();
        self.cursor = self.history.len();
    }

    fn select(
        &mut self,
        label: &str,
        choices: &[Choice],
        default: &[String],
        multiple: bool,
        optional: bool,
    ) -> Result<Vec<String>> {
        if choices.is_empty() {
            return Ok(Vec::new());
        }
        self.say(&format!("\n{label}"))?;
        for (index, choice) in choices.iter().enumerate() {
            let marker = if multiple {
                if default.contains(&choice.id) {
                    "[x] "
                } else {
                    "[ ] "
                }
            } else {
                ""
            };
            self.say(&format!("  {}) {marker}{}", index + 1, choice.label))?;
        }
        let default = if default.is_empty() && optional {
            "none".into()
        } else {
            default.join(",")
        };
        loop {
            let answer = self.answer(
                if multiple {
                    "Choose numbers or IDs, separated by commas"
                } else {
                    "Choose a number or ID"
                },
                &default,
            )?;
            if optional && answer.eq_ignore_ascii_case("none") {
                return Ok(Vec::new());
            }
            let mut selected = Vec::new();
            let mut valid = true;
            for entry in answer.split(',').map(str::trim) {
                let choice = choices.iter().find(|c| c.id == entry).or_else(|| {
                    entry
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| i.checked_sub(1))
                        .and_then(|i| choices.get(i))
                });
                if let Some(choice) = choice {
                    if !selected.contains(&choice.id) {
                        selected.push(choice.id.clone());
                    }
                } else {
                    valid = false;
                }
            }
            if valid && !selected.is_empty() && (multiple || selected.len() == 1) {
                return Ok(selected);
            }
            self.retry();
            self.say(if multiple {
                "Choose from the listed options; separate multiple choices with commas."
            } else {
                "Choose exactly one of the listed options."
            })?;
        }
    }

    fn yes_no(&mut self, label: &str, default: bool) -> Result<bool> {
        loop {
            match self
                .answer(label, if default { "yes" } else { "no" })?
                .to_lowercase()
                .as_str()
            {
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => {
                    self.retry();
                    self.say("Enter yes or no.")?;
                }
            }
        }
    }

    fn name(&mut self, label: &str, default: &str, limit: usize) -> Result<String> {
        loop {
            let name = self.answer(label, default)?;
            if !name.is_empty()
                && name.len() <= limit
                && name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && name.as_bytes()[0].is_ascii_alphanumeric()
                && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
            {
                return Ok(name);
            }
            self.retry();
            self.say(&format!("Use 1–{limit} lowercase letters, numbers, or hyphens; start and end with a letter or number."))?;
        }
    }

    fn advanced(&mut self, config: &mut Config) -> Result<()> {
        let sections = [
            Choice {
                id: "components".into(),
                label: "Component installation (automatic/enabled/disabled)".into(),
            },
            Choice {
                id: "runtime".into(),
                label: "Runtime proxies, NVIDIA DCGM, and EROFS settings".into(),
            },
            Choice {
                id: "overrides".into(),
                label: "Advanced Helm values overrides (YAML)".into(),
            },
        ];
        let selected = self.select(
            "Advanced settings",
            &sections,
            &["components".into()],
            true,
            false,
        )?;
        if selected.iter().any(|s| s == "components") {
            let choices = [
                Choice {
                    id: "auto".into(),
                    label: "Automatic".into(),
                },
                Choice {
                    id: "enabled".into(),
                    label: "Enabled".into(),
                },
                Choice {
                    id: "disabled".into(),
                    label: "Disabled".into(),
                },
            ];
            for (label, value) in [
                ("Node Feature Discovery", &mut config.components.nfd),
                ("Kata deploy", &mut config.components.kata_deploy),
                ("Kata device plugin", &mut config.components.device_plugin),
                (
                    "Kata device provisioner",
                    &mut config.components.provisioner,
                ),
                ("TDX QGS", &mut config.components.qgs),
            ] {
                let default = match value {
                    Some(true) => "enabled",
                    Some(false) => "disabled",
                    None => "auto",
                };
                let answer = self.select(label, &choices, &[default.into()], false, false)?;
                *value = match answer[0].as_str() {
                    "enabled" => Some(true),
                    "disabled" => Some(false),
                    _ => None,
                };
            }
        }
        if selected.iter().any(|s| s == "runtime") {
            let runtime = &mut config.runtime;
            runtime.https_proxy = self.string("HTTPS proxy (- to clear)", &runtime.https_proxy)?;
            runtime.no_proxy = self.string("No-proxy hosts (- to clear)", &runtime.no_proxy)?;
            runtime.nvidia_dcgm = self.yes_no("Enable NVIDIA DCGM?", runtime.nvidia_dcgm)?;
            let modes = [
                Choice {
                    id: "memory".into(),
                    label: "Memory".into(),
                },
                Choice {
                    id: "disk".into(),
                    label: "Disk".into(),
                },
            ];
            runtime.erofs_mode = self
                .select(
                    "EROFS snapshotter mode",
                    &modes,
                    std::slice::from_ref(&runtime.erofs_mode),
                    false,
                    false,
                )?
                .remove(0);
            if runtime.erofs_mode == "disk" {
                runtime.erofs_disk_size =
                    self.answer("EROFS disk size", &runtime.erofs_disk_size)?;
            }
            runtime.erofs_dmverity =
                self.yes_no("Enable EROFS dm-verity?", runtime.erofs_dmverity)?;
            runtime.erofs_fsverity =
                self.yes_no("Enable EROFS fs-verity?", runtime.erofs_fsverity)?;
            runtime.install_erofs_utils =
                self.yes_no("Install EROFS utilities?", runtime.install_erofs_utils)?;
        }
        if selected.iter().any(|s| s == "overrides") {
            self.overrides(&mut config.values_overrides)?;
        }
        Ok(())
    }

    fn string(&mut self, label: &str, default: &str) -> Result<String> {
        let value = self.answer(label, default)?;
        Ok(if value == "-" { String::new() } else { value })
    }

    fn overrides(&mut self, value: &mut Value) -> Result<()> {
        self.say(&format!(
            "Current chart overrides:\n{}",
            serde_yaml_ng::to_string(value).map_err(|e| e.to_string())?
        ))?;
        loop {
            let source = self.yaml_answer()?;
            if source.trim().is_empty() {
                return Ok(());
            }
            if source.trim() == "none" {
                *value = json!({});
                return Ok(());
            }
            match serde_yaml_ng::from_str::<Value>(&source) {
                Ok(replacement) if replacement.is_object() => {
                    *value = replacement;
                    return Ok(());
                }
                Ok(_) => {
                    self.retry();
                    self.say("Chart overrides must be a YAML mapping.")?;
                }
                Err(error) => {
                    self.retry();
                    self.say(&format!("Invalid YAML: {error}"))?;
                }
            }
        }
    }

    fn yaml_answer(&mut self) -> Result<String> {
        if self.cursor < self.history.len() {
            let answer = self.history[self.cursor].clone();
            self.cursor += 1;
            return Ok(answer);
        }
        let previous = self.previous.take().unwrap_or_default();
        if !previous.is_empty() {
            self.say(&format!(
                "Previous YAML entry (empty block keeps it):\n{previous}"
            ))?;
        }
        self.say("Enter replacement YAML, then a line containing only '.'. An empty block keeps the current overrides; 'none' clears them. Enter back to return to the previous question, or q to cancel.")?;
        self.output.flush().map_err(|e| e.to_string())?;
        let mut source = String::new();
        loop {
            let mut line = String::new();
            if self.input.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("Setup cancelled: input ended; no configuration written".into());
            }
            if self.navigation(line.trim())? {
                continue;
            }
            if line.trim_end() == "." {
                break;
            }
            source.push_str(&line);
        }
        if source.trim().is_empty() {
            source = previous;
        }
        self.history.push(source.clone());
        self.cursor += 1;
        Ok(source)
    }
}

pub(super) fn compatible(value: &Value, arches: &[String]) -> bool {
    arches
        .iter()
        .any(|a| items(&value["supportedArches"]).contains(&json!(a)))
}

pub(super) fn compatible_tees(
    mode: &Value,
    family: &Value,
    vendor: &Value,
    arches: &[String],
) -> Vec<Choice> {
    items(&vendor["runtime"]["cpuTees"])
        .iter()
        .filter(|tee| {
            items(&mode["supportedCpuTeeIds"]).contains(&tee["id"])
                && find(&vendor["runtime"]["shims"], text(&tee["shimId"])).is_ok_and(|shim| {
                    arches.iter().any(|a| {
                        items(&family["supportedArches"]).contains(&json!(a))
                            && items(&shim["supportedArches"]).contains(&json!(a))
                    })
                })
        })
        .map(Choice::catalog)
        .collect()
}

pub(super) fn modes(family: &Value, vendor: &Value, arches: &[String]) -> Vec<Choice> {
    items(&family["modes"])
        .iter()
        .filter(|mode| {
            if mode["id"] == "off" {
                find(&vendor["runtime"]["shims"], "qemu-nvidia-gpu-runtime-rs")
                    .is_ok_and(|shim| compatible(shim, arches))
            } else {
                !compatible_tees(mode, family, vendor, arches).is_empty()
            }
        })
        .map(Choice::catalog)
        .collect()
}

#[derive(Clone, Copy)]
pub struct Defaults<'a> {
    pub vendor: &'a str,
    pub distribution: &'a str,
    pub architecture: &'a str,
    pub path: &'a Path,
    pub existing: Option<&'a Config>,
    pub original_path: Option<&'a Path>,
    pub force: bool,
    pub advanced: bool,
}

impl<R: BufRead, W: Write> Prompts<R, W> {
    fn reset(&mut self) {
        self.history.clear();
        self.cursor = 0;
        self.previous = None;
    }

    fn replay<T>(&mut self, mut operation: impl FnMut(&mut Self) -> Result<T>) -> Result<T> {
        self.reset();
        loop {
            match operation(self) {
                Err(error) if error == BACK => continue,
                result => return result,
            }
        }
    }
}

pub fn run<R: BufRead, W: Write>(
    catalog: &Value,
    defaults: Defaults<'_>,
    input: R,
    output: W,
) -> Result<Option<(Config, PathBuf)>> {
    if std::io::stdin().is_terminal() && std::io::stderr().is_terminal() {
        return crate::tui::run(catalog, defaults);
    }
    let mut prompts = Prompts {
        input,
        output,
        history: Vec::new(),
        cursor: 0,
        previous: None,
    };
    prompts.say("KRAB configuration editor\nSelect sections by number or ID. Within a section, Enter keeps a setting, back revisits the previous question, and q cancels the section.")?;
    let mut config = match defaults.existing {
        Some(config) => config.clone(),
        None if defaults.advanced => crate::init(
            catalog,
            defaults.vendor,
            defaults.distribution,
            defaults.architecture,
        )?,
        None => match prompts.replay(|p| essentials(catalog, defaults, p)) {
            Ok(config) => config,
            Err(error) if error == CANCEL => return Ok(None),
            Err(error) => return Err(error),
        },
    };
    let original = config.clone();
    if defaults.advanced {
        section(catalog, &mut prompts, &mut config, "advanced")?;
    }
    loop {
        prompts.reset();
        let dirty = defaults.existing.is_none() || config != original;
        overview(catalog, &mut prompts, &config, defaults.path, dirty)?;
        let choices: Vec<_> = [
            ("path", "Deployment path"),
            ("architectures", "Target architectures"),
            ("distribution", "Kubernetes distribution"),
            ("runtimes", "Runtime classes"),
            ("gpu", "GPU configuration"),
            ("selinux", "Helm chart SELinux policy"),
            ("advanced", "Advanced settings"),
            ("deployment", "Release / namespace"),
            ("validate", "Validate configuration"),
            ("preview", "Preview generated Helm values"),
            ("save", "Save"),
            ("exit", "Exit"),
        ]
        .into_iter()
        .map(|(id, label)| Choice {
            id: id.into(),
            label: label.into(),
        })
        .collect();
        let action = match prompts.select(
            "Sections and actions",
            &choices,
            &["save".into()],
            false,
            false,
        ) {
            Ok(action) => action[0].clone(),
            Err(error) if error == CANCEL => "exit".into(),
            Err(error) => return Err(error),
        };
        match action.as_str() {
            "exit" => {
                prompts.reset();
                if !dirty || prompts.yes_no("Discard unsaved changes and exit?", false)? {
                    return Ok(None);
                }
            }
            "validate" => match values::build(&config, catalog) {
                Ok(_) => prompts.say("Configuration and generated chart values are valid.")?,
                Err(error) => problem(&mut prompts, &error)?,
            },
            "preview" => match values::render(&config, catalog) {
                Ok(source) => prompts.say(&format!("\nGenerated Helm values:\n{source}"))?,
                Err(error) => problem(&mut prompts, &error)?,
            },
            "save" => {
                if let Err(error) = values::build(&config, catalog) {
                    problem(&mut prompts, &error)?;
                    continue;
                }
                match prompts.replay(|p| destination(p, defaults)) {
                    Ok(Some(path)) => return Ok(Some((config, path))),
                    Ok(None) => prompts.say("Save cancelled; returning to the overview.")?,
                    Err(error) if error == CANCEL => {
                        prompts.say("Save cancelled; returning to the overview.")?
                    }
                    Err(error) => return Err(error),
                }
            }
            name => section(catalog, &mut prompts, &mut config, name)?,
        }
    }
}

fn choose_vendor<R: BufRead, W: Write>(
    catalog: &Value,
    p: &mut Prompts<R, W>,
    current: &str,
) -> Result<String> {
    let choices: Vec<_> = items(&catalog["vendors"])
        .iter()
        .map(Choice::catalog)
        .collect();
    Ok(
        p.select("Deployment path", &choices, &[current.into()], false, false)?
            .remove(0),
    )
}

fn choose_distribution<R: BufRead, W: Write>(
    catalog: &Value,
    p: &mut Prompts<R, W>,
    current: &str,
) -> Result<String> {
    let choices: Vec<_> = items(&catalog["plannedArchitecture"]["cluster"]["distributions"])
        .iter()
        .map(Choice::catalog)
        .collect();
    Ok(p.select(
        "Kubernetes distribution",
        &choices,
        &[current.into()],
        false,
        false,
    )?
    .remove(0))
}

fn choose_architectures<R: BufRead, W: Write>(
    vendor: &Value,
    p: &mut Prompts<R, W>,
    current: &[String],
) -> Result<Vec<String>> {
    let choices: Vec<_> = ["amd64", "arm64", "ppc64le", "s390x"]
        .into_iter()
        .filter(|a| {
            items(&vendor["runtime"]["shims"])
                .iter()
                .any(|s| items(&s["supportedArches"]).contains(&json!(a)))
        })
        .map(|id| Choice {
            id: id.into(),
            label: id.into(),
        })
        .collect();
    let mut default: Vec<_> = current
        .iter()
        .filter(|id| choices.iter().any(|c| &c.id == *id))
        .cloned()
        .collect();
    if default.is_empty() {
        default.push(
            choices
                .first()
                .ok_or("No supported architectures")?
                .id
                .clone(),
        );
    }
    p.select("Target node architectures", &choices, &default, true, false)
}

fn essentials<R: BufRead, W: Write>(
    catalog: &Value,
    defaults: Defaults<'_>,
    p: &mut Prompts<R, W>,
) -> Result<Config> {
    find(&catalog["vendors"], defaults.vendor)?;
    find(
        &catalog["plannedArchitecture"]["cluster"]["distributions"],
        defaults.distribution,
    )?;
    let vendor_id = choose_vendor(catalog, p, defaults.vendor)?;
    let vendor = find(&catalog["vendors"], &vendor_id)?;
    let arches = choose_architectures(vendor, p, &[defaults.architecture.into()])?;
    let distribution = choose_distribution(catalog, p, defaults.distribution)?;
    let mut config = crate::init(catalog, &vendor_id, &distribution, &arches[0])?;
    config.architectures = arches;
    Ok(config)
}

pub(super) fn effective_arches(config: &Config, vendor: &Value) -> Vec<String> {
    if !config.architectures.is_empty() {
        return config.architectures.clone();
    }
    let mut arches = Vec::new();
    let selected = config.shims(vendor).unwrap_or_default();
    let shims: Vec<_> = if selected.is_empty() {
        items(&vendor["runtime"]["shims"]).iter().collect()
    } else {
        selected
    };
    for shim in shims {
        for arch in items(&shim["supportedArches"]) {
            let arch = text(arch).to_string();
            if !arches.contains(&arch) {
                arches.push(arch);
            }
        }
    }
    arches
}

fn section<R: BufRead, W: Write>(
    catalog: &Value,
    prompts: &mut Prompts<R, W>,
    config: &mut Config,
    name: &str,
) -> Result<()> {
    let baseline = config.clone();
    let result = prompts.replay(|p| {
        let mut draft = baseline.clone();
        let vendor = find(&catalog["vendors"], &draft.vendor)?;
        match name {
            "path" => {
                let id = choose_vendor(catalog, p, &draft.vendor)?;
                if id != draft.vendor {
                    draft.vendor = id;
                    let vendor = find(&catalog["vendors"], &draft.vendor)?;
                    draft.architectures = choose_architectures(vendor, p, &baseline.architectures)?;
                    reconcile(vendor, p, &mut draft)?;
                    if items(&vendor["hardwareFamilies"]).is_empty() {
                        draft.runtimes = items(&vendor["runtime"]["shims"])
                            .iter()
                            .filter(|s| compatible(s, &draft.architectures))
                            .map(|s| text(&s["id"]).into())
                            .collect();
                    }
                }
            }
            "architectures" => {
                draft.architectures =
                    choose_architectures(vendor, p, &effective_arches(&draft, vendor))?;
                reconcile(vendor, p, &mut draft)?;
            }
            "distribution" => {
                draft.distribution = choose_distribution(catalog, p, &draft.distribution)?
            }
            "gpu" => edit_gpu(vendor, p, &mut draft)?,
            "runtimes" => edit_runtimes(vendor, p, &mut draft)?,
            "selinux" => {
                p.say("Loads SELinux policy for Kata's installer containers on enforcing nodes.")?;
                p.say("Does not enable host SELinux or change guest/workload confinement.")?;
                draft.selinux = p.yes_no(
                    "Enable the Helm chart's installer SELinux policy?",
                    draft.selinux,
                )?;
            }
            "deployment" => {
                draft.release = p.name("Helm release name", &draft.release, 53)?;
                draft.namespace = p.name("Kubernetes namespace", &draft.namespace, 63)?;
            }
            "advanced" => p.advanced(&mut draft)?,
            _ => return Err(format!("Unknown editor section {name}")),
        }
        Ok(draft)
    });
    match result {
        Ok(draft) => *config = draft,
        Err(error) if error == CANCEL => {
            prompts.reset();
            prompts.say("Section cancelled; earlier settings kept.")?;
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

fn reconcile<R: BufRead, W: Write>(
    vendor: &Value,
    p: &mut Prompts<R, W>,
    config: &mut Config,
) -> Result<()> {
    let removed = normalize(vendor, config);
    if !removed.is_empty() {
        p.say(&format!(
            "Removed incompatible selections: {}. Review GPU configuration and runtime classes.",
            removed.join(", ")
        ))?;
    }
    Ok(())
}

pub(super) fn normalize(vendor: &Value, config: &mut Config) -> Vec<String> {
    let mut removed = Vec::new();
    config.runtimes.retain(|id| {
        let keep = find(&vendor["runtime"]["shims"], id)
            .is_ok_and(|s| compatible(s, &config.architectures));
        if !keep {
            removed.push(id.clone());
        }
        keep
    });
    config.hardware.retain(|id, selection| {
        let keep = find(&vendor["hardwareFamilies"], id).is_ok_and(|f| {
            f["availability"] == "available"
                && compatible(f, &config.architectures)
                && modes(f, vendor, &config.architectures)
                    .iter()
                    .any(|m| m.id == selection.mode)
                && (selection.mode == "off"
                    || find(&f["modes"], &selection.mode).is_ok_and(|m| {
                        compatible_tees(m, f, vendor, &config.architectures)
                            .iter()
                            .any(|t| selection.cpu_tees.contains(&t.id))
                    }))
        });
        if !keep {
            removed.push(id.clone());
        }
        keep
    });
    removed
}

fn edit_gpu<R: BufRead, W: Write>(
    vendor: &Value,
    p: &mut Prompts<R, W>,
    config: &mut Config,
) -> Result<()> {
    let arches = effective_arches(config, vendor);
    let choices: Vec<_> = items(&vendor["hardwareFamilies"])
        .iter()
        .filter(|f| {
            f["availability"] == "available"
                && compatible(f, &arches)
                && !modes(f, vendor, &arches).is_empty()
        })
        .map(Choice::catalog)
        .collect();
    if choices.is_empty() {
        p.say("No GPU profiles are available for this deployment path and architecture.")?;
        return Ok(());
    }
    let current = config.hardware.clone();
    let default: Vec<_> = current
        .keys()
        .filter(|id| choices.iter().any(|c| &c.id == *id))
        .cloned()
        .collect();
    let selected = p.select(
        "GPU hardware families (none for CPU-only workloads)",
        &choices,
        &default,
        true,
        true,
    )?;
    config.hardware.clear();
    for id in selected {
        let family = find(&vendor["hardwareFamilies"], &id)?;
        let choices = modes(family, vendor, &arches);
        let previous = current.get(&id);
        let default = choices
            .iter()
            .find(|c| previous.is_some_and(|s| s.mode == c.id))
            .or_else(|| choices.iter().find(|c| family["defaultModeId"] == c.id))
            .unwrap_or(&choices[0])
            .id
            .clone();
        let mode = p
            .select(
                &format!("{} mode", text(&family["displayName"])),
                &choices,
                &[default],
                false,
                false,
            )?
            .remove(0);
        let cpu_tees = if mode == "off" {
            Vec::new()
        } else {
            let choices = compatible_tees(find(&family["modes"], &mode)?, family, vendor, &arches);
            let mut default: Vec<_> = previous
                .map(|s| {
                    s.cpu_tees
                        .iter()
                        .filter(|id| choices.iter().any(|c| &c.id == *id))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            if default.is_empty() {
                default.push(choices[0].id.clone());
            }
            p.select("Host CPU TEEs", &choices, &default, true, false)?
        };
        config.hardware.insert(id, Hardware { mode, cpu_tees });
    }
    Ok(())
}

fn edit_runtimes<R: BufRead, W: Write>(
    vendor: &Value,
    p: &mut Prompts<R, W>,
    config: &mut Config,
) -> Result<()> {
    let arches = effective_arches(config, vendor);
    let mut profiles = config.clone();
    profiles.runtimes.clear();
    let automatic: Vec<String> = profiles
        .shims(vendor)?
        .iter()
        .map(|s| text(&s["id"]).into())
        .collect();
    if !automatic.is_empty() {
        p.say(&format!(
            "Runtimes selected by GPU profiles: {}",
            automatic.join(", ")
        ))?;
    }
    let choices: Vec<_> = items(&vendor["runtime"]["shims"])
        .iter()
        .filter(|s| {
            compatible(s, &arches)
                && (!automatic.contains(&text(&s["id"]).to_string())
                    || config.runtimes.contains(&text(&s["id"]).to_string()))
                && (config.vendor == "custom"
                    || items(&vendor["hardwareFamilies"]).is_empty()
                    || s["userSelectable"] == true
                    || config.runtimes.contains(&text(&s["id"]).to_string()))
        })
        .map(Choice::catalog)
        .collect();
    let default: Vec<_> = config
        .runtimes
        .iter()
        .filter(|id| choices.iter().any(|c| &c.id == *id))
        .cloned()
        .collect();
    config.runtimes = p.select("Runtime classes", &choices, &default, true, true)?;
    Ok(())
}

fn overview<R: BufRead, W: Write>(
    catalog: &Value,
    p: &mut Prompts<R, W>,
    config: &Config,
    path: &Path,
    dirty: bool,
) -> Result<()> {
    let vendor = find(&catalog["vendors"], &config.vendor)?;
    let runtime_names: Vec<_> = config
        .shims(vendor)
        .unwrap_or_default()
        .iter()
        .map(|s| text(&s["id"]).to_string())
        .collect();
    let hardware: Vec<_> = config
        .hardware
        .iter()
        .map(|(id, s)| format!("{id}: {} ({})", s.mode, s.cpu_tees.join(", ")))
        .collect();
    p.say(&format!("\nKRAB · {} · {}\n\n  Deployment path      {}\n  Architectures        {}\n  Distribution         {}\n  Runtimes             {}\n  GPU configuration    {}\n  Installer SELinux    {}\n  Advanced settings    Components / runtime / chart overrides\n  Release / namespace  {} / {}", path.display(), if dirty { "unsaved changes" } else { "no unsaved changes" }, text(&vendor["displayName"]), if config.architectures.is_empty() { "automatic".into() } else { config.architectures.join(", ") }, config.distribution, if runtime_names.is_empty() { "none".into() } else { runtime_names.join(", ") }, if hardware.is_empty() { "none".into() } else { hardware.join("; ") }, if config.selinux { "enabled" } else { "disabled" }, config.release, config.namespace))?;
    match values::build(config, catalog) {
        Ok(_) => p.say("  Validation           valid"),
        Err(error) => problem(p, &error),
    }
}

fn problem<R: BufRead, W: Write>(p: &mut Prompts<R, W>, error: &str) -> Result<()> {
    let lower = error.to_lowercase();
    let section = if lower.contains("select at least one runtime") {
        "runtimes"
    } else if lower.contains("schema")
        || lower.contains("erofs")
        || lower.contains("valuesoverrides")
    {
        "advanced"
    } else if lower.contains("hardware") || lower.contains("cpu") {
        "gpu"
    } else if lower.contains("runtime") || lower.contains("architecture") {
        "runtimes / architectures"
    } else if lower.contains("distribution") {
        "distribution"
    } else if lower.contains("release") || lower.contains("namespace") {
        "deployment"
    } else {
        "configuration"
    };
    p.say(&format!("  Validation [{section}]: {error}"))
}

fn destination<R: BufRead, W: Write>(
    p: &mut Prompts<R, W>,
    defaults: Defaults<'_>,
) -> Result<Option<PathBuf>> {
    let path = loop {
        let path = p.answer(
            "Output file (- for stdout)",
            &defaults.path.to_string_lossy(),
        )?;
        let path = if let Some(rest) = path.strip_prefix("~/") {
            PathBuf::from(std::env::var_os("HOME").ok_or("Cannot expand ~/ without HOME")?)
                .join(rest)
        } else {
            PathBuf::from(path)
        };
        if path == Path::new("-") {
            break path;
        }
        if path.is_dir() {
            p.retry();
            p.say("That name is a directory. Choose a filename.")?;
            continue;
        }
        let same = defaults
            .original_path
            .and_then(|p| std::fs::canonicalize(p).ok())
            .zip(std::fs::canonicalize(&path).ok())
            .is_some_and(|(a, b)| a == b);
        if path.symlink_metadata().is_ok() && !defaults.force && !same {
            p.retry();
            p.say(&format!(
                "{} already exists. Choose another filename, or enter q to cancel.",
                path.display()
            ))?;
            continue;
        }
        break path;
    };
    if p.yes_no("Save this configuration?", true)? {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}
