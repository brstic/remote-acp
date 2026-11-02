//! Remote ACP Bridge desktop engine.
//!
//! UI-framework independent: the Tauri app and the headless test harness both
//! drive this crate. All remote requests pass through local policy here
//! before anything reaches a local ACP agent.

pub mod engine;
pub mod guard;
pub mod providers;
pub mod relay_client;
pub mod secrets;
pub mod store;
pub mod views;

pub use engine::{redact, validate_relay_url, BResult, Bridge, BridgeConfig, BridgeError};
pub use views::*;

/// Default per-user data directory.
pub fn default_data_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("RemoteACPBridge")
}
