mod checks;
mod cluster_ui;
mod config;
mod edit;
mod editor;
mod logo;
mod tui;
mod values;

use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use config::{catalog, find, items, text, Config, Result};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

#[derive(Parser)]
#[command(name = "krab", version, about = "Build and deploy Kata reference architectures", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Edit an existing configuration using its current settings as defaults.
    Edit {
        #[arg(long, default_value = "krab.yaml")]
        config: PathBuf,
        /// Save a separate copy (defaults to the source configuration).
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Replace a different existing output file after confirmation.
        #[arg(long)]
        force: bool,
        /// Prompt even when stdin is redirected.
        #[arg(long)]
        interactive: bool,
        /// Go directly to advanced settings, keeping the current basic selections.
        #[arg(long)]
        advanced: bool,
    },
    /// Create a configuration through interactive setup.
    Init {
        #[arg(long, default_value = "custom")]
        vendor: String,
        #[arg(long, default_value = "kubeadm")]
        distribution: String,
        #[arg(long, default_value = "amd64")]
        architecture: String,
        #[arg(long, default_value = "krab.yaml")]
        output: PathBuf,
        #[arg(long)]
        force: bool,
        /// Use starter defaults and flags without prompting (for scripts).
        #[arg(long, conflicts_with_all = ["interactive", "advanced"])]
        non_interactive: bool,
        /// Prompt even when stdin is redirected.
        #[arg(long)]
        interactive: bool,
        /// Go directly to advanced settings using the starter configuration.
        #[arg(long)]
        advanced: bool,
    },
    /// Discover pinned choices; JSON retains complete catalog metadata.
    List {
        #[arg(value_enum)]
        resource: Resource,
        #[arg(long)]
        vendor: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Validate a configuration and its generated Helm values offline.
    Validate {
        #[arg(long, default_value = "krab.yaml")]
        config: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Generate chart-versioned Helm values; stdout by default.
    Generate {
        #[arg(long, default_value = "krab.yaml")]
        config: PathBuf,
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(long)]
        force: bool,
        /// Emit Helm-compatible JSON instead of commented YAML.
        #[arg(long)]
        json: bool,
    },
    /// Show a Helm deployment plan; --execute applies it to the named context.
    Install {
        #[arg(long, default_value = "krab.yaml")]
        config: PathBuf,
        #[arg(long)]
        context: String,
        #[arg(long)]
        execute: bool,
    },
    /// Run local host probes or remote node pre-checks; use 'precheck --help' for options.
    #[command(disable_help_flag = true)]
    Precheck {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Evaluate cluster host prerequisites; use 'conformance --help' for options.
    #[command(disable_help_flag = true)]
    Conformance {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Generate shell completions.
    Completions { shell: clap_complete::Shell },
}

#[derive(Clone, ValueEnum)]
enum Resource {
    Vendors,
    Distributions,
    Runtimes,
    Hardware,
    Catalog,
}

fn read_config(path: &Path) -> Result<Config> {
    let source = if path == Path::new("-") {
        let mut source = String::new();
        io::stdin()
            .read_to_string(&mut source)
            .map_err(|e| e.to_string())?;
        source
    } else {
        fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?
    };
    Config::parse(&source)
}

fn stdout(source: &str) -> Result<()> {
    io::stdout()
        .lock()
        .write_all(source.as_bytes())
        .map_err(|e| e.to_string())
}

fn output(path: Option<&Path>, source: &str, force: bool) -> Result<()> {
    match path {
        None => stdout(source),
        Some(path) if path == Path::new("-") => stdout(source),
        Some(path) => {
            let mut options = OpenOptions::new();
            options.write(true);
            if force {
                options.create(true).truncate(true);
            } else {
                options.create_new(true);
            }
            let mut file = options.open(path).map_err(|e| {
                let hint = match e.kind() {
                    io::ErrorKind::AlreadyExists => " (use --force to replace an existing file)",
                    io::ErrorKind::ReadOnlyFilesystem => {
                        " (choose a writable directory or use --output -)"
                    }
                    _ => "",
                };
                format!("{}: {e}{hint}", path.display())
            })?;
            file.write_all(source.as_bytes())
                .map_err(|e| format!("{}: {e}", path.display()))
        }
    }
}

fn list(catalog: &Value, resource: Resource, vendor: Option<String>, as_json: bool) -> Result<()> {
    let selected_vendor = vendor
        .as_deref()
        .map(|id| find(&catalog["vendors"], id))
        .transpose()?;
    let result = match resource {
        Resource::Catalog => catalog.clone(),
        Resource::Vendors => catalog["vendors"].clone(),
        Resource::Distributions => {
            catalog["plannedArchitecture"]["cluster"]["distributions"].clone()
        }
        Resource::Runtimes | Resource::Hardware => {
            let vendors = selected_vendor
                .map(|v| vec![v])
                .unwrap_or_else(|| items(&catalog["vendors"]).iter().collect());
            let mut choices = Vec::new();
            for vendor in vendors {
                let source = if matches!(resource, Resource::Runtimes) {
                    &vendor["runtime"]["shims"]
                } else {
                    &vendor["hardwareFamilies"]
                };
                for choice in items(source) {
                    let mut choice = choice.clone();
                    choice["vendor"] = vendor["id"].clone();
                    choices.push(choice);
                }
            }
            json!(choices)
        }
    };
    if as_json || result.is_object() {
        return stdout(&format!(
            "{}\n",
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
        ));
    }
    for item in items(&result) {
        let details = if item["availability"] == "pending" {
            " [pending]"
        } else {
            ""
        };
        stdout(&format!(
            "{:<12} {:<40} {}{}\n",
            text(&item["vendor"]),
            text(&item["id"]),
            text(&item["displayName"]),
            details
        ))?;
    }
    Ok(())
}

fn init(catalog: &Value, vendor_id: &str, distribution: &str, arch: &str) -> Result<Config> {
    let vendor = find(&catalog["vendors"], vendor_id)?;
    let runtimes = items(&vendor["runtime"]["shims"]);
    let shim = runtimes.iter().find(|s| {
        items(&s["supportedArches"]).contains(&json!(arch)) &&
            if vendor_id == "custom" { s["id"] == "qemu-runtime-rs" } else { s["userSelectable"] == true || items(&vendor["hardwareFamilies"]).is_empty() }
    }).ok_or("No starter runtime for this vendor/architecture; use 'krab list runtimes --json' to construct a configuration")?;
    let config: Config = serde_json::from_value(json!({
        "apiVersion": "krab/v1alpha1", "vendor": vendor_id, "distribution": distribution,
        "architectures": [arch], "runtimes": [shim["id"]]
    }))
    .map_err(|e| e.to_string())?;
    values::build(&config, catalog)?;
    Ok(config)
}

fn install(config: &Config, catalog: &Value, context: &str, execute: bool) -> Result<()> {
    if context.trim().is_empty() {
        return Err("--context must name a Kubernetes context".into());
    }
    let source = values::render(config, catalog)?;
    let chart = &catalog["plannedArchitecture"]["charts"]["krab"];
    let args = vec![
        "upgrade",
        "--install",
        config.release.as_str(),
        text(&chart["ociReference"]),
        "--version",
        text(&chart["version"]),
        "--namespace",
        config.namespace.as_str(),
        "--create-namespace",
        "--kube-context",
        context,
        "--values",
        "-",
    ];
    if !execute {
        return stdout(&format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "program": "helm", "args": args, "stdin": source
            }))
            .map_err(|e| e.to_string())?
        ));
    }
    let mut child = Command::new("helm")
        .args(args)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot run Helm: {e}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or("Helm stdin unavailable")?
        .write_all(source.as_bytes());
    let status = child
        .wait()
        .map_err(|e| format!("Cannot wait for Helm: {e}"))?;
    write_result.map_err(|e| format!("Cannot send values to Helm: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Helm failed: {status}"))
    }
}

