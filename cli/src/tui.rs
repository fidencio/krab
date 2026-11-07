use crate::config::{find, items, text, Config, Hardware, Result};
use crate::editor::{self, Defaults};
use crate::values;
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};

const SECTIONS: &[&str] = &[
    "Node pre-check",
    "Cluster conformance",
    "Deployment path",
    "Architectures",
    "Distribution",
    "Runtimes",
    "GPU configuration",
    "Helm chart SELinux policy",
    "Advanced settings",
    "Release name",
    "Namespace",
    "Validate",
    "Preview values",
    "Save",
    "Exit",
];
const ADVANCED: &[(&str, Field)] = &[
    ("NFD", Field::Component("nfd")),
    ("Kata deploy", Field::Component("kataDeploy")),
    ("Device plugin", Field::Component("devicePlugin")),
    ("Provisioner", Field::Component("provisioner")),
    ("TDX QGS", Field::Component("qgs")),
    ("HTTPS proxy", Field::Runtime("httpsProxy")),
    ("No-proxy hosts", Field::Runtime("noProxy")),
    ("NVIDIA DCGM", Field::Runtime("nvidiaDcgm")),
    ("EROFS mode", Field::Runtime("erofsMode")),
    ("EROFS disk size", Field::Runtime("erofsDiskSize")),
    ("EROFS dm-verity", Field::Runtime("erofsDmverity")),
    ("EROFS fs-verity", Field::Runtime("erofsFsverity")),
    (
        "Install EROFS utilities",
        Field::Runtime("installErofsUtils"),
    ),
    ("Website advanced settings (YAML)", Field::WebsiteAdvanced),
    ("Chart overrides (YAML)", Field::Overrides),
];

#[derive(Clone, Debug)]
enum Field {
    Vendor,
    Architectures,
    Distribution,
    Runtimes,
    Families,
    Mode(String),
    Tees(String),
    Selinux,
    Component(&'static str),
    Runtime(&'static str),
    Release,
    Namespace,
    Overrides,
    WebsiteAdvanced,
    Output,
}

struct OptionItem {
    id: String,
    label: String,
    locked: bool,
}
struct Choices {
    field: Field,
    title: String,
    options: Vec<OptionItem>,
    checked: Vec<bool>,
    cursor: usize,
    multiple: bool,
    required: bool,
    baseline: Config,
}
struct Input {
    field: Field,
    title: String,
    value: String,
    cursor: usize,
    fresh: bool,
    baseline: Config,
}
enum Screen {
    Overview,
    Advanced,
    Choices(Choices),
    Input(Input),
    Preview(String, u16),
    ConfirmSave(PathBuf, bool),
    ConfirmExit(bool),
}

pub(super) struct App<'a> {
    catalog: &'a Value,
    defaults: Defaults<'a>,
    config: Config,
    original: Config,
    screen: Screen,
    selected: usize,
    advanced_selected: usize,
    section_baseline: Config,
    gpu_queue: VecDeque<String>,
    setup: Option<usize>,
    message: String,
    help_open: bool,
    logo: Option<crate::logo::Logo>,
    pending_check: Option<crate::cluster_ui::Kind>,
}

impl<'a> App<'a> {
    fn advanced_fields(&self) -> Vec<(&'static str, Field)> {
        ADVANCED
            .iter()
            .filter(|(_, field)| {
                !matches!(field, Field::Runtime("erofsDiskSize"))
                    || self.config.runtime.erofs_mode == "disk"
            })
            .cloned()
            .collect()
    }
    fn new(catalog: &'a Value, defaults: Defaults<'a>) -> Result<Self> {
        let config = if let Some(config) = defaults.existing {
            config.clone()
        } else {
            let vendor = find(&catalog["vendors"], defaults.vendor)?;
            let requested = json!(defaults.architecture);
            let arch = if items(&vendor["runtime"]["shims"])
                .iter()
                .any(|s| items(&s["supportedArches"]).contains(&requested))
            {
                defaults.architecture
            } else {
                text(&items(&vendor["runtime"]["shims"])[0]["supportedArches"][0])
            };
            crate::init(catalog, defaults.vendor, defaults.distribution, arch)?
        };
        let mut app = Self {
            catalog,
            defaults,
            original: config.clone(),
            section_baseline: config.clone(),
            config,
            screen: Screen::Overview,
            selected: 0,
            advanced_selected: 0,
            gpu_queue: VecDeque::new(),
            setup: None,
            message: String::new(),
            help_open: false,
            logo: None,
            pending_check: None,
        };
        if defaults.advanced {
            app.screen = Screen::Advanced;
        } else if defaults.existing.is_none() {
            app.setup = Some(0);
            app.open(Field::Vendor)?;
        }
        Ok(app)
    }

    fn dirty(&self) -> bool {
        self.defaults.existing.is_none()
            || self.config != self.original
            || matches!(&self.screen, Screen::Input(input) if matches!(input.field, Field::Overrides | Field::WebsiteAdvanced) && serde_yaml_ng::to_string(&if matches!(input.field, Field::WebsiteAdvanced) { serde_json::to_value(&input.baseline.advanced).expect("advanced settings serialize") } else { input.baseline.values_overrides.clone() }).is_ok_and(|source| source != input.value))
    }
    fn vendor(&self) -> Result<&Value> {
        find(&self.catalog["vendors"], &self.config.vendor)
    }
    fn advanced_field(field: &Field) -> bool {
        matches!(
            field,
            Field::Component(_) | Field::Runtime(_) | Field::Overrides | Field::WebsiteAdvanced
        )
    }
    fn parent(&mut self, field: &Field) {
        self.screen = if Self::advanced_field(field) {
            Screen::Advanced
        } else {
            Screen::Overview
        };
    }

    fn field_value(&self, field: &Field) -> Value {
        let value = serde_json::to_value(&self.config).expect("configuration serializes");
        match field {
            Field::Component(key) => value["components"][key].clone(),
            Field::Runtime(key) => value["runtime"][key].clone(),
            Field::Release => value["release"].clone(),
            Field::Namespace => value["namespace"].clone(),
            Field::Overrides => value["valuesOverrides"].clone(),
            Field::WebsiteAdvanced => value["advanced"].clone(),
            Field::Selinux => value["selinux"].clone(),
            _ => Value::Null,
        }
    }

