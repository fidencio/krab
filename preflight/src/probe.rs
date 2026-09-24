use std::fs;
use std::io;
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};

pub struct Paths {
    pub host_root: PathBuf,
    pub dev: PathBuf,
    pub sys: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        let host_root = std::env::var_os("KRAB_PREFLIGHT_HOST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        Self {
            dev: host_root.join("dev"),
            sys: host_root.join("sys"),
            host_root,
        }
    }
}

pub enum Result {
    Available,
    Unavailable(String),
    Skipped(String),
    Error(String),
}

pub fn boolean_file(path: &Path) -> Result {
    match fs::read_to_string(path) {
        Ok(value) => match value.trim() {
            "Y" | "y" | "1" => Result::Available,
            "N" | "n" | "0" => Result::Unavailable(format!("{} reports disabled", path.display())),
            other => Result::Error(format!("{} has unexpected value {other:?}", path.display())),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Result::Unavailable(format!("{} is absent", path.display()))
        }
        Err(error) => Result::Error(format!("cannot read {}: {error}", path.display())),
    }
}

pub fn character_device(path: &Path) -> Result {
    match fs::metadata(path) {
        Ok(metadata) if metadata.file_type().is_char_device() => Result::Available,
        Ok(_) => Result::Unavailable(format!("{} is not a character device", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Result::Unavailable(format!("{} is absent", path.display()))
        }
        Err(error) => Result::Error(format!("cannot inspect {}: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::{boolean_file, character_device, Result};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn boolean_file_distinguishes_disabled_missing_and_invalid_values() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("host-capabilities-{}-{unique}", std::process::id()));

        assert!(matches!(boolean_file(&path), Result::Unavailable(_)));
        fs::write(&path, "Y\n").unwrap();
        assert!(matches!(boolean_file(&path), Result::Available));
        fs::write(&path, "N\n").unwrap();
        assert!(matches!(boolean_file(&path), Result::Unavailable(_)));
        fs::write(&path, "unknown\n").unwrap();
        assert!(matches!(boolean_file(&path), Result::Error(_)));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn ordinary_file_is_not_a_device() {
        let path = std::env::current_exe().unwrap();
        assert!(matches!(character_device(&path), Result::Unavailable(_)));
    }
}
