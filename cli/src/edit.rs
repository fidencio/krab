use crate::config::{Config, Result};
use crate::values;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Document {
    pub config: Config,
    path: PathBuf,
    source: String,
}

struct Temporary(PathBuf);

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl Document {
    pub fn load(path: &Path, catalog: &Value) -> Result<Self> {
        if path == Path::new("-") {
            return Err(
                "edit requires a configuration file; use --output - to emit updated YAML".into(),
            );
        }
        let path = fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let source = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let config = krab_core::product::normalize(&Config::parse(&source)?, catalog)?;
        values::build(&config, catalog)?;
        Ok(Self {
            config,
            path,
            source,
        })
    }

    pub fn save(&self, config: &Config, destination: &Path, force: bool) -> Result<()> {
        let source = serde_yaml_ng::to_string(config).map_err(|e| e.to_string())?;
        if destination == Path::new("-") {
            return crate::stdout(&source);
        }
        let same_file = fs::canonicalize(destination).is_ok_and(|p| p == self.path);
        let destination = if same_file {
            self.path.as_path()
        } else {
            destination
        };
        if same_file {
            self.check_unchanged()?;
            if serde_json::to_value(&self.config).map_err(|e| e.to_string())?
                == serde_json::to_value(config).map_err(|e| e.to_string())?
            {
                return Ok(());
            }
        }
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let temporary_path = parent.join(format!(".krab-edit-{}-{nonce}.tmp", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary_path)
            .map_err(|e| format!("{}: {e}", destination.display()))?;
        let temporary = Temporary(temporary_path);
        file.write_all(source.as_bytes())
            .map_err(|e| e.to_string())?;
        let permissions = fs::metadata(&self.path)
            .map_err(|e| e.to_string())?
            .permissions();
        file.set_permissions(permissions)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if same_file {
            self.check_unchanged()?;
        }
        if same_file || force {
            fs::rename(&temporary.0, destination)
                .map_err(|e| format!("{}: {e}", destination.display()))?;
        } else {
            // Atomically refuse an existing save-as destination, including races.
            fs::hard_link(&temporary.0, destination)
                .map_err(|e| format!("{}: {e}", destination.display()))?;
        }
        Ok(())
    }

    fn check_unchanged(&self) -> Result<()> {
        let current =
            fs::read_to_string(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        if current != self.source {
            return Err(format!(
                "{} changed while editing; reopen it before saving",
                self.path.display()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn saving_preserves_permissions_refuses_collisions_and_detects_concurrent_changes() {
        let dir = std::env::temp_dir().join(format!("krab-edit-save-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("krab.yaml");
        let source = "apiVersion: krab/v1alpha1\nvendor: custom\ndistribution: kubeadm\narchitectures: [amd64]\nruntimes: [qemu-runtime-rs]\n";
        fs::write(&path, source).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let catalog = crate::config::catalog();
        let document = Document::load(&path, &catalog).unwrap();
        let mut changed = document.config.clone();
        changed.release = "edited".into();
        document.save(&changed, &path, false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            Config::parse(&fs::read_to_string(&path).unwrap())
                .unwrap()
                .release,
            "edited"
        );

        let document = Document::load(&path, &catalog).unwrap();
        let occupied = dir.join("occupied.yaml");
        fs::write(&occupied, "keep this file").unwrap();
        assert!(document.save(&changed, &occupied, false).is_err());
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "keep this file");
        let externally_changed = format!(
            "# Changed by another editor\n{}",
            fs::read_to_string(&path).unwrap()
        );
        fs::write(&path, &externally_changed).unwrap();
        let error = document.save(&changed, &path, false).unwrap_err();
        assert!(error.contains("changed while editing"));
        assert_eq!(fs::read_to_string(&path).unwrap(), externally_changed);
        fs::remove_dir_all(dir).unwrap();
    }
}
