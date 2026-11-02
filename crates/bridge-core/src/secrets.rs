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

/// OS credential store (macOS Keychain, Windows Credential Manager, Secret Service).
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    /// Check that the platform store actually works (Linux may lack a keyring).
    pub fn probe(&self) -> bool {
        let key = "__probe__";
        self.set(key, "ok").is_ok() && self.get(key).as_deref() == Some("ok") && self.delete(key).is_ok()
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new(&self.service, key).ok()?.get_password().ok()
    }
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        keyring::Entry::new(&self.service, key)?.set_password(value)?;
        Ok(())
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        match keyring::Entry::new(&self.service, key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    fn backend(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else if cfg!(windows) {
            "Windows Credential Manager"
        } else {
            "Secret Service"
        }
    }
    fn is_secure(&self) -> bool {
        true
    }
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

/// Pick the OS store when it works, else fall back to memory with a warning.
/// `service` namespaces items; use a different one per signing identity
/// (e.g. dev vs. release builds) so macOS does not prompt across builds.
pub fn default_store(service: &str) -> Box<dyn SecretStore> {
    let k = KeyringStore::new(service);
    if k.probe() {
        Box::new(k)
    } else {
        tracing::warn!("OS credential store unavailable; secrets will not persist");
        Box::new(MemoryStore::default())
    }
}
