use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationMode {
    /// The relay operator vouches for the origin (manual review).
    Operator,
    /// Relay fetches `<origin>/.well-known/remote-acp.json` and checks the service id.
    WellKnown,
    /// Development only; desktop shows a strong "unverified" warning.
    Unverified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub id: String,
    pub display_name: String,
    /// HTTPS origin of the website, e.g. `https://app.example.com`.
    pub origin: String,
    /// SHA-256 (hex) of the service secret. The plain secret is never stored.
    pub secret_sha256: String,
    pub verification: VerificationMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    #[serde(default = "default_listen")]
    pub listen: String,
    /// Public base URL desktops are configured with (informational in links).
    #[serde(default = "default_public")]
    pub public_url: String,
    /// SQLite path for desktops and connections. `:memory:` for tests.
    #[serde(default = "default_db")]
    pub database: String,
    pub services: Vec<ServiceConfig>,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub pairing_ttl_max_secs: i64,
    pub grant_ttl_max_secs: i64,
    pub tasks_per_minute_per_service: u32,
    pub pairings_per_minute_per_service: u32,
    pub registrations_per_minute: u32,
    pub desktop_offline_grace_secs: i64,
    pub task_max_duration_secs: i64,
    pub task_approval_timeout_secs: i64,
    pub max_buffered_events_per_task: usize,
    pub max_buffered_bytes_per_task: usize,
    pub terminal_task_retention_secs: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            pairing_ttl_max_secs: 600,
            grant_ttl_max_secs: 30 * 24 * 3600,
            tasks_per_minute_per_service: 120,
            pairings_per_minute_per_service: 60,
            registrations_per_minute: 30,
            desktop_offline_grace_secs: 45,
            task_max_duration_secs: 2 * 3600,
            task_approval_timeout_secs: 10 * 60,
            max_buffered_events_per_task: 20_000,
            max_buffered_bytes_per_task: 16 * 1024 * 1024,
            terminal_task_retention_secs: 3600,
        }
    }
}

fn default_listen() -> String {
    "127.0.0.1:8787".into()
}
fn default_public() -> String {
    "http://127.0.0.1:8787".into()
}
fn default_db() -> String {
    "relay.sqlite3".into()
}

impl RelayConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        for s in &self.services {
            let u = url::Url::parse(&s.origin)?;
            let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if u.scheme() != "https" && !local {
                anyhow::bail!("service {} origin must be https", s.id);
            }
            if s.secret_sha256.len() != 64 {
                anyhow::bail!("service {} secretSha256 must be a hex sha256", s.id);
            }
            if !s.id.starts_with("svc_") {
                anyhow::bail!("service id {} must start with svc_", s.id);
            }
        }
        Ok(())
    }
}
