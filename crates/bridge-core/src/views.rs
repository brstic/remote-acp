//! Serializable view models shared with the desktop UI.

use chrono::{DateTime, Utc};
use connection_policy::{AccessLevel, GrantStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::providers::{CustomAgent, ProviderView};
use crate::store::{AuditEvent, TrustedService};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RelayStatus {
    Disconnected { message: String },
    Connecting,
    Connected {
        #[serde(rename = "latencyMs")]
        latency_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub relay_url: String,
    pub default_provider: Option<String>,
    pub require_task_approval_default: bool,
    pub notifications: bool,
    pub launch_at_login: bool,
    pub keep_in_tray: bool,
    pub theme: String,
    pub session_idle_minutes: u32,
    pub custom_agents: Vec<CustomAgent>,
    pub codex_subscription_acknowledged: bool,
}

impl Settings {
    pub fn defaults(relay_url: &str) -> Self {
        Self {
            relay_url: relay_url.into(),
            default_provider: None,
            require_task_approval_default: true,
            notifications: true,
            launch_at_login: false,
            keep_in_tray: false,
            theme: "system".into(),
            session_idle_minutes: 15,
            custom_agents: vec![],
            codex_subscription_acknowledged: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptItem {
    User { text: String },
    Agent { text: String },
    Thought { text: String },
    #[serde(rename_all = "camelCase")]
    Tool { tool_call_id: String, title: String, kind: String, status: String },
    Plan { entries: Vec<bridge_protocol::PlanEntry> },
    #[serde(rename_all = "camelCase")]
    Permission { request_id: String, title: String, outcome: Option<String> },
    Notice { text: String },
    Error { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    /// `remote` (from a website) or `local` (started in the desktop app)
    pub source: String,
    pub connection_id: Option<String>,
    pub service_name: Option<String>,
    pub service_domain: Option<String>,
    pub provider_id: String,
    pub workspace: String,
    pub state: bridge_protocol::TaskState,
    pub prompt: String,
    /// Website-provided instructions for this task (shown to the user).
    #[serde(default)]
    pub instructions: Option<String>,
    /// Website-provided tool servers (name and URL).
    #[serde(default)]
    pub tools: Vec<String>,
    pub transcript: Vec<TranscriptItem>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOptionView {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionView {
    pub request_id: String,
    pub task_id: String,
    pub title: String,
    pub kind: String,
    /// Redacted preview of the tool input (local display only).
    pub details: Option<String>,
    pub can_allow_for_task: bool,
    pub service_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceIdentity {
    pub id: String,
    pub display_name: String,
    pub origin: String,
    pub domain: String,
    pub verified: bool,
    pub verification: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequestView {
    pub pairing_id: String,
    pub service: ServiceIdentity,
    pub external_user_id: String,
    pub scopes: Vec<String>,
    pub expires_at: DateTime<Utc>,
    pub received_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptOptions {
    pub provider_id: String,
    pub workspace: String,
    pub access: AccessLevel,
    pub require_task_approval: bool,
    pub duration_secs: i64,
    #[serde(default)]
    pub acknowledge_terms: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub connection_id: String,
    pub service: Option<TrustedService>,
    pub external_user_id: String,
    pub provider_id: String,
    pub workspace: String,
    pub scopes: Vec<String>,
    pub require_task_approval: bool,
    pub access: AccessLevel,
    pub expires_at: DateTime<Utc>,
    pub status: GrantStatus,
    pub expired: bool,
    pub created_at: DateTime<Utc>,
    pub last_active_at: Option<DateTime<Utc>>,
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub paused: bool,
    pub relay: RelayStatus,
    pub relay_url: String,
    pub desktop_id: Option<String>,
    pub activity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub bridge: BridgeStatus,
    pub providers: Vec<ProviderView>,
    pub grants: Vec<GrantView>,
    pub pairing_requests: Vec<PairingRequestView>,
    pub tasks: Vec<TaskView>,
    pub permissions: Vec<PermissionView>,
    pub settings: Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiag {
    pub key: String,
    pub provider_id: String,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub protocol_version: u64,
    pub auth_methods: Vec<String>,
    pub modes: Vec<String>,
    pub current_mode: Option<String>,
    pub sandbox_enforced: bool,
    pub alive: bool,
    pub stderr_tail: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub relay_url: String,
    pub relay: RelayStatus,
    pub desktop_id: Option<String>,
    pub secret_backend: String,
    pub secret_backend_secure: bool,
    pub bridge_protocol_version: u32,
    pub acp_protocol_version: u64,
    pub providers: Vec<ProviderView>,
    pub sessions: Vec<SessionDiag>,
    pub recent_errors: Vec<String>,
    pub audit: Vec<AuditEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
    StateChanged,
    #[serde(rename_all = "camelCase")]
    TaskDelta { task_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    PermissionRequested { request_id: String, task_id: String, title: String, service_name: Option<String> },
    #[serde(rename_all = "camelCase")]
    TaskApprovalRequested { task_id: String, service_name: Option<String>, prompt: String },
    #[serde(rename_all = "camelCase")]
    PairingRequested { pairing_id: String, service_name: String },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
    #[serde(rename_all = "camelCase")]
    Raw { value: Value },
}
