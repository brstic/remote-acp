//! Secret storage for the bridge's *own* credential (the relay desktop
//! token). Provider sign-in caches (`~/.codex`, `~/.claude`) are never read.
//!
//! The default is an owner-only file in the app data directory: unlike the
//! OS keychain it does not trigger an authorization prompt every time the app
//! binary's signature changes (e.g. on each local rebuild).

use std::collections::HashMap;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()>;
    fn delete(&self, key: &str) -> anyhow::Result<()>;
    /// Human-readable backend name for diagnostics.
    fn backend(&self) -> &'static str;
    /// False when secrets are not protected by an OS credential store.
    fn is_secure(&self) -> bool;
}

/// In-memory store for tests and for running without any persistent secret
/// backend (secrets are lost on quit; the user is warned in diagnostics).
#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.map.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
    fn backend(&self) -> &'static str {
        "memory (not persisted)"
    }
    fn is_secure(&self) -> bool {
        false
    }
}

/// Owner-only (0600) JSON file, written atomically.
pub struct FileStore {
    path: std::path::PathBuf,
    lock: Mutex<()>,
}

impl FileStore {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into(), lock: Mutex::new(()) }
    }

    fn load(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, map: &HashMap<String, String>) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            use std::io::Write;
            let mut f = opts.open(&tmp)?;
            f.write_all(serde_json::to_string(map)?.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

impl SecretStore for FileStore {
    fn get(&self, key: &str) -> Option<String> {
        let _g = self.lock.lock().unwrap();
        self.load().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut m = self.load();
        m.insert(key.into(), value.into());
        self.save(&m)
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut m = self.load();
        if m.remove(key).is_some() {
            self.save(&m)?;
        }
        Ok(())
    }
    fn backend(&self) -> &'static str {
        "app data file (owner-only)"
    }
    fn is_secure(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_store_roundtrip_and_permissions() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub/secrets.json");
        let s = FileStore::new(&p);
        assert_eq!(s.get("a"), None);
        s.set("a", "1").unwrap();
        s.set("b", "2").unwrap();
        assert_eq!(FileStore::new(&p).get("a").as_deref(), Some("1"));
        s.delete("a").unwrap();
        assert_eq!(s.get("a"), None);
        assert_eq!(s.get("b").as_deref(), Some("2"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
