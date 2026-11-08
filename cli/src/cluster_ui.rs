//! Interactive checks share the CLI collector/evaluator and never modify the editor draft.
use crate::checks;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use krab_preflight::cluster::Options;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Layout},
    widgets::{Block, List, ListItem, ListState, Paragraph, Wrap},
    Terminal,
};
use std::{
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    time::Duration,
};

#[derive(Clone, Copy)]
pub enum Kind {
    Precheck,
    Conformance,
}
const REQUIREMENTS: &[(&str, &str)] = &[
    ("kvm", "KVM (always required)"),
    ("cc", "Any supported CPU TEE"),
    ("tdx", "Intel TDX"),
    ("snp", "AMD SEV-SNP"),
    ("se", "IBM Secure Execution"),
    ("gpu-cc", "NVIDIA GPU CC"),
    ("gpu-ppcie", "NVIDIA GPU PPCIE"),
    ("erofs", "Host EROFS utilities"),
];
enum Reply {
    Contexts(Vec<String>, String),
    Nodes(Vec<String>),
    Result(String),
}
enum Screen {
    Kubeconfig,
    Loading(
        Receiver<Result<Reply, String>>,
        &'static str,
        Option<Arc<AtomicBool>>,
    ),
    Contexts(Vec<String>, usize),
    Scope,
    Nodes(Vec<String>, usize),
    Requirements(usize),
    Review,
    Results(String, usize, u16, bool),
    Export(String, String),
    Error(String),
}
fn loading(
    work: impl FnOnce() -> Result<Reply, String> + Send + 'static,
    label: &'static str,
) -> Screen {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(work());
    });
    Screen::Loading(receive, label, None)
}
fn contexts(options: Options) -> Screen {
    loading(
        move || {
            let names = options.kubectl(&[
                "config".into(),
                "get-contexts".into(),
                "-o".into(),
                "name".into(),
            ])?;
            let names: Vec<_> = names
                .lines()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .collect();
            if names.is_empty() {
                return Err(
                    "No contexts found. Set KUBECONFIG or choose a kubeconfig file.".into(),
                );
            }
            let current = options.context().unwrap_or_default();
            Ok(Reply::Contexts(names, current))
        },
        "Loading kubeconfig contexts…",
    )
}
fn nodes(options: Options) -> Screen {
    loading(
        move || {
            let inventory: serde_json::Value =
                serde_json::from_str(&options.nodes()?).map_err(|e| e.to_string())?;
            let mut names: Vec<_> = inventory["items"]
                .as_array()
                .ok_or("Invalid node inventory")?
                .iter()
                .filter_map(|node| node["metadata"]["name"].as_str().map(str::to_owned))
                .collect();
            names.sort();
            if names.is_empty() {
                return Err("No Linux nodes match this context/scope.".into());
            }
            Ok(Reply::Nodes(names))
        },
        "Checking cluster access and listing Linux nodes…",
    )
}