    fn set_value(&mut self, field: &Field, replacement: Value) -> Result<()> {
        let mut value = serde_json::to_value(&self.config).map_err(|e| e.to_string())?;
        match field {
            Field::Component(key) => value["components"][key] = replacement,
            Field::Runtime(key) => value["runtime"][key] = replacement,
            Field::Release => value["release"] = replacement,
            Field::Namespace => value["namespace"] = replacement,
            Field::Overrides => value["valuesOverrides"] = replacement,
            Field::WebsiteAdvanced => value["advanced"] = replacement,
            Field::Selinux => value["selinux"] = replacement,
            _ => return Err("This field is not a scalar setting".into()),
        }
        self.config = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn choices(
        &mut self,
        field: Field,
        title: &str,
        options: Vec<OptionItem>,
        current: Vec<String>,
        multiple: bool,
        required: bool,
    ) {
        if options.is_empty() {
            self.message = "No compatible choices for this path and architecture.".into();
            self.parent(&field);
            return;
        }
        let checked: Vec<_> = options
            .iter()
            .map(|o| current.contains(&o.id) || o.locked)
            .collect();
        let cursor = if multiple {
            0
        } else {
            checked.iter().position(|v| *v).unwrap_or(0)
        };
        self.screen = Screen::Choices(Choices {
            field,
            title: title.into(),
            options,
            checked,
            cursor,
            multiple,
            required,
            baseline: self.config.clone(),
        });
    }

    fn open(&mut self, field: Field) -> Result<()> {
        self.message.clear();
        let vendor = self.vendor()?;
        let arches = editor::effective_arches(&self.config, vendor);
        let catalog_options = |source: &Value| -> Vec<OptionItem> {
            items(source)
                .iter()
                .map(|v| {
                    let id = text(&v["id"]).to_string();
                    let label = text(&v["displayName"]);
                    OptionItem {
                        label: if label.is_empty() {
                            id.clone()
                        } else {
                            format!("{label} ({id})")
                        },
                        id,
                        locked: false,
                    }
                })
                .collect()
        };
        match &field {
            Field::Vendor => self.choices(
                field.clone(),
                "Deployment path",
                catalog_options(&self.catalog["vendors"]),
                vec![self.config.vendor.clone()],
                false,
                true,
            ),
            Field::Distribution => self.choices(
                field.clone(),
                "Kubernetes distribution",
                catalog_options(&self.catalog["plannedArchitecture"]["cluster"]["distributions"]),
                vec![self.config.distribution.clone()],
                false,
                true,
            ),
            Field::Architectures => {
                let options = ["amd64", "arm64", "ppc64le", "s390x"]
                    .into_iter()
                    .filter(|a| {
                        items(&vendor["runtime"]["shims"])
                            .iter()
                            .any(|s| items(&s["supportedArches"]).contains(&json!(a)))
                    })
                    .map(|id| OptionItem {
                        id: id.into(),
                        label: id.into(),
                        locked: false,
                    })
                    .collect();
                self.choices(
                    field.clone(),
                    "Target architectures",
                    options,
                    arches,
                    true,
                    true,
                );
            }
            Field::Runtimes => {
                let mut profiles = self.config.clone();
                profiles.runtimes.clear();
                let automatic: Vec<_> = profiles
                    .shims(vendor)?
                    .iter()
                    .map(|s| text(&s["id"]).to_string())
                    .collect();
                let options = items(&vendor["runtime"]["shims"])
                    .iter()
                    .filter(|s| editor::compatible(s, &arches))
                    .map(|s| {
                        let id = text(&s["id"]).to_string();
                        let locked = automatic.contains(&id) && !self.config.runtimes.contains(&id);
                        OptionItem {
                            label: format!(
                                "{id}{}",
                                if locked {
                                    " (required by GPU profile)"
                                } else {
                                    ""
                                }
                            ),
                            id,
                            locked,
                        }
                    })
                    .collect();
                self.choices(
                    field.clone(),
                    "Runtime classes",
                    options,
                    self.config.runtimes.clone(),
                    true,
                    false,
                );
            }
            Field::Families => {
                let options = items(&vendor["hardwareFamilies"])
                    .iter()
                    .filter(|f| {
                        f["availability"] == "available"
                            && editor::compatible(f, &arches)
                            && !editor::modes(f, vendor, &arches).is_empty()
                    })
                    .map(|f| OptionItem {
                        id: text(&f["id"]).into(),
                        label: text(&f["displayName"]).into(),
                        locked: false,
                    })
                    .collect();
                self.choices(
                    field.clone(),
                    "GPU families",
                    options,
                    self.config.hardware.keys().cloned().collect(),
                    true,
                    false,
                );
            }
            Field::Mode(id) => {
                let family = find(&vendor["hardwareFamilies"], id)?;
                let options = editor::modes(family, vendor, &arches)
                    .into_iter()
                    .map(|c| OptionItem {
                        id: c.id,
                        label: c.label,
                        locked: false,
                    })
                    .collect();
                self.choices(
                    field.clone(),
                    &format!("{id}: GPU mode"),
                    options,
                    vec![self.config.hardware[id].mode.clone()],
                    false,
                    true,
                );
            }
            Field::Tees(id) => {
                let family = find(&vendor["hardwareFamilies"], id)?;
                let selection = &self.config.hardware[id];
                let options = editor::compatible_tees(
                    find(&family["modes"], &selection.mode)?,
                    family,
                    vendor,
                    &arches,
                )
                .into_iter()
                .map(|c| OptionItem {
                    id: c.id,
                    label: c.label,
                    locked: false,
                })
                .collect();
                self.choices(
                    field.clone(),
                    &format!("{id}: CPU TEEs"),
                    options,
                    selection.cpu_tees.clone(),
                    true,
                    true,
                );
            }
            Field::Component(_) => {
                let current = match self.field_value(&field).as_bool() {
                    Some(true) => "enabled",
                    Some(false) => "disabled",
                    None => "auto",
                };
                self.choices(
                    field.clone(),
                    "Component installation",
                    options(&["auto", "enabled", "disabled"]),
                    vec![current.into()],
                    false,
                    true,
                );
            }
            Field::Runtime("erofsMode") => self.choices(
                field.clone(),
                "EROFS mode",
                options(&["memory", "disk"]),
                vec![text(&self.field_value(&field)).into()],
                false,
                true,
            ),
            Field::Selinux
            | Field::Runtime(
                "nvidiaDcgm" | "erofsDmverity" | "erofsFsverity" | "installErofsUtils",
            ) => {
                let current = if self.field_value(&field).as_bool().unwrap_or(false) {
                    "enabled"
                } else {
                    "disabled"
                };
                self.choices(
                    field.clone(),
                    if matches!(field, Field::Selinux) {
                        "Kata installer SELinux policy"
                    } else {
                        "Enable setting?"
                    },
                    options(&["enabled", "disabled"]),
                    vec![current.into()],
                    false,
                    true,
                );
            }
            _ => {
                let value = if matches!(field, Field::Output) {
                    self.defaults.path.to_string_lossy().into_owned()
                } else if matches!(field, Field::Overrides | Field::WebsiteAdvanced) {
                    serde_yaml_ng::to_string(&self.field_value(&field))
                        .map_err(|e| e.to_string())?
                } else {
                    text(&self.field_value(&field)).into()
                };
                let title = match &field {
                    Field::Overrides => "Chart overrides (YAML)",
                    Field::WebsiteAdvanced => "Website advanced settings (YAML)",
                    Field::Output => "Output filename",
                    Field::Release => "Release name",
                    Field::Namespace => "Namespace",
                    Field::Runtime(key) => key,
                    _ => "Value",
                }
                .to_string();
                let cursor = value.len();
                self.screen = Screen::Input(Input {
                    field: field.clone(),
                    title,
                    value,
                    cursor,
                    fresh: !matches!(field, Field::Overrides | Field::WebsiteAdvanced),
                    baseline: self.config.clone(),
                });
            }
        }
        Ok(())
    }

    fn apply_choices(&mut self, menu: &Choices) -> Result<()> {
        self.config = menu.baseline.clone();
        let selected: Vec<_> = menu
            .options
            .iter()
            .zip(&menu.checked)
            .filter(|(_, checked)| **checked)
            .map(|(o, _)| o.id.clone())
            .collect();
        let first = selected.first().map(String::as_str).unwrap_or("");
        match &menu.field {
            Field::Vendor => {
                self.config.vendor = first.into();
                let vendor = find(&self.catalog["vendors"], first)?;
                let supported: Vec<_> = items(&vendor["runtime"]["shims"])
                    .iter()
                    .flat_map(|s| {
                        items(&s["supportedArches"])
                            .iter()
                            .map(|a| text(a).to_string())
                    })
                    .collect();
                self.config.architectures.retain(|a| supported.contains(a));
                if self.config.architectures.is_empty() {
                    self.config.architectures.push(supported[0].clone());
                }
                editor::normalize(vendor, &mut self.config);
                if self.config.runtimes.is_empty() && self.config.hardware.is_empty() {
                    self.config.runtimes = crate::init(
                        self.catalog,
                        first,
                        &self.config.distribution,
                        &self.config.architectures[0],
                    )
                    .map(|c| c.runtimes)
                    .unwrap_or_default();
                }
            }
            Field::Architectures => {
                self.config.architectures = selected;
                let vendor = find(&self.catalog["vendors"], &self.config.vendor)?;
                editor::normalize(vendor, &mut self.config);
            }
            Field::Distribution => self.config.distribution = first.into(),
            Field::Runtimes => {
                self.config.runtimes = menu
                    .options
                    .iter()
                    .zip(&menu.checked)
                    .filter(|(o, v)| **v && !o.locked)
                    .map(|(o, _)| o.id.clone())
                    .collect()
            }
            Field::Families => {
                self.config.hardware.retain(|id, _| selected.contains(id));
                for id in selected {
                    if !self.config.hardware.contains_key(&id) {
                        let vendor = self.vendor()?;
                        let family = find(&vendor["hardwareFamilies"], &id)?;
                        let arches = editor::effective_arches(&self.config, vendor);
                        let modes = editor::modes(family, vendor, &arches);
                        let mode = modes
                            .iter()
                            .find(|m| family["defaultModeId"] == m.id)
                            .unwrap_or(&modes[0])
                            .id
                            .clone();
                        self.config.hardware.insert(
                            id.clone(),
                            Hardware {
                                mode,
                                cpu_tees: Vec::new(),
                            },
                        );
                        self.fix_tees(&id)?;
                    }
                }
            }
            Field::Mode(id) => {
                self.config.hardware.get_mut(id).unwrap().mode = first.into();
                self.fix_tees(id)?;
            }
            Field::Tees(id) => self.config.hardware.get_mut(id).unwrap().cpu_tees = selected,
            Field::Component(_) => self.set_value(
                &menu.field,
                match first {
                    "enabled" => json!(true),
                    "disabled" => json!(false),
                    _ => Value::Null,
                },
            )?,
            Field::Runtime("erofsMode") => self.set_value(&menu.field, json!(first))?,
            Field::Selinux | Field::Runtime(_) => {
                self.set_value(&menu.field, json!(first == "enabled"))?
            }
            _ => {}
        }
        Ok(())
    }

    fn fix_tees(&mut self, id: &str) -> Result<()> {
        let vendor = self.vendor()?;
        let family = find(&vendor["hardwareFamilies"], id)?;
        let selection = &self.config.hardware[id];
        let allowed = if selection.mode == "off" {
            Vec::new()
        } else {
            editor::compatible_tees(
                find(&family["modes"], &selection.mode)?,
                family,
                vendor,
                &editor::effective_arches(&self.config, vendor),
            )
            .into_iter()
            .map(|c| c.id)
            .collect::<Vec<_>>()
        };
        let selection = self.config.hardware.get_mut(id).unwrap();
        selection.cpu_tees.retain(|id| allowed.contains(id));
        if selection.cpu_tees.is_empty() && !allowed.is_empty() {
            selection.cpu_tees.push(allowed[0].clone());
        }
        Ok(())
    }

    fn next_gpu(&mut self) -> Result<()> {
        if let Some(id) = self.gpu_queue.pop_front() {
            self.open(Field::Mode(id))?;
        } else {
            self.screen = Screen::Overview;
        }
        Ok(())
    }

    fn confirmed_choices(&mut self, menu: Choices) -> Result<()> {
        if menu.required && !menu.checked.iter().any(|v| *v) {
            self.message = "Select at least one option.".into();
            self.screen = Screen::Choices(menu);
            return Ok(());
        }
        self.apply_choices(&menu)?;
        if let Some(step) = self.setup {
            self.setup = if step < 2 { Some(step + 1) } else { None };
            match step {
                0 => self.open(Field::Architectures)?,
                1 => self.open(Field::Distribution)?,
                _ => self.screen = Screen::Overview,
            }
        } else {
            match menu.field {
                Field::Families => {
                    self.gpu_queue = self.config.hardware.keys().cloned().collect();
                    self.next_gpu()?;
                }
                Field::Mode(id) if self.config.hardware[&id].mode != "off" => {
                    self.open(Field::Tees(id))?
                }
                Field::Mode(_) | Field::Tees(_) => self.next_gpu()?,
                field => self.parent(&field),
            }
        }
        Ok(())
    }

    fn save(&mut self) -> Result<()> {
        match values::build(&self.config, self.catalog) {
            Ok(_) => {
                self.section_baseline = self.config.clone();
                self.open(Field::Output)?;
            }
            Err(error) => self.message = format!("Cannot save: {error}"),
        }
        Ok(())
    }

    fn finish_input(&mut self, input: Input) -> Result<()> {
        if matches!(input.field, Field::Output) {
            let path = if let Some(rest) = input.value.strip_prefix("~/") {
                PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(rest)
            } else {
                PathBuf::from(&input.value)
            };
            let same = self
                .defaults
                .original_path
                .and_then(|p| std::fs::canonicalize(p).ok())
                .zip(std::fs::canonicalize(&path).ok())
                .is_some_and(|(a, b)| a == b);
            if input.value.trim().is_empty() || path.is_dir() {
                self.message = "Choose a filename.".into();
                self.screen = Screen::Input(input);
            } else if path != Path::new("-")
                && path.symlink_metadata().is_ok()
                && !same
                && !self.defaults.force
            {
                self.message =
                    "File already exists. Choose another filename (Ctrl+U to clear).".into();
                self.screen = Screen::Input(input);
            } else {
                self.screen = Screen::ConfirmSave(path, true);
            }
        } else if let Err(error) = self.apply_input(&input) {
            self.message = error;
            self.screen = Screen::Input(input);
        } else {
            self.parent(&input.field);
        }
        Ok(())
    }

    fn apply_input(&mut self, input: &Input) -> Result<()> {
        if matches!(input.field, Field::Output) {
            return Ok(());
        }
        let value = if matches!(input.field, Field::Overrides | Field::WebsiteAdvanced) {
            let parsed: Value =
                serde_yaml_ng::from_str(&input.value).map_err(|e| format!("Invalid YAML: {e}"))?;
            if !parsed.is_object() {
                return Err("Chart overrides must be a YAML mapping.".into());
            }
            parsed
        } else {
            json!(input.value)
        };
        self.set_value(&input.field, value)
    }

    // Outer None keeps the editor open; Some(None) exits without saving.
    fn key(&mut self, key: KeyEvent) -> Result<Option<Option<(Config, PathBuf)>>> {
        if key.kind == KeyEventKind::Release {
            return Ok(None);
        }
        if self.help_open {
            if matches!(
                key.code,
                KeyCode::Esc
                    | KeyCode::Enter
                    | KeyCode::F(1)
                    | KeyCode::Char('?')
                    | KeyCode::Char('q')
            ) {
                self.help_open = false;
            }
            return Ok(None);
        }
        if key.code == KeyCode::F(1)
            || (key.code == KeyCode::Char('?') && !matches!(self.screen, Screen::Input(_)))
        {
            self.help_open = true;
            return Ok(None);
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            if self.dirty() {
                self.screen = Screen::ConfirmExit(false);
            } else {
                return Ok(Some(None));
            }
            return Ok(None);
        }
        self.message.clear();
        let screen = std::mem::replace(&mut self.screen, Screen::Overview);
        match screen {
            Screen::Overview => match key.code {
                KeyCode::Down | KeyCode::Char('j') => {
                    self.selected = (self.selected + 1) % SECTIONS.len()
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.selected = (self.selected + SECTIONS.len() - 1) % SECTIONS.len()
                }
                KeyCode::Char('s') => self.save()?,
                KeyCode::Char('p') => {
                    self.screen = Screen::Preview(
                        values::render(&self.config, self.catalog).unwrap_or_else(|e| e),
                        0,
                    )
                }
                KeyCode::Esc | KeyCode::Char('q') => {
                    if self.dirty() {
                        self.screen = Screen::ConfirmExit(false);
                    } else {
                        return Ok(Some(None));
                    }
                }
                KeyCode::Enter => {
                    self.section_baseline = self.config.clone();
                    match self.selected {
                        2 => self.open(Field::Vendor)?,
                        3 => self.open(Field::Architectures)?,
                        4 => self.open(Field::Distribution)?,
                        5 => self.open(Field::Runtimes)?,
                        6 => self.open(Field::Families)?,
                        7 => self.open(Field::Selinux)?,
                        8 => self.screen = Screen::Advanced,
                        9 => self.open(Field::Release)?,
                        10 => self.open(Field::Namespace)?,
                        11 => {
                            self.message = values::build(&self.config, self.catalog)
                                .map(|_| "Configuration is valid.".into())
                                .unwrap_or_else(|e| e)
                        }
                        12 => {
                            self.screen = Screen::Preview(
                                values::render(&self.config, self.catalog).unwrap_or_else(|e| e),
                                0,
                            )
                        }
                        13 => self.save()?,
                        0 => self.pending_check = Some(crate::cluster_ui::Kind::Precheck),
                        1 => self.pending_check = Some(crate::cluster_ui::Kind::Conformance),
                        _ => {
                            if self.dirty() {
                                self.screen = Screen::ConfirmExit(false);
                            } else {
                                return Ok(Some(None));
                            }
                        }
                    }
                }
                _ => {}
            },
            Screen::Advanced => {
                self.screen = Screen::Advanced;
                let fields = self.advanced_fields();
                self.advanced_selected = self.advanced_selected.min(fields.len() - 1);
                match key.code {
                    KeyCode::Down | KeyCode::Char('j') => {
                        self.advanced_selected = (self.advanced_selected + 1) % fields.len()
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        self.advanced_selected =
                            (self.advanced_selected + fields.len() - 1) % fields.len()
                    }
                    KeyCode::Esc | KeyCode::Char('q') => self.screen = Screen::Overview,
                    KeyCode::Enter => {
                        self.section_baseline = self.config.clone();
                        self.open(fields[self.advanced_selected].1.clone())?;
                    }
                    _ => {}
                }
            }
            Screen::Choices(mut menu) => {
                let mut changed = false;
                match key.code {
                    KeyCode::Down | KeyCode::Char('j') => {
                        menu.cursor = (menu.cursor + 1) % menu.options.len();
                        changed = !menu.multiple;
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        menu.cursor = (menu.cursor + menu.options.len() - 1) % menu.options.len();
                        changed = !menu.multiple;
                    }
                    KeyCode::Char(' ') if menu.multiple && !menu.options[menu.cursor].locked => {
                        menu.checked[menu.cursor] = !menu.checked[menu.cursor];
                        changed = true;
                    }
                    KeyCode::Enter => {
                        self.confirmed_choices(menu)?;
                        return Ok(None);
                    }
                    KeyCode::Esc | KeyCode::Char('q') => {
                        self.config = self.section_baseline.clone();
                        self.setup = None;
                        self.parent(&menu.field);
                        return Ok(None);
                    }
                    _ => {}
                }
                if changed {
                    if !menu.multiple {
                        menu.checked.fill(false);
                        menu.checked[menu.cursor] = true;
                    }
                    self.apply_choices(&menu)?;
                }
                self.screen = Screen::Choices(menu);
            }
            Screen::Input(mut input) => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                match key.code {
                    KeyCode::Esc => {
                        self.config = input.baseline;
                        self.parent(&input.field);
                        return Ok(None);
                    }
                    KeyCode::Enter
                        if !matches!(input.field, Field::Overrides | Field::WebsiteAdvanced) =>
                    {
                        self.finish_input(input)?;
                        return Ok(None);
                    }
                    KeyCode::Char('s') if control => {
                        self.finish_input(input)?;
                        return Ok(None);
                    }
                    KeyCode::Char('u') if control => {
                        input.value.clear();
                        input.cursor = 0;
                        input.fresh = false;
                    }
                    KeyCode::Left => {
                        input.cursor = previous_char(&input.value, input.cursor);
                        input.fresh = false;
                    }
                    KeyCode::Right => {
                        input.cursor = next_char(&input.value, input.cursor);
                        input.fresh = false;
                    }
                    KeyCode::Up => input.vertical(false),
                    KeyCode::Down => input.vertical(true),
                    KeyCode::Home => {
                        input.cursor = 0;
                        input.fresh = false;
                    }
                    KeyCode::End => {
                        input.cursor = input.value.len();
                        input.fresh = false;
                    }
                    KeyCode::Backspace => {
                        if input.fresh {
                            input.value.clear();
                            input.cursor = 0;
                            input.fresh = false;
                        } else if input.cursor > 0 {
                            let start = previous_char(&input.value, input.cursor);
                            input.value.replace_range(start..input.cursor, "");
                            input.cursor = start;
                        }
                    }
                    KeyCode::Delete if input.cursor < input.value.len() => {
                        let end = next_char(&input.value, input.cursor);
                        input.value.replace_range(input.cursor..end, "");
                        input.fresh = false;
                    }
                    KeyCode::Char(c) if !control => input.insert(&c.to_string()),
                    KeyCode::Enter => input.insert("\n"),
                    KeyCode::Tab => input.insert("  "),
                    _ => {}
                }
                if let Err(error) = self.apply_input(&input) {
                    self.message = error;
                }
                self.screen = Screen::Input(input);
            }
            Screen::Preview(source, mut scroll) => {
                match key.code {
                    KeyCode::Esc | KeyCode::Char('q') => return Ok(None),
                    KeyCode::Down => scroll = scroll.saturating_add(1),
                    KeyCode::Up => scroll = scroll.saturating_sub(1),
                    KeyCode::PageDown => scroll = scroll.saturating_add(10),
                    KeyCode::PageUp => scroll = scroll.saturating_sub(10),
                    _ => {}
                }
                self.screen = Screen::Preview(source, scroll);
            }
            Screen::ConfirmSave(path, mut yes) => {
                match key.code {
                    KeyCode::Left | KeyCode::Right | KeyCode::Tab => yes = !yes,
                    KeyCode::Char('y') => return Ok(Some(Some((self.config.clone(), path)))),
                    KeyCode::Enter if yes => return Ok(Some(Some((self.config.clone(), path)))),
                    KeyCode::Esc | KeyCode::Char('n') | KeyCode::Enter => return Ok(None),
                    _ => {}
                }
                self.screen = Screen::ConfirmSave(path, yes);
            }
            Screen::ConfirmExit(mut yes) => {
                match key.code {
                    KeyCode::Left | KeyCode::Right | KeyCode::Tab => yes = !yes,
                    KeyCode::Char('y') => return Ok(Some(None)),
                    KeyCode::Enter if yes => return Ok(Some(None)),
                    KeyCode::Esc | KeyCode::Char('n') | KeyCode::Enter => return Ok(None),
                    _ => {}
                }
                self.screen = Screen::ConfirmExit(yes);
            }
        }
        Ok(None)
    }

