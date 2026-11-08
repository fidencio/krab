//! Host-local caching shared by node reports and individually selected checks.
use crate::probe::Paths;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAGIC: &[u8] = b"KRAB-PREFLIGHT-CACHE-1\n";
const MAX_ENTRY: u64 = 4 * 1024 * 1024;

pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub status: u8,
    pub cacheable: bool,
}

#[derive(Default)]
pub struct Options {
    pub directory: Option<PathBuf>,
    pub disabled: bool,
    pub force_refresh: bool,
    // Node report logs are consumed as JSON by Kubernetes, which merges stdout
    // and stderr. Never add cache diagnostics to that stream.
    pub quiet: bool,
}

pub fn parse_args(args: Vec<String>) -> Result<(Options, Vec<String>), String> {
    let mut options = Options::default();
    let mut remaining = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cache-dir" => {
                let path = args
                    .next()
                    .filter(|s| !s.is_empty() && !s.starts_with("--"))
                    .ok_or("--cache-dir requires a directory")?;
                options.directory = Some(path.into());
            }
            "--no-cache" => options.disabled = true,
            "--force-refresh" => options.force_refresh = true,
            _ => remaining.push(arg),
        }
    }
    if options.disabled && (options.force_refresh || options.directory.is_some()) {
        return Err("--no-cache cannot be combined with --cache-dir or --force-refresh".into());
    }
    Ok((options, remaining))
}

fn default_directory() -> Option<PathBuf> {
    std::env::var_os("XDG_CACHE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|p| !p.is_empty())
                .map(|p| PathBuf::from(p).join(".cache"))
        })
        .map(|p| p.join("krab/preflight"))
}

// A stable checksum for corruption detection and file naming, not authentication.
fn checksum(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn file_identity(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

pub fn identity(paths: &Paths, args: &[String], architecture: &str) -> Option<String> {
    let machine = file_identity(&paths.host_root.join("etc/machine-id"))?;
    let boot = file_identity(&paths.host_root.join("proc/sys/kernel/random/boot_id"))?;
    // Permissions affect check results. Never share root's result with another caller.
    let credentials = fs::read_to_string("/proc/self/status").ok()?;
    let credentials: Vec<_> = credentials
        .lines()
        .filter(|line| {
            line.starts_with("Uid:")
                || line.starts_with("Gid:")
                || line.starts_with("Groups:")
                || line.starts_with("CapEff:")
        })
        .collect();
    if credentials.is_empty() {
        return None;
    }
    let executable = fs::read(std::env::current_exe().ok()?).ok()?;
    Some(format!(
        "{:?}",
        (
            env!("CARGO_PKG_VERSION"),
            checksum(&executable),
            architecture,
            machine,
            boot,
            paths.host_root.canonicalize().ok()?,
            credentials,
            args,
            std::env::var_os("PATH"),
            std::env::var_os("KRAB_PROVISIONER"),
        )
    ))
}

fn encode(key: &str, output: &Output) -> Vec<u8> {
    let mut data = MAGIC.to_vec();
    data.push(output.status);
    for field in [key, &output.stdout, &output.stderr] {
        data.extend_from_slice(&(field.len() as u64).to_le_bytes());
        data.extend_from_slice(field.as_bytes());
    }
    data.extend_from_slice(&checksum(&data).to_le_bytes());
    data
}

fn decode(key: &str, data: &[u8]) -> Option<Output> {
    let (body, digest) = data.split_at_checked(data.len().checked_sub(8)?)?;
    if checksum(body) != u64::from_le_bytes(digest.try_into().ok()?) {
        return None;
    }
    let mut rest = body.strip_prefix(MAGIC)?;
    let status = *rest.first()?;
    if status > 1 {
        return None;
    }
    rest = &rest[1..];
    let mut fields = Vec::new();
    for _ in 0..3 {
        let length = usize::try_from(u64::from_le_bytes(rest.get(..8)?.try_into().ok()?)).ok()?;
        let (field, tail) = rest.get(8..)?.split_at_checked(length)?;
        fields.push(String::from_utf8(field.to_vec()).ok()?);
        rest = tail;
    }
    if !rest.is_empty() || fields[0] != key {
        return None;
    }
    Some(Output {
        stdout: fields[1].clone(),
        stderr: fields[2].clone(),
        status,
        cacheable: true,
    })
}

struct Store {
    directory: PathBuf,
    _lock: File,
}

impl Store {
    fn open(directory: PathBuf) -> io::Result<Self> {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join("cache.lock"))?;
        // Serialize readers and writers, including the probes, so concurrent invocations
        // on the same host do not both repeat the work.
        lock.lock()?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }

    fn path(&self, key: &str) -> PathBuf {
        self.directory
            .join(format!("{:016x}.cache", checksum(key.as_bytes())))
    }

    fn load(&self, key: &str) -> Option<Output> {
        let mut data = Vec::new();
        File::open(self.path(key))
            .ok()?
            .take(MAX_ENTRY + 1)
            .read_to_end(&mut data)
            .ok()?;
        if data.len() as u64 > MAX_ENTRY {
            return None;
        }
        decode(key, &data)
    }

    fn save(&self, key: &str, output: &Output) -> io::Result<()> {
        let data = encode(key, output);
        if data.len() as u64 > MAX_ENTRY {
            return Err(io::Error::other("report exceeds cache entry size limit"));
        }
        let temporary = self.directory.join(format!("{}.tmp", std::process::id()));
        let result = (|| {
            // A container commonly reuses PID 1 after a crash. Clear its stale
            // temporary file while holding the lock before starting a new write.
            match fs::remove_file(&temporary) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&data)?;
            file.sync_all()?;
            fs::rename(&temporary, self.path(key))
        })();
        // A failed/crashed write must never become a readable cache entry.
        let _ = fs::remove_file(&temporary);
        result
    }
}