fn run(action: Action) -> Result<()> {
    let catalog = catalog();
    match action {
        Action::Edit {
            config: path,
            output: destination,
            force,
            interactive,
            advanced,
        } => {
            let document = edit::Document::load(&path, &catalog)?;
            if !interactive && !io::stdin().is_terminal() {
                return Err("Interactive editing needs a terminal; use --interactive to read answers from stdin".into());
            }
            let destination = destination.as_deref().unwrap_or(&path);
            let result = editor::run(
                &catalog,
                editor::Defaults {
                    vendor: &document.config.vendor,
                    distribution: &document.config.distribution,
                    architecture: document
                        .config
                        .architectures
                        .first()
                        .map(String::as_str)
                        .unwrap_or("amd64"),
                    path: destination,
                    existing: Some(&document.config),
                    original_path: Some(&path),
                    force,
                    advanced,
                },
                io::stdin().lock(),
                io::stderr().lock(),
            )?;
            if let Some((config, destination)) = result {
                document.save(&config, &destination, force)?;
                if destination != Path::new("-") {
                    eprintln!("Saved {}", destination.display());
                }
            }
            Ok(())
        }
        Action::Init {
            vendor,
            distribution,
            architecture,
            output: path,
            force,
            non_interactive,
            interactive,
            advanced,
        } => {
            let (config, path) = if non_interactive {
                (init(&catalog, &vendor, &distribution, &architecture)?, path)
            } else {
                if !interactive && !io::stdin().is_terminal() {
                    return Err("Interactive setup needs a terminal; use --non-interactive for scripts or --interactive to read answers from stdin".into());
                }
                match editor::run(
                    &catalog,
                    editor::Defaults {
                        vendor: &vendor,
                        distribution: &distribution,
                        architecture: &architecture,
                        path: &path,
                        existing: None,
                        original_path: None,
                        force,
                        advanced,
                    },
                    io::stdin().lock(),
                    io::stderr().lock(),
                )? {
                    Some(result) => result,
                    None => return Ok(()),
                }
            };
            output(
                Some(&path),
                &serde_yaml_ng::to_string(&config).map_err(|e| e.to_string())?,
                force,
            )
        }
        Action::List {
            resource,
            vendor,
            json,
        } => list(&catalog, resource, vendor, json),
        Action::Validate { config, json } => {
            let config = read_config(&config)?;
            values::build(&config, &catalog)?;
            if json {
                stdout(&format!(
                    "{}\n",
                    json!({"valid": true, "chartVersion": catalog["plannedArchitecture"]["charts"]["krab"]["version"]})
                ))
            } else {
                stdout("Configuration and generated chart values are valid.\n")
            }
        }
        Action::Generate {
            config,
            output: path,
            force,
            json,
        } => {
            let config = read_config(&config)?;
            let source = if json {
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&values::build(&config, &catalog)?)
                        .map_err(|e| e.to_string())?
                )
            } else {
                values::render(&config, &catalog)?
            };
            output(path.as_deref(), &source, force)
        }
        Action::Install {
            config,
            context,
            execute,
        } => install(&read_config(&config)?, &catalog, &context, execute),
        Action::Completions { shell } => {
            clap_complete::generate(shell, &mut Cli::command(), "krab", &mut io::stdout());
            Ok(())
        }
        Action::Precheck { .. } | Action::Conformance { .. } => unreachable!(),
    }
}