    fn paste(&mut self, source: &str) -> Result<()> {
        if self.help_open {
            return Ok(());
        }
        let screen = std::mem::replace(&mut self.screen, Screen::Overview);
        if let Screen::Input(mut input) = screen {
            input.insert(source);
            if let Err(error) = self.apply_input(&input) {
                self.message = error;
            }
            self.screen = Screen::Input(input);
        } else {
            self.screen = screen;
        }
        Ok(())
    }
}

impl Input {
    fn insert(&mut self, text: &str) {
        if self.fresh {
            self.value.clear();
            self.cursor = 0;
            self.fresh = false;
        }
        self.value.insert_str(self.cursor, text);
        self.cursor += text.len();
    }
    fn vertical(&mut self, down: bool) {
        let start = self.value[..self.cursor]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let column = self.value[start..self.cursor].chars().count();
        let range = if down {
            self.value[self.cursor..].find('\n').map(|i| {
                let start = self.cursor + i + 1;
                let end = self.value[start..]
                    .find('\n')
                    .map(|i| start + i)
                    .unwrap_or(self.value.len());
                start..end
            })
        } else if start > 0 {
            let end = start - 1;
            Some(self.value[..end].rfind('\n').map(|i| i + 1).unwrap_or(0)..end)
        } else {
            None
        };
        if let Some(range) = range {
            self.cursor = range.start
                + self.value[range]
                    .chars()
                    .take(column)
                    .map(char::len_utf8)
                    .sum::<usize>();
        }
        self.fresh = false;
    }
}
fn previous_char(value: &str, cursor: usize) -> usize {
    value[..cursor]
        .char_indices()
        .next_back()
        .map(|(i, _)| i)
        .unwrap_or(0)
}
fn next_char(value: &str, cursor: usize) -> usize {
    value[cursor..]
        .chars()
        .next()
        .map(|c| cursor + c.len_utf8())
        .unwrap_or(cursor)
}
fn options(ids: &[&str]) -> Vec<OptionItem> {
    ids.iter()
        .map(|id| OptionItem {
            id: (*id).into(),
            label: (*id).into(),
            locked: false,
        })
        .collect()
}

fn list(frame: &mut Frame<'_>, area: Rect, title: &str, rows: Vec<String>, selected: usize) {
    let mut state = ListState::default().with_selected(Some(selected));
    let widget = List::new(rows.into_iter().map(|row| {
        if row.starts_with('─') {
            ListItem::new(row).style(Style::default().fg(Color::DarkGray))
        } else {
            ListItem::new(row)
        }
    }))
    .block(Block::bordered().title(title.to_string()))
    .highlight_style(
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )
    .highlight_symbol("› ");
    frame.render_stateful_widget(widget, area, &mut state);
}

fn render(frame: &mut Frame<'_>, app: &App<'_>) {
    let area = frame.area();
    if area.width < 65 || area.height < 24 {
        let help = if matches!(app.screen, Screen::ConfirmExit(_)) {
            "Unsaved changes: y discards and exits; n keeps editing."
        } else {
            "Resize the terminal; Esc returns or requests exit."
        };
        frame.render_widget(
            Paragraph::new(format!("KRAB needs at least 65 columns × 24 rows.\n{help}"))
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    let vertical = Layout::vertical([
        Constraint::Length(if app.logo.is_some() { 3 } else { 2 }),
        Constraint::Min(12),
        Constraint::Length(3),
    ])
    .split(area);
    let body = Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(vertical[1]);
    let right = Layout::vertical([Constraint::Min(5), Constraint::Length(5)]).split(body[1]);
    let header = if let Some(logo) = &app.logo {
        if !app.help_open {
            logo.render(frame, Rect::new(area.x, area.y, 6, 3));
        }
        Rect::new(area.x + 7, area.y + 1, area.width.saturating_sub(7), 1)
    } else {
        vertical[0]
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " KRAB ",
                Style::default()
                    .fg(Color::Rgb(252, 94, 51))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!(
                "{} · {}",
                app.defaults.path.display(),
                if app.dirty() {
                    "unsaved changes"
                } else {
                    "no unsaved changes"
                }
            )),
        ])),
        header,
    );
    let vendor = app.vendor().ok();
    let runtimes: Vec<_> = vendor
        .and_then(|v| app.config.shims(v).ok())
        .unwrap_or_default()
        .iter()
        .map(|s| text(&s["id"]).to_string())
        .collect();
    let hardware: Vec<_> = app
        .config
        .hardware
        .iter()
        .map(|(id, s)| format!("{id}: {} {}", s.mode, s.cpu_tees.join(", ")))
        .collect();
    let mut summary = vec![
        Line::from(format!("Path: {}", app.config.vendor)),
        Line::from(format!(
            "Architectures: {}",
            if app.config.architectures.is_empty() {
                "automatic".into()
            } else {
                app.config.architectures.join(", ")
            }
        )),
        Line::from(format!("Distribution: {}", app.config.distribution)),
        Line::from(format!("Release: {}", app.config.release)),
        Line::from(format!("Namespace: {}", app.config.namespace)),
        Line::from(format!(
            "Installer SELinux policy: {}",
            if app.config.selinux {
                "enabled"
            } else {
                "disabled"
            }
        )),
        Line::from(""),
        Line::from(format!("Selected runtimes ({})", runtimes.len())),
    ];
    for id in runtimes {
        summary.push(Line::from(format!("  {id}")));
    }
    summary.push(Line::from(""));
    summary.push(Line::from("GPU profiles"));
    if hardware.is_empty() {
        summary.push(Line::from("  none"));
    } else {
        for id in hardware {
            summary.push(Line::from(format!("  {id}")));
        }
    }
    let verdict = if matches!(&app.screen, Screen::Input(i) if matches!(i.field, Field::Overrides | Field::WebsiteAdvanced))
        && !app.message.is_empty()
    {
        Line::styled(
            format!("NEEDS ATTENTION · {}", app.message),
            Style::default().fg(Color::Yellow),
        )
    } else {
        match values::build(&app.config, app.catalog) {
            Ok(_) => Line::styled(
                "VALID · configuration matches chart",
                Style::default().fg(Color::Green),
            ),
            Err(error) => Line::styled(
                format!("NEEDS ATTENTION · {error}"),
                Style::default().fg(Color::Yellow),
            ),
        }
    };
    frame.render_widget(
        Paragraph::new(summary)
            .block(Block::bordered().title("Live configuration"))
            .wrap(Wrap { trim: false }),
        right[0],
    );
    frame.render_widget(
        Paragraph::new(verdict)
            .block(Block::bordered().title("Live validation"))
            .wrap(Wrap { trim: false }),
        right[1],
    );
    match &app.screen {
        Screen::Overview => list(
            frame,
            body[0],
            "Sections",
            SECTIONS
                .iter()
                .enumerate()
                .flat_map(|(i, s)| {
                    if i == 2 {
                        vec!["── KRAB configuration ──".to_owned(), (*s).to_owned()]
                    } else {
                        vec![(*s).to_owned()]
                    }
                })
                .collect(),
            app.selected + usize::from(app.selected >= 2),
        ),
        Screen::Advanced => {
            let rows = app
                .advanced_fields()
                .iter()
                .map(|(label, field)| {
                    let value = app.field_value(field);
                    let displayed = if matches!(field, Field::Overrides | Field::WebsiteAdvanced) {
                        format!(
                            "{} top-level keys",
                            value.as_object().map(|m| m.len()).unwrap_or(0)
                        )
                    } else if value.is_null() {
                        "automatic".into()
                    } else {
                        value.to_string().trim_matches('"').to_string()
                    };
                    format!("{label}: {displayed}")
                })
                .collect();
            list(
                frame,
                body[0],
                "Advanced settings · Esc returns",
                rows,
                app.advanced_selected,
            );
        }
        Screen::Choices(menu) => {
            let rows = menu
                .options
                .iter()
                .zip(&menu.checked)
                .map(|(o, checked)| {
                    format!(
                        "{} {}",
                        if o.locked {
                            "[A]"
                        } else if !menu.multiple {
                            if *checked {
                                "(*)"
                            } else {
                                "( )"
                            }
                        } else if *checked {
                            "[x]"
                        } else {
                            "[ ]"
                        },
                        o.label
                    )
                })
                .collect();
            list(frame, body[0], &menu.title, rows, menu.cursor);
        }
        Screen::Input(input) => {
            let lines = input.value[..input.cursor].matches('\n').count() as u16;
            let visible_height = body[0].height.saturating_sub(2).max(1);
            let scroll = lines.saturating_sub(visible_height - 1);
            let current_line = input.value[..input.cursor]
                .rsplit('\n')
                .next()
                .unwrap_or("");
            let x = Line::from(current_line).width() as u16;
            let horizontal = x.saturating_sub(body[0].width.saturating_sub(3));
            frame.render_widget(
                Paragraph::new(input.value.as_str())
                    .scroll((scroll, horizontal))
                    .block(Block::bordered().title(input.title.clone())),
                body[0],
            );
            if !app.help_open {
                frame.set_cursor_position((
                    body[0].x + 1 + x.saturating_sub(horizontal),
                    body[0].y + 1 + lines.saturating_sub(scroll),
                ));
            }
        }
        Screen::Preview(source, scroll) => frame.render_widget(
            Paragraph::new(source.as_str())
                .scroll((*scroll, 0))
                .block(Block::bordered().title("Generated values · Esc returns")),
            body[0],
        ),
        Screen::ConfirmSave(path, yes) => frame.render_widget(
            Paragraph::new(format!(
                "Save configuration to {}?\n\n{}",
                path.display(),
                if *yes { "[Yes]   No" } else { " Yes   [No]" }
            ))
            .block(Block::bordered().title("Confirm save"))
            .wrap(Wrap { trim: false }),
            body[0],
        ),
        Screen::ConfirmExit(yes) => frame.render_widget(
            Paragraph::new(format!(
                "Discard unsaved changes and exit?\n\n{}",
                if *yes { "[Yes]   No" } else { " Yes   [No]" }
            ))
            .block(Block::bordered().title("Unsaved changes")),
            body[0],
        ),
    }
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(controls(&app.screen)),
            Line::from(if matches!(app.screen, Screen::Input(_)) {
                "[F1] Help · [Esc] Cancel"
            } else {
                "[?] Help · [Esc] Back/cancel"
            }),
            Line::styled(app.message.as_str(), Style::default().fg(Color::Yellow)),
        ])
        .wrap(Wrap { trim: false }),
        vertical[2],
    );
    if app.help_open {
        let popup = Rect::new(
            area.x + 1,
            area.y + 1,
            area.width.saturating_sub(2),
            area.height.saturating_sub(2),
        );
        frame.render_widget(Clear, popup);
        frame.render_widget(
            Paragraph::new(format!(
                "{}\n\n{}\n\nChanges preview live. Esc cancels a section and restores its earlier settings.\n\n[?]/[F1]: help in menus. Text fields: [F1] for help; [?] types normally.\n\nClose help: [Enter], [Esc], [?], [F1], or [q].",
                controls(&app.screen), help_details(&app.screen)
            ))
            .block(Block::bordered().title("Help · Keyboard controls"))
            .wrap(Wrap { trim: false }),
            popup,
        );
    }
}