pub fn run(
    options: &Options,
    identity: impl Fn() -> Option<String>,
    probe: impl FnOnce() -> Output,
) -> Output {
    let diagnostic = |message: std::fmt::Arguments<'_>| {
        if !options.quiet {
            eprintln!("{message}");
        }
    };
    if options.disabled {
        return probe();
    }
    let Some(directory) = options.directory.clone().or_else(default_directory) else {
        diagnostic(format_args!(
            "Pre-flight cache unavailable: use --cache-dir to select a writable directory"
        ));
        return probe();
    };
    let store = match Store::open(directory) {
        Ok(store) => store,
        Err(error) => {
            diagnostic(format_args!(
                "Pre-flight cache unavailable: {error}; running fresh checks"
            ));
            return probe();
        }
    };
    let Some(key) = identity() else {
        diagnostic(format_args!(
            "Pre-flight cache disabled: host identity or boot ID is unavailable"
        ));
        return probe();
    };
    if !options.force_refresh {
        if let Some(output) = store.load(&key) {
            diagnostic(format_args!(
                "Reusing cached pre-flight results (use --force-refresh to check again)"
            ));
            return output;
        }
    }
    // Remove the previous result before refreshing: failed refreshes must not resurrect it.
    if let Err(error) = fs::remove_file(store.path(&key)) {
        if error.kind() != io::ErrorKind::NotFound {
            diagnostic(format_args!("Cannot invalidate pre-flight cache: {error}"));
            return Output {
                stdout: String::new(),
                stderr: String::new(),
                status: 1,
                cacheable: false,
            };
        }
    }
    let output = probe();
    if output.cacheable && identity().as_deref() == Some(&key) {
        if let Err(error) = store.save(&key, &output) {
            diagnostic(format_args!("Cannot save pre-flight cache: {error}"));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn directory() -> PathBuf {
        static ID: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "krab-cache-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn output(status: u8) -> Output {
        Output {
            stdout: "report\n".into(),
            stderr: "diagnostic\n".into(),
            status,
            cacheable: true,
        }
    }

    #[test]
    fn cache_preserves_output_and_negative_exit_status_and_rejects_corruption() {
        let encoded = encode("key", &output(1));
        let cached = decode("key", &encoded).unwrap();
        assert_eq!(cached.stdout, "report\n");
        assert_eq!(cached.stderr, "diagnostic\n");
        assert_eq!(cached.status, 1);
        assert!(decode("other", &encoded).is_none());
        for length in 0..encoded.len() {
            assert!(decode("key", &encoded[..length]).is_none());
        }
        let mut corrupt = encoded;
        corrupt[MAGIC.len() + 1] ^= 1;
        assert!(decode("key", &corrupt).is_none());
    }

    #[test]
    fn reuse_refresh_identity_changes_and_disabled_cache() {
        let directory = directory();
        let mut options = Options {
            directory: Some(directory.clone()),
            ..Options::default()
        };
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::Relaxed);
            output(0)
        };
        for _ in 0..2 {
            run(
                &options,
                || Some("machine/boot/version/checks".into()),
                probe,
            );
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        run(&options, || Some("changed-identity".into()), probe);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        options.force_refresh = true;
        run(&options, || Some("changed-identity".into()), probe);
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        options.disabled = true;
        run(&options, || Some("changed-identity".into()), probe);
        assert_eq!(calls.load(Ordering::Relaxed), 4);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_refresh_and_missing_or_changing_identity_are_not_reused() {
        let directory = directory();
        let mut options = Options {
            directory: Some(directory.clone()),
            ..Options::default()
        };
        run(&options, || Some("key".into()), || output(0));
        options.force_refresh = true;
        run(
            &options,
            || Some("key".into()),
            || Output {
                cacheable: false,
                ..output(1)
            },
        );
        options.force_refresh = false;
        let fresh = run(&options, || Some("key".into()), || output(1));
        assert_eq!(fresh.status, 1);
        assert_eq!(run(&options, || None, || output(0)).status, 0);
        let count = AtomicUsize::new(0);
        run(
            &options,
            || Some(count.fetch_add(1, Ordering::Relaxed).to_string()),
            || output(0),
        );
        assert!(Store::open(directory.clone()).unwrap().load("0").is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cache_flags_require_a_path_and_reject_conflicting_options() {
        for args in [
            vec!["--cache-dir"],
            vec!["--cache-dir", "--kvm"],
            vec!["--no-cache", "--force-refresh"],
        ] {
            assert!(parse_args(args.into_iter().map(String::from).collect()).is_err());
        }
    }
}