pub fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stderr>>,
    kind: Kind,
) -> Result<(), String> {
    let mut options = Options::default();
    if matches!(kind, Kind::Precheck) {
        options.release = "krab-precheck".into();
        options.namespace = "krab-precheck".into();
    }
    let mut kubeconfig = String::new();
    let mut selected = vec![false; REQUIREMENTS.len()];
    selected[0] = true;
    let mut screen = Screen::Kubeconfig;
    let mut help = false;
    let mut message = String::new();
    let mut count = 0;
    loop {
        if let Screen::Loading(receiver, _, _) = &screen {
            if let Ok(reply) = receiver.try_recv() {
                screen = match reply {
                    Err(error) => Screen::Error(error),
                    Ok(Reply::Contexts(names, current)) => {
                        let cursor = names.iter().position(|n| *n == current).unwrap_or(0);
                        Screen::Contexts(names, cursor)
                    }
                    Ok(Reply::Nodes(names)) => {
                        count = names.len();
                        if matches!(kind, Kind::Precheck) {
                            Screen::Nodes(names, 0)
                        } else {
                            Screen::Requirements(0)
                        }
                    }
                    Ok(Reply::Result(text)) => {
                        Screen::Results(text, 0, 0, matches!(kind, Kind::Conformance))
                    }
                };
            }
        }
        terminal.draw(|frame| {
            let area = frame.area();
            let layout = Layout::vertical([Constraint::Length(3), Constraint::Min(5), Constraint::Length(3)]).split(area);
            frame.render_widget(Paragraph::new(format!("{}\nContext: {}", if matches!(kind, Kind::Precheck) { "Node pre-check" } else { "Cluster conformance" }, options.context.as_deref().unwrap_or("not selected"))), layout[0]);
            let mut rows = Vec::new(); let mut cursor = 0;
            let (title, text, controls) = match &screen {
                Screen::Kubeconfig => ("Kubeconfig", format!("File: {kubeconfig}\n\nLeave blank to use KUBECONFIG or ~/.kube/config."), "Type path · Backspace edits · Enter loads contexts · Esc returns · F1 help"),
                Screen::Loading(_, label, _) => ("Running", format!("{label}\n\nHelm collection can take up to 35 minutes. Waiting for results…"), "[Esc] Cancel collection · [?] Help"),
                Screen::Contexts(names, pos) => { rows = names.clone(); cursor = *pos; ("Select Kubernetes context", String::new(), "↑/↓ Select · Enter confirms · Esc back · [?] Help") }
                Screen::Scope => ("Node scope", format!("Label selector: {}\n\nLeave blank to check every Linux node.", options.node_selector), "Type selector · Enter checks access · Esc back · F1 help"),
                Screen::Nodes(names, pos) => { rows = names.clone(); cursor = *pos; ("Select Linux node", String::new(), "↑/↓ Select · Enter confirms · Esc back · [?] Help") }
                Screen::Requirements(pos) => { rows = REQUIREMENTS.iter().enumerate().map(|(i,(_,label))| format!("[{}] {label}", if selected[i] {'x'} else {' '})).collect(); cursor = *pos; ("Conformance requirements (KVM always required)", String::new(), "↑/↓ Move · Space toggles · Enter reviews · Esc back · [?] Help") }
                Screen::Review => ("Review and run", format!("Kubeconfig: {}\nContext: {}\nScope: {}\nRequirements: {}\n\nInstalls/updates only the pre-check Helm release {} in namespace {} and runs fresh host probes.\n\nPress Enter to run, or Esc to go back.", if kubeconfig.is_empty() { "KUBECONFIG/default" } else { &kubeconfig }, options.context.as_deref().unwrap_or(""), options.node.as_deref().unwrap_or(if options.node_selector.is_empty() { "all Linux nodes" } else { &options.node_selector }), if matches!(kind, Kind::Conformance) { REQUIREMENTS.iter().enumerate().filter(|(i,_)| selected[*i]).map(|(_, (id,_))| *id).collect::<Vec<_>>().join(", ") } else { "collect capability evidence".into() }, options.release, options.namespace), "Enter runs checks · Esc back · [?] Help"),
                Screen::Results(source, pos, scroll, failed) => {
                    match checks::report_lines(source, *failed) {
                        Ok((summary, entries)) => {
                            let parts = Layout::vertical([Constraint::Length(2), Constraint::Percentage(45), Constraint::Min(3)]).split(layout[1]);
                            frame.render_widget(Paragraph::new(summary).wrap(Wrap{trim:false}), parts[0]);
                            let mut state = ListState::default().with_selected(Some((*pos).min(entries.len()-1)));
                            frame.render_stateful_widget(List::new(entries.iter().map(|(name,_)| ListItem::new(name.as_str()))).block(Block::bordered().title(if *failed { "Failed/error nodes" } else { "All nodes" })).highlight_symbol("› ").highlight_style(ratatui::style::Style::default().fg(ratatui::style::Color::Cyan)), parts[1], &mut state);
                            frame.render_widget(Paragraph::new(entries[(*pos).min(entries.len()-1)].1.as_str()).scroll((*scroll,0)).block(Block::bordered().title("Reasons / evidence")).wrap(Wrap{trim:false}), parts[2]);
                        }
                        Err(error) => frame.render_widget(Paragraph::new(error), layout[1]),
                    }
                    ("", String::new(), "↑/↓ Nodes · PgUp/PgDn Details · f Failed/all · e Export JSON · Esc returns · [?] Help")
                }
                Screen::Export(_, path) => ("Save full JSON evidence", format!("Filename: {path}\n\nChoose a new filename; existing files are preserved."), "Type path · Enter saves · Esc cancels · F1 help"),
                Screen::Error(error) => ("Cannot run checks", format!("{error}\n\nCheck kubeconfig, credentials, kubectl, Helm, and cluster permissions. Press Enter to choose the connection again."), "Enter retries connection setup · Esc returns · [?] Help"),
            };
            if !title.is_empty() {
                if rows.is_empty() { frame.render_widget(Paragraph::new(text).block(Block::bordered().title(title)).wrap(Wrap{trim:false}), layout[1]); }
                else {
                    let mut state = ListState::default().with_selected(Some(cursor));
                    frame.render_stateful_widget(List::new(rows).block(Block::bordered().title(title)).highlight_symbol("› ").highlight_style(ratatui::style::Style::default().fg(ratatui::style::Color::Cyan)), layout[1], &mut state);
                }
            }
            frame.render_widget(Paragraph::new(format!("{controls}\n{message}")).wrap(Wrap{trim:false}), layout[2]);
            if help {
                frame.render_widget(ratatui::widgets::Clear, layout[1]);
                frame.render_widget(Paragraph::new("Choose a kubeconfig and context, then the node or cluster scope. Enter confirms single selections; Space toggles requirement checkboxes. Choose at most one CPU TEE policy. Review shows the target before installing the pre-check chart.\n\nResults initially show failed/error nodes for conformance. Use f for all nodes, arrow keys to select a node, and PgUp/PgDn to read its reasons. e exports full JSON evidence. PASS covers host prerequisites, not workload launch or attestation.\n\nEsc, Enter, ? or F1 closes help.").block(Block::bordered().title("Help · Cluster checks")).wrap(Wrap{trim:false}), layout[1]);
            }
        }).map_err(|e| e.to_string())?;
        if !event::poll(Duration::from_millis(100)).map_err(|e| e.to_string())? {
            continue;
        }
        let event = event::read().map_err(|e| e.to_string())?;
        let text_input = matches!(
            screen,
            Screen::Kubeconfig | Screen::Scope | Screen::Export(_, _)
        );
        if let Event::Paste(text) = &event {
            if !help {
                match &mut screen {
                    Screen::Kubeconfig => kubeconfig.push_str(text.trim()),
                    Screen::Scope => options.node_selector.push_str(text.trim()),
                    Screen::Export(_, path) => path.push_str(text.trim()),
                    _ => {}
                }
            }
            continue;
        }
        let Event::Key(key) = event else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        if help {
            if matches!(
                key.code,
                KeyCode::Esc | KeyCode::Enter | KeyCode::Char('?') | KeyCode::F(1)
            ) {
                help = false;
            }
            continue;
        }
        if key.code == KeyCode::F(1) || (key.code == KeyCode::Char('?') && !text_input) {
            help = true;
            continue;
        }
        if key.code == KeyCode::Char('c')
            && key.modifiers.contains(KeyModifiers::CONTROL)
            && !matches!(screen, Screen::Loading(_, _, _))
        {
            return Ok(());
        }
        message.clear();
        let current = std::mem::replace(&mut screen, Screen::Kubeconfig);
        screen = match current {
            Screen::Kubeconfig => match key.code {
                KeyCode::Esc => return Ok(()),
                KeyCode::Char(c) => {
                    kubeconfig.push(c);
                    Screen::Kubeconfig
                }
                KeyCode::Backspace => {
                    kubeconfig.pop();
                    Screen::Kubeconfig
                }
                KeyCode::Enter => {
                    options.kubeconfig =
                        (!kubeconfig.trim().is_empty()).then(|| PathBuf::from(kubeconfig.trim()));
                    contexts(options.clone())
                }
                _ => Screen::Kubeconfig,
            },
            Screen::Contexts(names, mut pos) => match key.code {
                KeyCode::Down => {
                    pos = (pos + 1) % names.len();
                    Screen::Contexts(names, pos)
                }
                KeyCode::Up => {
                    pos = (pos + names.len() - 1) % names.len();
                    Screen::Contexts(names, pos)
                }
                KeyCode::Enter => {
                    options.context = Some(names[pos].clone());
                    if matches!(kind, Kind::Conformance) {
                        Screen::Scope
                    } else {
                        nodes(options.clone())
                    }
                }
                KeyCode::Esc => Screen::Kubeconfig,
                _ => Screen::Contexts(names, pos),
            },
            Screen::Scope => match key.code {
                KeyCode::Char(c) => {
                    options.node_selector.push(c);
                    Screen::Scope
                }
                KeyCode::Backspace => {
                    options.node_selector.pop();
                    Screen::Scope
                }
                KeyCode::Enter => nodes(options.clone()),
                KeyCode::Esc => contexts(options.clone()),
                _ => Screen::Scope,
            },
            Screen::Nodes(names, mut pos) => match key.code {
                KeyCode::Down => {
                    pos = (pos + 1) % names.len();
                    Screen::Nodes(names, pos)
                }
                KeyCode::Up => {
                    pos = (pos + names.len() - 1) % names.len();
                    Screen::Nodes(names, pos)
                }
                KeyCode::Enter => {
                    options.node = Some(names[pos].clone());
                    Screen::Review
                }
                KeyCode::Esc => contexts(options.clone()),
                _ => Screen::Nodes(names, pos),
            },
            Screen::Requirements(mut pos) => match key.code {
                KeyCode::Down => {
                    pos = (pos + 1) % selected.len();
                    Screen::Requirements(pos)
                }
                KeyCode::Up => {
                    pos = (pos + selected.len() - 1) % selected.len();
                    Screen::Requirements(pos)
                }
                KeyCode::Char(' ') if pos > 0 => {
                    selected[pos] = !selected[pos];
                    if (1..=4).contains(&pos) && selected[pos] {
                        for (i, value) in selected.iter_mut().enumerate().take(5).skip(1) {
                            if i != pos {
                                *value = false;
                            }
                        }
                    }
                    Screen::Requirements(pos)
                }
                KeyCode::Enter => {
                    message = format!("{count} Linux nodes selected");
                    Screen::Review
                }
                KeyCode::Esc => Screen::Scope,
                _ => Screen::Requirements(pos),
            },
            Screen::Review => match key.code {
                KeyCode::Enter => {
                    let target = options.clone();
                    let requirements: Vec<String> = REQUIREMENTS
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| selected[*i])
                        .map(|(_, (id, _))| (*id).into())
                        .collect();
                    let cancelled = Arc::new(AtomicBool::new(false));
                    let token = cancelled.clone();
                    let mut next = loading(
                        move || {
                            checks::collect(
                                &target,
                                &requirements,
                                matches!(kind, Kind::Conformance),
                                token,
                            )
                            .map(Reply::Result)
                        },
                        "Collecting fresh host probes through Helm…",
                    );
                    if let Screen::Loading(_, _, control) = &mut next {
                        *control = Some(cancelled);
                    }
                    next
                }
                KeyCode::Esc => {
                    if matches!(kind, Kind::Precheck) {
                        nodes(options.clone())
                    } else {
                        Screen::Requirements(0)
                    }
                }
                _ => Screen::Review,
            },
            Screen::Results(source, mut pos, mut scroll, mut failed) => match key.code {
                KeyCode::Esc | KeyCode::Char('q') => return Ok(()),
                KeyCode::Char('e') => Screen::Export(source, String::new()),
                _ => {
                    let len = checks::report_lines(&source, failed)?.1.len();
                    match key.code {
                        KeyCode::Down => {
                            pos = (pos + 1) % len;
                            scroll = 0;
                        }
                        KeyCode::Up => {
                            pos = (pos + len - 1) % len;
                            scroll = 0;
                        }
                        KeyCode::PageDown => scroll = scroll.saturating_add(5),
                        KeyCode::PageUp => scroll = scroll.saturating_sub(5),
                        KeyCode::Char('f') => {
                            failed = !failed;
                            pos = 0;
                            scroll = 0;
                        }
                        _ => {}
                    }
                    Screen::Results(source, pos, scroll, failed)
                }
            },
            Screen::Export(source, mut path) => match key.code {
                KeyCode::Esc => Screen::Results(source, 0, 0, matches!(kind, Kind::Conformance)),
                KeyCode::Backspace => {
                    path.pop();
                    Screen::Export(source, path)
                }
                KeyCode::Char(c) => {
                    path.push(c);
                    Screen::Export(source, path)
                }
                KeyCode::Enter => {
                    if path.trim().is_empty() {
                        message = "Choose a filename".into();
                        Screen::Export(source, path)
                    } else {
                        match super::output(
                            Some(std::path::Path::new(path.trim())),
                            &format!("{source}\n"),
                            false,
                        ) {
                            Ok(()) => {
                                message = format!("Saved {path}");
                                Screen::Results(source, 0, 0, matches!(kind, Kind::Conformance))
                            }
                            Err(error) => {
                                message = error;
                                Screen::Export(source, path)
                            }
                        }
                    }
                }
                _ => Screen::Export(source, path),
            },
            Screen::Error(error) => match key.code {
                KeyCode::Esc => return Ok(()),
                KeyCode::Enter => Screen::Kubeconfig,
                _ => Screen::Error(error),
            },
            Screen::Loading(receiver, label, control) => {
                if key.code == KeyCode::Esc
                    || (key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::CONTROL))
                {
                    if let Some(cancelled) = &control {
                        cancelled.store(true, Ordering::Relaxed);
                    } else {
                        return Ok(());
                    }
                }
                Screen::Loading(receiver, label, control)
            }
        };
    }
}