fn controls(screen: &Screen) -> &'static str {
    match screen {
        Screen::Overview => "[↑/↓] Move [Enter] Open/run [s] Save [p] Preview [q] Exit",
        Screen::Advanced => "[↑/↓] Move [Enter] Open setting",
        Screen::Choices(menu) if menu.multiple => "[↑/↓] Move [Space] Toggle [Enter] Done",
        Screen::Choices(_) => "[↑/↓] Select [Enter] Confirm",
        Screen::Input(i) if matches!(i.field, Field::Overrides | Field::WebsiteAdvanced) => {
            "[Enter] New line [Ctrl+S] Confirm [Ctrl+U] Clear"
        }
        Screen::Input(_) => "[←/→] Move cursor [Enter] Confirm [Ctrl+U] Clear",
        Screen::Preview(_, _) => "[↑/↓] Scroll [PgUp/PgDn] Scroll page",
        Screen::ConfirmSave(_, _) | Screen::ConfirmExit(_) => {
            "[←/→ or Tab] Choose [Enter] Confirm [y/n] Yes/no"
        }
    }
}

fn help_details(screen: &Screen) -> &'static str {
    match screen {
        Screen::Overview => "Enter opens the highlighted section or runs the highlighted action. Save asks for a filename and confirmation. Exit asks before discarding unsaved changes.",
        Screen::Advanced => "Enter opens the highlighted setting. Esc returns to the overview.",
        Screen::Choices(menu) if matches!(menu.field, Field::Selinux) => "Loads SELinux policy for Kata's installer containers on enforcing nodes. Does not enable host SELinux or change guest/workload confinement. Arrow keys preview a value; Enter confirms; Esc restores the earlier setting.",
        Screen::Choices(menu) if menu.multiple => "Checkboxes [x]/[ ] allow multiple selections. Move to a row, press Space to toggle it, then Enter to finish the section. [A] marks an automatic runtime required by the GPU configuration; change that GPU configuration to remove it.",
        Screen::Choices(_) => "Radio buttons (*)/( ) allow one selection. Arrow keys select and preview a value; Enter confirms it. Space has no action here.",
        Screen::Input(i) if matches!(i.field, Field::WebsiteAdvanced) => "Edit the website advanced settings: QGS, containerd paths and drop-ins, custom runtimes, node selectors and affinity, tolerations, scheduled reconcile, images, and debug. Enter inserts a line; Ctrl+S confirms. Unknown fields are rejected. Basic components and EROFS settings have separate menu entries.",
        Screen::Input(i) if matches!(i.field, Field::Overrides) => "Edit chart overrides as a YAML mapping. Enter inserts a new line; Ctrl+S confirms. Arrow keys, Home/End, Backspace/Delete, and multiline paste are supported. Invalid YAML must be corrected before confirming.",
        Screen::Input(_) => "Typing initially replaces the displayed value. Move the cursor first to edit within it. Home/End, Backspace/Delete, and paste are supported. Enter confirms the field; saving still requires a separate confirmation.",
        Screen::Preview(_, _) => "Scroll through generated Helm values. Esc or q returns to the overview.",
        Screen::ConfirmSave(_, _) => "Select Yes or No with Left/Right or Tab, then press Enter. You can also press y or n directly. Esc cancels saving and returns to the overview.",
        Screen::ConfirmExit(_) => "Yes discards unsaved changes and exits. No keeps editing. Select with Left/Right or Tab, then Enter, or press y/n directly. Esc keeps editing.",
    }
}

