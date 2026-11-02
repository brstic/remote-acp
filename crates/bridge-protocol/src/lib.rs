//! Remote ACP Bridge wire protocol (version 1).
//!
//! This is **not** an ACP network transport. It is a small, allowlisted,
//! application-level envelope exchanged between the relay and the desktop
//! bridge over an authenticated WebSocket. The desktop translates authorized
//! `task.*` requests into local ACP v1 calls and maps ACP session updates back
//! into sanitized [`TaskEvent`]s.
//!
//! Every inbound envelope must pass [`Envelope::validate`] before use.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Current bridge envelope version.
pub const PROTOCOL_VERSION: u32 = 1;
/// Maximum serialized size of a single envelope on the wire.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// Maximum total size of prompt text in a `task.start`.
pub const MAX_PROMPT_BYTES: usize = 64 * 1024;
/// Maximum size of a single text delta forwarded to the website.
pub const MAX_TEXT_DELTA_BYTES: usize = 256 * 1024;
/// Maximum length for identifiers (ids, codes).
pub const MAX_ID_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub version: u32,
    /// Unique message id (sender-generated).
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Per-task monotonically increasing sequence for task-scoped messages
    /// sent by the desktop; 0 for messages that are not sequenced.
    #[serde(default)]
    pub sequence: u64,
    pub created_at: DateTime<Utc>,
    #[serde(flatten)]
    pub body: Body,
}

/// Allowlisted message family. Unknown kinds fail to parse and are rejected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload")]
pub enum Body {
    /// desktop -> relay, first frame after the socket opens.
    #[serde(rename = "connection.hello")]
    Hello(Hello),
    /// relay -> desktop, reply to hello.
    #[serde(rename = "connection.ready")]
    Ready(Ready),
    /// either direction: a connection grant was revoked.
    #[serde(rename = "connection.revoke")]
    Revoke(Revoke),
    /// desktop -> relay: connection paused/resumed locally.
    #[serde(rename = "connection.state")]
    ConnectionState(ConnectionStatePayload),

    /// relay -> desktop: an authorized service asks to start a task.
    #[serde(rename = "task.start")]
    TaskStart(TaskStart),
    /// desktop -> relay
    #[serde(rename = "task.accepted")]
    TaskAccepted(Empty),
    /// desktop -> relay
    #[serde(rename = "task.rejected")]
    TaskRejected(ErrorPayload),
    /// relay -> desktop
    #[serde(rename = "task.cancel")]
    TaskCancel(Empty),
    /// desktop -> relay
    #[serde(rename = "task.event")]
    TaskEvent(TaskEvent),
    /// desktop -> relay
    #[serde(rename = "task.completed")]
    TaskCompleted(TaskCompleted),
    /// desktop -> relay
    #[serde(rename = "task.failed")]
    TaskFailed(ErrorPayload),

    #[serde(rename = "heartbeat")]
    Heartbeat(Empty),
    #[serde(rename = "error")]
    Error(ErrorPayload),
}

