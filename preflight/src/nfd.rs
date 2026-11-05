//! File publication for the NFD local feature source.
use crate::conformance::Decision;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let temp = parent.join(format!(".krab-{}-{unique}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o644)
            .open(&temp)?;
        file.set_permissions(fs::Permissions::from_mode(0o644))?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn expiry(seconds: u64) -> io::Result<String> {
    let raw: libc::time_t = seconds.try_into().map_err(io::Error::other)?;
    let mut date: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&raw, &mut date) }.is_null() {
        return Err(io::Error::other("cannot format expiry time"));
    }
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        date.tm_year + 1900,
        date.tm_mon + 1,
        date.tm_mday,
        date.tm_hour,
        date.tm_min,
        date.tm_sec
    ))
}

pub(crate) fn publish(path: &Path, decision: Decision, started: u64, ttl: u64) -> io::Result<()> {
    let result = (|| {
        let expires = started
            .checked_add(ttl)
            .ok_or_else(|| io::Error::other("expiry overflow"))?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs();
        if now < started || now >= expires {
            return Err(io::Error::other(
                "clock changed or evidence expired before publication",
            ));
        }
        let state = match decision {
            Decision::Pass => "pass",
            Decision::Fail => "fail",
            Decision::Error => "error",
        };
        atomic_write(
            path,
            format!(
                "# +expiry-time={}\n# +no-label\nkrab.conformance.state={state}\n",
                expiry(expires)?
            )
            .as_bytes(),
        )
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_rfc3339_expiry_in_utc() {
        assert_eq!(expiry(0).unwrap(), "1970-01-01T00:00:00Z");
        assert_eq!(expiry(1709164800).unwrap(), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn expired_or_future_evidence_withdraws_previous_pass() {
        let path = std::env::temp_dir().join(format!("krab-nfd-expiry-{}", std::process::id()));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        publish(&path, Decision::Pass, now, 600).unwrap();
        assert!(publish(&path, Decision::Pass, now - 601, 600).is_err());
        assert!(!path.exists());
        publish(&path, Decision::Pass, now, 600).unwrap();
        assert!(publish(&path, Decision::Pass, now + 600, 600).is_err());
        assert!(!path.exists());
    }
}
