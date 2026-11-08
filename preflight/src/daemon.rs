//! Supervise repeated invocations of the existing one-shot checker.
use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

fn notify(message: &str) -> io::Result<()> {
    let Some(target) = std::env::var_os("NOTIFY_SOCKET") else {
        return Ok(());
    };
    let bytes = target.as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.is_empty() || bytes.len() >= address.sun_path.len() {
        return Err(io::Error::other("invalid systemd notification socket"));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (index, byte) in bytes.iter().enumerate() {
        address.sun_path[index] = *byte as libc::c_char;
    }
    let abstract_socket = bytes[0] == b'@';
    if abstract_socket {
        address.sun_path[0] = 0;
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = unsafe { OwnedFd::from_raw_fd(fd) };
    let length = std::mem::offset_of!(libc::sockaddr_un, sun_path)
        + bytes.len()
        + usize::from(!abstract_socket);
    let result = unsafe {
        libc::sendto(
            socket.as_raw_fd(),
            message.as_ptr().cast(),
            message.len(),
            libc::MSG_NOSIGNAL,
            (&address as *const libc::sockaddr_un).cast(),
            length as libc::socklen_t,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // The check may have spawned helpers. Never leave descendants running after a timeout or stop.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}

fn wait(command: &mut Command, timeout: u64) -> io::Result<ExitStatus> {
    let mut process = Process(command.stdin(Stdio::null()).process_group(0).spawn()?);
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut heartbeat = Instant::now();
    loop {
        if STOP.load(Ordering::Relaxed) {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        if let Some(status) = process.0.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "child process exceeded its deadline",
            ));
        }
        if heartbeat.elapsed() >= Duration::from_secs(1) {
            notify("WATCHDOG=1")?;
            heartbeat = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn run(
    args: &[String],
    feature: &Path,
    manifest: &Path,
    output: &Path,
    interval: u64,
    timeout: u64,
) -> io::Result<()> {
    let result = supervise(args, feature, manifest, output, interval, timeout);
    if STOP.load(Ordering::Relaxed) {
        Ok(())
    } else {
        result
    }
}

struct ResultFile<'a>(&'a Path);
impl Drop for ResultFile<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0);
    }
}

fn supervise(
    args: &[String],
    feature: &Path,
    manifest: &Path,
    output: &Path,
    interval: u64,
    timeout: u64,
) -> io::Result<()> {
    for signal in [libc::SIGTERM, libc::SIGINT] {
        if unsafe { libc::signal(signal, stop as *const () as libc::sighandler_t) } == libc::SIG_ERR
        {
            return Err(io::Error::last_os_error());
        }
    }
    let state = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(state)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state.join("lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::other(
            "another conformance daemon is already running",
        ));
    }
    let _result_file = ResultFile(feature);
    let executable = std::env::current_exe()?;
    notify("READY=1\nSTATUS=Starting local conformance checks\nWATCHDOG=1")?;
    while !STOP.load(Ordering::Relaxed) {
        let cycle_started = Instant::now();
        let mut verifier = Command::new("/usr/bin/sha256sum");
        verifier
            .args(["--check", "--strict", "--status"])
            .arg(manifest);
        if !wait(
            &mut verifier,
            crate::conformance::VERIFICATION_TIMEOUT_SECONDS,
        )?
        .success()
        {
            return Err(io::Error::other("checker integrity verification failed"));
        }
        let mut check = Command::new(&executable);
        // Only the supervisor may notify systemd; one-shot children are never watchdog senders.
        check
            .arg("conformance")
            .args(args)
            .env_remove("NOTIFY_SOCKET")
            .env_remove("WATCHDOG_USEC")
            .env_remove("WATCHDOG_PID");
        let status = wait(&mut check, timeout)?;
        let decision = match status.code() {
            Some(0) => "pass",
            Some(1) => "fail",
            Some(2) => "error",
            _ => {
                return Err(io::Error::other(format!(
                    "checker exited unexpectedly: {status}"
                )))
            }
        };
        if !fs::read_to_string(feature)?.contains(&format!("krab.conformance.state={decision}\n")) {
            return Err(io::Error::other(
                "checker did not publish its reported result",
            ));
        }
        notify(&format!("WATCHDOG=1\nSTATUS=Local conformance: {decision}"))?;
        eprintln!("Local conformance: {decision}; cadence {interval}s");
        let scheduled = cycle_started + Duration::from_secs(interval);
        let next = if scheduled > Instant::now() {
            scheduled
        } else {
            Instant::now() + Duration::from_secs(interval)
        };
        while Instant::now() < next && !STOP.load(Ordering::Relaxed) {
            notify("WATCHDOG=1")?;
            std::thread::sleep(
                Duration::from_secs(1).min(next.saturating_duration_since(Instant::now())),
            );
        }
    }
    Ok(())
}