impl Body {
    pub fn kind(&self) -> &'static str {
        match self {
            Body::Hello(_) => "connection.hello",
            Body::Ready(_) => "connection.ready",
            Body::Revoke(_) => "connection.revoke",
            Body::ConnectionState(_) => "connection.state",
            Body::TaskStart(_) => "task.start",
            Body::TaskAccepted(_) => "task.accepted",
            Body::TaskRejected(_) => "task.rejected",
            Body::TaskCancel(_) => "task.cancel",
            Body::TaskEvent(_) => "task.event",
            Body::TaskCompleted(_) => "task.completed",
            Body::TaskFailed(_) => "task.failed",
            Body::Heartbeat(_) => "heartbeat",
            Body::Error(_) => "error",
        }
    }

    /// Whether this kind is permitted when sent by the desktop.
    pub fn allowed_from_desktop(&self) -> bool {
        matches!(
            self,
            Body::Hello(_)
                | Body::Revoke(_)
                | Body::ConnectionState(_)
                | Body::TaskAccepted(_)
                | Body::TaskRejected(_)
                | Body::TaskEvent(_)
                | Body::TaskCompleted(_)
                | Body::TaskFailed(_)
                | Body::Heartbeat(_)
                | Body::Error(_)
        )
    }

    /// Whether this kind is permitted when sent by the relay to a desktop.
    pub fn allowed_from_relay(&self) -> bool {
        matches!(
            self,
            Body::Ready(_)
                | Body::Revoke(_)
                | Body::TaskStart(_)
                | Body::TaskCancel(_)
                | Body::Heartbeat(_)
                | Body::Error(_)
        )
    }

    pub fn is_task_scoped(&self) -> bool {
        matches!(
            self,
            Body::TaskStart(_)
                | Body::TaskAccepted(_)
                | Body::TaskRejected(_)
                | Body::TaskCancel(_)
                | Body::TaskEvent(_)
                | Body::TaskCompleted(_)
                | Body::TaskFailed(_)
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub app_version: String,
    /// Bridge protocol versions this desktop supports.
    pub supported_versions: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub desktop_id: String,
    pub negotiated_version: u32,
    /// Connection ids the relay still considers active for this desktop.
    pub active_connections: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revoke {
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Active,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatePayload {
    pub state: ConnectionState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputBlock {
    Text { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMode {
    Interactive,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStart {
    /// Service-side user id this task is issued for. The desktop checks it
    /// against the grant's bound external user.
    pub external_user_id: String,
    pub input: Vec<InputBlock>,
    pub mode: TaskMode,
    /// Service id as authenticated by the relay (never taken from the browser).
    pub service_id: String,
}

impl TaskStart {
    pub fn prompt_text(&self) -> String {
        self.input
            .iter()
            .map(|b| match b {
                InputBlock::Text { text } => text.as_str(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

impl ErrorPayload {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompleted {
    /// ACP stop reason (`end_turn`, `max_tokens`, `refusal`, `cancelled`, ...).
    pub stop_reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Created,
    AwaitingApproval,
    Queued,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
    Rejected,
    Expired,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskState::Completed
                | TaskState::Cancelled
                | TaskState::Failed
                | TaskState::Rejected
                | TaskState::Expired
        )
    }

    /// Allowed state transitions (terminal states are monotonic).
    pub fn can_transition_to(self, next: TaskState) -> bool {
        use TaskState::*;
        if self.is_terminal() {
            return false;
        }
        match (self, next) {
            (Created, AwaitingApproval | Queued | Rejected | Expired | Failed | Cancelled) => true,
            (AwaitingApproval, Queued | Rejected | Expired | Cancelled | Failed) => true,
            (Queued, Running | Expired | Cancelled | Failed) => true,
            (Running, Completed | Cancelling | Failed | Cancelled) => true,
            (Cancelling, Cancelled | Completed | Failed) => true,
            _ => false,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Created => "created",
            TaskState::AwaitingApproval => "awaiting_approval",
            TaskState::Queued => "queued",
            TaskState::Running => "running",
            TaskState::Cancelling => "cancelling",
            TaskState::Completed => "completed",
            TaskState::Cancelled => "cancelled",
            TaskState::Failed => "failed",
            TaskState::Rejected => "rejected",
            TaskState::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    Allowed,
    Denied,
    Cancelled,
}

/// Sanitized, website-facing task events. Raw tool arguments, file contents
/// and local paths outside the event's own title are never forwarded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEvent {
    Status {
        state: TaskState,
    },
    TextDelta {
        text: String,
    },
    ThoughtDelta {
        text: String,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
    /// A local permission prompt is shown on the desktop. The website can
    /// observe it but can never answer it.
    #[serde(rename_all = "camelCase")]
    PermissionPending {
        request_id: String,
        title: String,
    },
    #[serde(rename_all = "camelCase")]
    PermissionResolved {
        request_id: String,
        outcome: PermissionOutcome,
    },
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ValidationError {
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u32),
    #[error("frame too large ({0} bytes)")]
    FrameTooLarge(usize),
    #[error("invalid json: {0}")]
    InvalidJson(String),
    #[error("field `{0}` is invalid")]
    InvalidField(&'static str),
    #[error("message kind `{0}` not permitted from this sender")]
    KindNotPermitted(&'static str),
    #[error("prompt too large")]
    PromptTooLarge,
}

fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_ID_LEN
        && s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.' || b == b':')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    Desktop,
    Relay,
}

impl Envelope {
    pub fn new(body: Body) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: format!("msg_{}", uuid::Uuid::new_v4().simple()),
            connection_id: None,
            task_id: None,
            sequence: 0,
            created_at: Utc::now(),
            body,
        }
    }

    pub fn for_task(body: Body, connection_id: &str, task_id: &str, sequence: u64) -> Self {
        let mut e = Self::new(body);
        e.connection_id = Some(connection_id.to_string());
        e.task_id = Some(task_id.to_string());
        e.sequence = sequence;
        e
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("envelope serialization is infallible")
    }

    /// Parse and validate an inbound frame from `sender`.
    pub fn parse(frame: &str, sender: Sender) -> Result<Self, ValidationError> {
        if frame.len() > MAX_FRAME_BYTES {
            return Err(ValidationError::FrameTooLarge(frame.len()));
        }
        let env: Envelope =
            serde_json::from_str(frame).map_err(|e| ValidationError::InvalidJson(e.to_string()))?;
        env.validate(sender)?;
        Ok(env)
    }

    pub fn validate(&self, sender: Sender) -> Result<(), ValidationError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ValidationError::UnsupportedVersion(self.version));
        }
        if !valid_id(&self.id) {
            return Err(ValidationError::InvalidField("id"));
        }
        if let Some(c) = &self.connection_id {
            if !valid_id(c) {
                return Err(ValidationError::InvalidField("connectionId"));
            }
        }
        if let Some(t) = &self.task_id {
            if !valid_id(t) {
                return Err(ValidationError::InvalidField("taskId"));
            }
        }
        let permitted = match sender {
            Sender::Desktop => self.body.allowed_from_desktop(),
            Sender::Relay => self.body.allowed_from_relay(),
        };
        if !permitted {
            return Err(ValidationError::KindNotPermitted(self.body.kind()));
        }
        if self.body.is_task_scoped() && (self.task_id.is_none() || self.connection_id.is_none()) {
            return Err(ValidationError::InvalidField("taskId"));
        }
        if matches!(self.body, Body::Revoke(_) | Body::ConnectionState(_))
            && self.connection_id.is_none()
        {
            return Err(ValidationError::InvalidField("connectionId"));
        }
        match &self.body {
            Body::TaskStart(ts) => {
                if ts.input.is_empty() {
                    return Err(ValidationError::InvalidField("input"));
                }
                let total: usize = ts
                    .input
                    .iter()
                    .map(|b| match b {
                        InputBlock::Text { text } => text.len(),
                    })
                    .sum();
                if total > MAX_PROMPT_BYTES {
                    return Err(ValidationError::PromptTooLarge);
                }
                if ts.external_user_id.is_empty() || ts.external_user_id.len() > 256 {
                    return Err(ValidationError::InvalidField("externalUserId"));
                }
                if !valid_id(&ts.service_id) {
                    return Err(ValidationError::InvalidField("serviceId"));
                }
            }
            Body::TaskEvent(TaskEvent::TextDelta { text } | TaskEvent::ThoughtDelta { text }) => {
                if text.len() > MAX_TEXT_DELTA_BYTES {
                    return Err(ValidationError::InvalidField("text"));
                }
            }
            Body::Error(e) | Body::TaskRejected(e) | Body::TaskFailed(e)
                if (e.code.len() > MAX_ID_LEN || e.message.len() > 4096) => {
                    return Err(ValidationError::InvalidField("error"));
                }
            _ => {}
        }
        Ok(())
    }
}

/// Grant scopes understood in protocol version 1.
pub mod scopes {
    pub const TASK_INTERACTIVE: &str = "task.interactive";
    pub const ALL: &[&str] = &[TASK_INTERACTIVE];

    pub fn is_known(s: &str) -> bool {
        ALL.contains(&s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_start() -> Envelope {
        Envelope::for_task(
            Body::TaskStart(TaskStart {
                external_user_id: "user-1".into(),
                input: vec![InputBlock::Text {
                    text: "hello".into(),
                }],
                mode: TaskMode::Interactive,
                service_id: "svc_demo".into(),
            }),
            "conn_1",
            "task_1",
            0,
        )
    }

    #[test]
    fn roundtrip_task_start() {
        let e = task_start();
        let json = e.to_json();
        assert!(json.contains("\"kind\":\"task.start\""));
        let back = Envelope::parse(&json, Sender::Relay).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn desktop_cannot_send_task_start() {
        let json = task_start().to_json();
        assert_eq!(
            Envelope::parse(&json, Sender::Desktop),
            Err(ValidationError::KindNotPermitted("task.start"))
        );
    }

    #[test]
    fn relay_cannot_send_task_events() {
        let e = Envelope::for_task(
            Body::TaskEvent(TaskEvent::TextDelta { text: "x".into() }),
            "conn_1",
            "task_1",
            1,
        );
        assert!(Envelope::parse(&e.to_json(), Sender::Relay).is_err());
        assert!(Envelope::parse(&e.to_json(), Sender::Desktop).is_ok());
    }

    #[test]
    fn rejects_unknown_kind_and_version() {
        let bad = r#"{"version":1,"id":"m1","sequence":0,"createdAt":"2026-11-02T19:00:00Z","kind":"exec.shell","payload":{"cmd":"rm -rf /"}}"#;
        assert!(matches!(
            Envelope::parse(bad, Sender::Relay),
            Err(ValidationError::InvalidJson(_))
        ));
        let mut e = task_start();
        e.version = 2;
        assert_eq!(
            Envelope::parse(&e.to_json(), Sender::Relay),
            Err(ValidationError::UnsupportedVersion(2))
        );
    }

    #[test]
    fn rejects_oversized_prompt_and_frame() {
        let mut e = task_start();
        if let Body::TaskStart(ts) = &mut e.body {
            ts.input = vec![InputBlock::Text {
                text: "a".repeat(MAX_PROMPT_BYTES + 1),
            }];
        }
        assert_eq!(
            Envelope::parse(&e.to_json(), Sender::Relay),
            Err(ValidationError::PromptTooLarge)
        );
        let huge = "x".repeat(MAX_FRAME_BYTES + 1);
        assert!(matches!(
            Envelope::parse(&huge, Sender::Relay),
            Err(ValidationError::FrameTooLarge(_))
        ));
    }

    #[test]
    fn rejects_bad_ids() {
        let mut e = task_start();
        e.task_id = Some("../../etc".into());
        assert!(Envelope::parse(&e.to_json(), Sender::Relay).is_err());
        let mut e = task_start();
        e.task_id = None;
        assert!(Envelope::parse(&e.to_json(), Sender::Relay).is_err());
    }

    #[test]
    fn task_state_terminal_monotonic() {
        use TaskState::*;
        assert!(Created.can_transition_to(AwaitingApproval));
        assert!(Running.can_transition_to(Cancelling));
        assert!(!Completed.can_transition_to(Running));
        assert!(!Cancelled.can_transition_to(Completed));
        assert!(!Running.can_transition_to(AwaitingApproval));
    }

    #[test]
    fn contract_fixtures_parse() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/contract");
        let mut n = 0;
        for entry in std::fs::read_dir(dir).expect("contract dir") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            let sender = match v["sender"].as_str().unwrap() {
                "desktop" => Sender::Desktop,
                _ => Sender::Relay,
            };
            let frame = v["envelope"].to_string();
            let valid = v["valid"].as_bool().unwrap();
            let res = Envelope::parse(&frame, sender);
            assert_eq!(res.is_ok(), valid, "fixture {:?}: {:?}", path, res);
            n += 1;
        }
        assert!(n >= 4);
    }
}

/// Opaque identifier and secret helpers shared by relay and desktop.
pub mod ids {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    /// URL-safe random token with `bytes` bytes of OS entropy.
    pub fn random_token(bytes: usize) -> String {
        let mut buf = vec![0u8; bytes];
        getrandom::fill(&mut buf).expect("OS random source unavailable");
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    }

    /// Prefixed opaque id, e.g. `conn_3k9...`.
    pub fn new_id(prefix: &str) -> String {
        let mut buf = [0u8; 12];
        getrandom::fill(&mut buf).expect("OS random source unavailable");
        format!("{prefix}_{}", hex::encode(buf))
    }

    /// Human-enterable pairing code (Crockford base32, 10 chars, ~50 bits),
    /// formatted as `XXXXX-XXXXX`.
    pub fn pairing_code() -> String {
        const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        let mut buf = [0u8; 10];
        getrandom::fill(&mut buf).expect("OS random source unavailable");
        let chars: String = buf.iter().map(|b| ALPHABET[(*b as usize) % 32] as char).collect();
        format!("{}-{}", &chars[..5], &chars[5..])
    }

    pub fn normalize_code(input: &str) -> String {
        let c: String = input
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_uppercase())
            .map(|c| match c {
                'O' => '0',
                'I' | 'L' => '1',
                c => c,
            })
            .collect();
        if c.len() == 10 {
            format!("{}-{}", &c[..5], &c[5..])
        } else {
            c
        }
    }

    pub fn sha256_hex(input: &str) -> String {
        hex::encode(Sha256::digest(input.as_bytes()))
    }

    /// Constant-time comparison of a presented secret against a stored hash.
    pub fn verify_secret(presented: &str, stored_sha256_hex: &str) -> bool {
        use subtle::ConstantTimeEq;
        let h = sha256_hex(presented);
        h.as_bytes().ct_eq(stored_sha256_hex.as_bytes()).into()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn tokens_and_codes() {
            let a = random_token(32);
            assert_eq!(a.len(), 43);
            assert_ne!(a, random_token(32));
            assert!(new_id("conn").starts_with("conn_"));
            let code = pairing_code();
            assert_eq!(code.len(), 11);
            assert_eq!(normalize_code(&code.to_lowercase().replace('-', " ")), code);
            let h = sha256_hex("secret");
            assert!(verify_secret("secret", &h));
            assert!(!verify_secret("Secret", &h));
        }
    }
}
