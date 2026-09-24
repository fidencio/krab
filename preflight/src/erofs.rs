use crate::probe::{Paths, Result};
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

const PROGRAM: &str = "mkfs.erofs";
const REQUIRED_OPTIONS: &[&str] = &["mkfs-time", "sort"];

pub fn check(paths: &Paths) -> Result {
    let mut directories: Vec<PathBuf> = if paths.host_root == PathBuf::from("/") {
        env::var_os("PATH")
            .map(|path| env::split_paths(&path).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for directory in [
        "usr/local/sbin",
        "usr/local/bin",
        "usr/sbin",
        "sbin",
        "usr/bin",
        "bin",
    ] {
        directories.push(paths.host_root.join(directory));
    }
    check_in_directories(&directories)
}

fn check_in_directories(directories: &[PathBuf]) -> Result {
    for directory in directories {
        let path = directory.join(PROGRAM);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Result::Error(format!("cannot inspect {}: {error}", path.display()))
            }
        };
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            continue;
        }

        let binary = match fs::read(&path) {
            Ok(binary) => binary,
            Err(error) => return Result::Error(format!("cannot read {}: {error}", path.display())),
        };
        let missing: Vec<_> = REQUIRED_OPTIONS
            .iter()
            .copied()
            .filter(|option| !contains_c_string(&binary, option.as_bytes()))
            .collect();
        if missing.is_empty() {
            return Result::Available;
        }
        return Result::Unavailable(format!(
            "{} lacks required option(s): {}",
            path.display(),
            missing.join(", ")
        ));
    }
    Result::Unavailable("mkfs.erofs executable was not found".into())
}

// Match option names as complete C strings, as Kata Deploy does when inspecting
// the host binary without running it.
fn contains_c_string(binary: &[u8], option: &[u8]) -> bool {
    binary
        .windows(option.len() + 1)
        .enumerate()
        .any(|(offset, window)| {
            window[..option.len()] == *option
                && window[option.len()] == 0
                && (offset == 0 || !binary[offset - 1].is_ascii_graphic())
        })
}

#[cfg(test)]
mod tests {
    use super::{check_in_directories, contains_c_string};
    use crate::probe::Result;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn option_names_must_be_complete_c_strings() {
        assert!(contains_c_string(b"\0mkfs-time\0", b"mkfs-time"));
        assert!(!contains_c_string(b"\0mkfs-timeout\0", b"mkfs-time"));
        assert!(!contains_c_string(b"qsort\0", b"sort"));
    }

    #[test]
    fn checks_the_first_executable_in_search_order() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "host-capabilities-erofs-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let binary = directory.join("mkfs.erofs");
        assert!(matches!(
            check_in_directories(&[directory.clone()]),
            Result::Unavailable(_)
        ));

        fs::write(&binary, b"\0mkfs-time\0sort\0").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            check_in_directories(&[directory.clone()]),
            Result::Available
        ));

        fs::write(&binary, b"\0mkfs-time\0qsort\0").unwrap();
        assert!(matches!(
            check_in_directories(&[directory.clone()]),
            Result::Unavailable(_)
        ));

        fs::remove_file(binary).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
