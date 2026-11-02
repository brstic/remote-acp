//! Secret storage for the bridge's *own* credentials (relay desktop token)
//! and user-supplied API keys. Provider OAuth caches (`~/.codex`, Claude
//! Keychain items) are never read.

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