fn main() -> ExitCode {
    let action = Cli::parse().command.unwrap_or_else(|| {
        if Path::new("krab.yaml").exists() {
            Action::Edit {
                config: "krab.yaml".into(),
                output: None,
                force: false,
                interactive: false,
                advanced: false,
            }
        } else {
            Action::Init {
                vendor: "custom".into(),
                distribution: "kubeadm".into(),
                architecture: "amd64".into(),
                output: "krab.yaml".into(),
                force: false,
                non_interactive: false,
                interactive: false,
                advanced: false,
            }
        }
    });
    match action {
        Action::Precheck { args }
            if args.len() == 1 && ["--help", "-h"].contains(&args[0].as_str()) =>
        {
            println!("Remote node: krab precheck --node NODE [--context NAME] [--kubeconfig FILE] [--output FILE]
Remote scope: krab precheck --run [--node-selector SELECTOR] [--context NAME]
Remote runs require Helm and kubectl, install the pre-check chart, and emit JSON evidence.
");
            println!(
                "{}",
                krab_preflight::usage()
                    .replace("krab-preflight conformance", "krab conformance")
                    .replace("krab-preflight", "krab precheck")
            );
            ExitCode::SUCCESS
        }
        Action::Conformance { args }
            if args.len() == 1 && ["--help", "-h"].contains(&args[0].as_str()) =>
        {
            println!(
                "{}",
                krab_preflight::conformance::HELP
                    .replace("krab-preflight conformance", "krab conformance")
            );
            ExitCode::SUCCESS
        }
        Action::Precheck { args } if checks::remote(&args) => checks::run_precheck(args),
        Action::Precheck { args } => krab_preflight::run(args),
        Action::Conformance { args } => krab_preflight::conformance::run(&args),
        other => match run(other) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("krab: {error}");
                ExitCode::from(2)
            }
        },
    }
}