struct Restore;
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stderr(),
            DisableBracketedPaste,
            Show,
            LeaveAlternateScreen
        );
    }
}

pub fn run(catalog: &Value, defaults: Defaults<'_>) -> Result<Option<(Config, PathBuf)>> {
    let mut app = App::new(catalog, defaults)?;
    enable_raw_mode().map_err(|e| e.to_string())?;
    let _restore = Restore;
    execute!(
        io::stderr(),
        EnterAlternateScreen,
        EnableBracketedPaste,
        Hide
    )
    .map_err(|e| e.to_string())?;
    app.logo = crate::logo::Logo::from_terminal();
    let mut terminal =
        Terminal::new(CrosstermBackend::new(io::stderr())).map_err(|e| e.to_string())?;
    loop {
        terminal
            .draw(|frame| render(frame, &app))
            .map_err(|e| e.to_string())?;
        match event::read().map_err(|e| e.to_string())? {
            Event::Key(key) => {
                if let Some(result) = app.key(key)? {
                    return Ok(result);
                }
            }
            Event::Paste(text) => app.paste(&text)?,
            _ => {}
        }
        if let Some(kind) = app.pending_check.take() {
            crate::cluster_ui::run(&mut terminal, kind)?;
            // Fullscreen resize invalidates the buffers without querying the
            // cursor on stdout (which may be reserved for exported YAML).
            let size = terminal.size().map_err(|e| e.to_string())?;
            terminal
                .resize(Rect::new(0, 0, size.width, size.height))
                .map_err(|e| e.to_string())?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn defaults(config: &Config) -> Defaults<'_> {
        Defaults {
            vendor: &config.vendor,
            distribution: &config.distribution,
            architecture: "amd64",
            path: Path::new("krab.yaml"),
            existing: Some(config),
            original_path: Some(Path::new("krab.yaml")),
            force: false,
            advanced: false,
        }
    }
    fn key(app: &mut App<'_>, key: KeyCode) {
        app.key(KeyEvent::new(key, KeyModifiers::NONE)).unwrap();
    }
    fn output(app: &App<'_>, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| render(frame, app)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn website_settings_yaml_preserves_drafts_and_rejects_unknown_fields() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::WebsiteAdvanced).unwrap();
        assert!(output(&app, 140, 40).contains("Ctrl+S"));
        app.key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL))
            .unwrap();
        app.paste("debug: true\nnodeSelector:\n  - key: pool\n    value: kata\n")
            .unwrap();
        assert!(app.dirty());
        app.key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL))
            .unwrap();
        assert!(matches!(app.screen, Screen::Advanced));
        assert!(app.config.advanced.debug);
        assert_eq!(
            values::build(&app.config, &catalog).unwrap()["kata-deploy"]["nodeSelector"]["pool"],
            "kata"
        );
        let saved = app.config.clone();
        app.open(Field::WebsiteAdvanced).unwrap();
        app.key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL))
            .unwrap();
        app.paste("typo: true\n").unwrap();
        app.key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL))
            .unwrap();
        assert!(matches!(app.screen, Screen::Input(_)));
        key(&mut app, KeyCode::Esc);
        assert_eq!(app.config, saved);
    }

    #[test]
    fn help_preserves_selection_and_draft_and_never_confirms_actions() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::Runtimes).unwrap();
        key(&mut app, KeyCode::Char(' '));
        key(&mut app, KeyCode::Down);
        let draft = app.config.clone();
        key(&mut app, KeyCode::Char('?'));
        let help = output(&app, 65, 24);
        assert!(help.contains("Help · Keyboard controls"));
        assert!(
            help.contains("Close help: [Enter], [Esc], [?], [F1], or [q]."),
            "{help}"
        );
        key(&mut app, KeyCode::Char(' '));
        key(&mut app, KeyCode::Down);
        key(&mut app, KeyCode::Enter);
        assert!(!app.help_open);
        assert_eq!(app.config, draft);
        assert!(matches!(&app.screen, Screen::Choices(menu) if menu.cursor == 1));

        app.screen = Screen::ConfirmSave(PathBuf::from("new.yaml"), true);
        key(&mut app, KeyCode::Char('?'));
        assert!(app
            .key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap()
            .is_none());
        assert!(matches!(app.screen, Screen::ConfirmSave(_, true)));
    }

    #[test]
    fn help_in_text_fields_uses_f1_and_preserves_literal_question_marks() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::Runtime("httpsProxy")).unwrap();
        key(&mut app, KeyCode::Char('?'));
        assert!(!app.help_open);
        key(&mut app, KeyCode::F(1));
        app.paste("ignored").unwrap();
        key(&mut app, KeyCode::Enter);
        assert!(matches!(&app.screen, Screen::Input(i) if i.value == "?" && i.cursor == 1));
    }

    #[test]
    fn single_choices_use_radio_buttons_and_space_only_toggles_checkboxes() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::Distribution).unwrap();
        let screen = output(&app, 140, 40);
        assert!(screen.contains("(*)"));
        assert!(screen.contains("[Enter] Confirm"));
        assert!(!screen.contains("[Space] Toggle"));
        key(&mut app, KeyCode::Char(' '));
        assert_eq!(app.config, config);
        app.screen = Screen::Advanced;
        key(&mut app, KeyCode::Char(' '));
        assert!(matches!(app.screen, Screen::Advanced));
        key(&mut app, KeyCode::Enter);
        assert!(matches!(app.screen, Screen::Choices(_)));
    }

    #[test]
    fn erofs_disk_size_is_only_shown_and_reachable_in_disk_mode() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.screen = Screen::Advanced;
        assert!(!output(&app, 140, 40).contains("EROFS disk size"));
        app.config.runtime.erofs_mode = "disk".into();
        assert!(output(&app, 140, 40).contains("EROFS disk size"));
        app.advanced_selected = app
            .advanced_fields()
            .iter()
            .position(|(_, field)| matches!(field, Field::Runtime("erofsDiskSize")))
            .unwrap();
        key(&mut app, KeyCode::Enter);
        assert!(
            matches!(&app.screen,Screen::Input(i) if matches!(i.field,Field::Runtime("erofsDiskSize")))
        );
        key(&mut app, KeyCode::Esc);
        app.config.runtime.erofs_mode = "memory".into();
        assert!(!output(&app, 140, 40).contains("EROFS disk size"));
    }

    #[test]
    fn runtime_checkboxes_update_configuration_and_render_before_enter_and_escape_rolls_back() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::Runtimes).unwrap();
        if let Screen::Choices(menu) = &mut app.screen {
            menu.cursor = menu
                .options
                .iter()
                .position(|o| o.id == "qemu-snp-runtime-rs")
                .unwrap();
        }
        key(&mut app, KeyCode::Char(' '));
        assert!(app.config.runtimes.contains(&"qemu-snp-runtime-rs".into()));
        let screen = output(&app, 140, 40);
        assert!(screen.contains("[x] qemu-snp-runtime-rs"));
        assert!(screen.contains("Selected runtimes (2)"));
        key(&mut app, KeyCode::Esc);
        assert_eq!(app.config, config);
        assert!(matches!(app.screen, Screen::Overview));
    }

    #[test]
    fn gpu_family_and_mode_update_required_runtime_live_and_keep_advanced_settings() {
        let catalog = crate::config::catalog();
        let mut config = crate::init(&catalog, "nvidia", "kubeadm", "amd64").unwrap();
        config.values_overrides = json!({"kata-deploy":{"debug":true}});
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::Families).unwrap();
        if let Screen::Choices(menu) = &mut app.screen {
            menu.cursor = menu.options.iter().position(|o| o.id == "hopper").unwrap();
        }
        key(&mut app, KeyCode::Char(' '));
        assert!(app.config.hardware.contains_key("hopper"));
        key(&mut app, KeyCode::Enter);
        if let Screen::Choices(menu) = &app.screen {
            assert!(matches!(menu.field, Field::Mode(_)));
        }
        key(&mut app, KeyCode::Down);
        assert_eq!(app.config.hardware["hopper"].mode, "ppcie");
        assert!(app
            .config
            .shims(app.vendor().unwrap())
            .unwrap()
            .iter()
            .any(|s| s["id"] == "qemu-nvidia-gpu-tdx-runtime-rs"));
        assert_eq!(app.config.values_overrides, config.values_overrides);
        key(&mut app, KeyCode::Esc);
        assert_eq!(app.config, config);
    }

    #[test]
    fn text_editing_validates_each_key_supports_unicode_and_can_cancel() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.open(Field::Release).unwrap();
        key(&mut app, KeyCode::Char('é'));
        assert_eq!(app.config.release, "é");
        assert!(output(&app, 100, 24).contains("NEEDS ATTENTION"));
        key(&mut app, KeyCode::Left);
        key(&mut app, KeyCode::Delete);
        assert_eq!(app.config.release, "");
        key(&mut app, KeyCode::Esc);
        assert_eq!(app.config, config);
        app.config.runtimes.clear();
        app.save().unwrap();
        assert!(matches!(app.screen, Screen::Overview));
        assert!(app.message.contains("Cannot save"));
    }

    #[test]
    fn output_collisions_require_another_filename_and_saving_requires_confirmation() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let dir = std::env::temp_dir().join(format!("krab-tui-output-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let occupied = dir.join("occupied.yaml");
        let available = dir.join("available.yaml");
        std::fs::write(&occupied, "keep this").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.save().unwrap();
        app.paste(occupied.to_str().unwrap()).unwrap();
        key(&mut app, KeyCode::Enter);
        assert!(matches!(app.screen, Screen::Input(_)));
        assert!(app.message.contains("already exists"));
        app.key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL))
            .unwrap();
        app.paste(available.to_str().unwrap()).unwrap();
        key(&mut app, KeyCode::Enter);
        assert!(matches!(app.screen, Screen::ConfirmSave(_, _)));
        assert!(!available.exists());
        let result = app
            .key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result.1, available);
        assert_eq!(std::fs::read_to_string(&occupied).unwrap(), "keep this");
        assert!(
            !available.exists(),
            "UI returns a reviewed save request; the caller owns file writes"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unsaved_exit_defaults_to_keep_editing_and_small_terminals_render_safely() {
        let catalog = crate::config::catalog();
        let config = crate::init(&catalog, "custom", "kubeadm", "amd64").unwrap();
        let mut app = App::new(&catalog, defaults(&config)).unwrap();
        app.config.selinux = true;
        key(&mut app, KeyCode::Char('q'));
        assert!(matches!(app.screen, Screen::ConfirmExit(false)));
        key(&mut app, KeyCode::Enter);
        assert!(matches!(app.screen, Screen::Overview));
        assert!(output(&app, 40, 10).contains("KRAB needs"));
        app.key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL))
            .unwrap();
        assert!(matches!(app.screen, Screen::ConfirmExit(false)));
        assert!(app
            .key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE))
            .unwrap()
            .unwrap()
            .is_none());
    }
}
