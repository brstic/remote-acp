//! In-memory routing state (pairings, online desktops, tasks) plus the
//! durable [`Store`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bridge_protocol::{Body, Envelope, TaskEvent};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::config::{RelayConfig, ServiceConfig, VerificationMode};
use crate::store::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingStatus {
    Pending,
    Claimed,
    Accepted,
    Rejected,
    Expired,
}

#[derive(Debug, Clone)]
pub struct Pairing {
    pub id: String,
    pub service_id: String,
    pub external_user_id: String,
    pub scopes: Vec<String>,
    pub ticket_sha256: String,
    pub code: String,
    pub expires_at: DateTime<Utc>,
    pub status: PairingStatus,
    pub claimed_by: Option<String>,
    pub connection_id: Option<String>,
}

impl Pairing {
    pub fn effective_status(&self, now: DateTime<Utc>) -> PairingStatus {
        match self.status {
            PairingStatus::Pending | PairingStatus::Claimed if now >= self.expires_at => PairingStatus::Expired,
            s => s,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayTaskState {
    /// Sent to the desktop, awaiting local acceptance.
    Pending,
    Running,
    Completed,
    Cancelled,
    Failed,
    Rejected,
}

impl RelayTaskState {
    pub fn is_terminal(self) -> bool {
        !matches!(self, RelayTaskState::Pending | RelayTaskState::Running)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    /// Relay-assigned, gap-free per-task sequence (SSE id).
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
}

pub struct TaskRec {
    pub id: String,
    pub service_id: String,
    pub connection_id: String,
    pub desktop_id: String,
    pub external_user_id: String,
    pub idempotency_key: String,
    pub request_hash: String,
    pub state: RelayTaskState,
    pub stop_reason: Option<String>,
    pub error: Option<(String, String)>,
    pub events: Vec<StoredEvent>,
    pub buffered_bytes: usize,
    pub buffer_truncated: bool,
    pub last_desktop_seq: u64,
    pub next_seq: u64,
    pub notify: broadcast::Sender<StoredEvent>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub cancel_requested: bool,
}

impl TaskRec {
    pub fn summary(&self) -> Value {
        json!({
            "taskId": self.id,
            "connectionId": self.connection_id,
            "state": self.state,
            "stopReason": self.stop_reason,
            "error": self.error.as_ref().map(|(c, m)| json!({"code": c, "message": m})),
            "createdAt": self.created_at,
            "finishedAt": self.finished_at,
        })
    }
}

pub struct DesktopLink {
    pub tx: mpsc::Sender<String>,
    pub generation: u64,
    pub kill: Arc<tokio::sync::Notify>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

#[derive(Default)]
pub struct Runtime {
    pub pairings: HashMap<String, Pairing>,
    pub tickets: HashMap<String, String>,
    pub codes: HashMap<String, String>,
    pub online: HashMap<String, DesktopLink>,
    pub offline_since: HashMap<String, DateTime<Utc>>,
    pub tasks: HashMap<String, TaskRec>,
    pub idempotency: HashMap<(String, String), String>,
    pub redeem_failures: HashMap<String, (u32, Instant)>,
    buckets: HashMap<String, Bucket>,
    next_generation: u64,
}

pub struct AppState {
    pub cfg: RelayConfig,
    pub store: Mutex<Store>,
    pub rt: Mutex<Runtime>,
    /// Verified status per service id (computed at startup).
    pub verified: Mutex<HashMap<String, bool>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(cfg: RelayConfig) -> anyhow::Result<Shared> {
        cfg.validate()?;
        let store = Store::open(&cfg.database)?;
        let mut verified = HashMap::new();
        for s in &cfg.services {
            verified.insert(s.id.clone(), s.verification == VerificationMode::Operator);
        }
        Ok(Arc::new(Self {
            cfg,
            store: Mutex::new(store),
            rt: Mutex::new(Runtime::default()),
            verified: Mutex::new(verified),
        }))
    }

    pub fn service(&self, id: &str) -> Option<&ServiceConfig> {
        self.cfg.services.iter().find(|s| s.id == id)
    }

    pub fn is_verified(&self, id: &str) -> bool {
        *self.verified.lock().unwrap().get(id).unwrap_or(&false)
    }

    /// Token-bucket rate limiter. Returns false when the caller is over budget.
    pub fn rate_ok(&self, key: &str, per_minute: u32) -> bool {
        let mut rt = self.rt.lock().unwrap();
        let now = Instant::now();
        let cap = per_minute.max(1) as f64;
        let b = rt.buckets.entry(key.to_string()).or_insert(Bucket { tokens: cap, last: now });
        let elapsed = now.duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * cap / 60.0).min(cap);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn register_online(&self, desktop_id: &str, tx: mpsc::Sender<String>) -> (u64, Arc<tokio::sync::Notify>) {
        let mut rt = self.rt.lock().unwrap();
        rt.next_generation += 1;
        let generation = rt.next_generation;
        let kill = Arc::new(tokio::sync::Notify::new());
        // A newer socket replaces an older one; close the old socket.
        if let Some(old) = rt.online.insert(desktop_id.to_string(), DesktopLink { tx, generation, kill: kill.clone() }) {
            old.kill.notify_one();
        }
        rt.offline_since.remove(desktop_id);
        (generation, kill)
    }

    /// Force-close a desktop's socket (operator action / tests).
    pub fn kick_desktop(&self, desktop_id: &str) -> bool {
        let rt = self.rt.lock().unwrap();
        match rt.online.get(desktop_id) {
            Some(l) => {
                l.kill.notify_one();
                true
            }
            None => false,
        }
    }

    pub fn unregister_online(&self, desktop_id: &str, generation: u64) {
        let mut rt = self.rt.lock().unwrap();
        if rt.online.get(desktop_id).map(|l| l.generation) == Some(generation) {
            rt.online.remove(desktop_id);
            rt.offline_since.insert(desktop_id.to_string(), Utc::now());
        }
    }

    pub fn is_online(&self, desktop_id: &str) -> bool {
        self.rt.lock().unwrap().online.contains_key(desktop_id)
    }

    /// Send an envelope to a desktop if it is online.
    pub fn send_to_desktop(&self, desktop_id: &str, env: &Envelope) -> bool {
        let tx = {
            let rt = self.rt.lock().unwrap();
            rt.online.get(desktop_id).map(|l| l.tx.clone())
        };
        match tx {
            Some(tx) => tx.try_send(env.to_json()).is_ok(),
            None => false,
        }
    }

    /// Append an event to a task buffer and notify live subscribers.
    pub fn push_event(rt: &mut Runtime, task_id: &str, kind: &str, payload: Value, limits: &crate::config::Limits) {
        let Some(t) = rt.tasks.get_mut(task_id) else { return };
        let ev = StoredEvent {
            seq: t.next_seq,
            kind: kind.to_string(),
            payload,
        };
        t.next_seq += 1;
        let size = ev.payload.to_string().len();
        if t.events.len() >= limits.max_buffered_events_per_task || t.buffered_bytes + size > limits.max_buffered_bytes_per_task {
            // Drop oldest events; late subscribers get resume_unavailable.
            if !t.events.is_empty() {
                let removed = t.events.remove(0);
                t.buffered_bytes = t.buffered_bytes.saturating_sub(removed.payload.to_string().len());
            }
            t.buffer_truncated = true;
        }
        t.buffered_bytes += size;
        t.events.push(ev.clone());
        let _ = t.notify.send(ev);
    }

    pub fn finish_task(
        rt: &mut Runtime,
        task_id: &str,
        state: RelayTaskState,
        stop_reason: Option<String>,
        error: Option<(String, String)>,
        limits: &crate::config::Limits,
    ) {
        let Some(t) = rt.tasks.get_mut(task_id) else { return };
        if t.state.is_terminal() {
            return;
        }
        t.state = state;
        t.stop_reason = stop_reason.clone();
        t.error = error.clone();
        t.finished_at = Some(Utc::now());
        let (kind, payload) = match state {
            RelayTaskState::Completed | RelayTaskState::Cancelled => (
                "task.completed",
                json!({"stopReason": stop_reason.unwrap_or_else(|| "cancelled".into())}),
            ),
            RelayTaskState::Rejected => {
                let (c, m) = error.unwrap_or(("rejected".into(), "Task was declined".into()));
                ("task.rejected", json!({"code": c, "message": m}))
            }
            _ => {
                let (c, m) = error.unwrap_or(("failed".into(), "Task failed".into()));
                ("task.failed", json!({"code": c, "message": m}))
            }
        };
        Self::push_event(rt, task_id, kind, payload, limits);
    }

    /// Process a validated envelope from a desktop.
    pub fn handle_desktop_envelope(&self, desktop_id: &str, env: Envelope) -> Option<Envelope> {
        let limits = &self.cfg.limits;
        match &env.body {
            Body::Heartbeat(_) => return Some(Envelope::new(Body::Heartbeat(Default::default()))),
            Body::Revoke(_) => {
                let cid = env.connection_id.as_deref().unwrap_or_default();
                let store = self.store.lock().unwrap();
                if let Ok(Some(c)) = store.connection(cid) {
                    if c.desktop_id == desktop_id {
                        let _ = store.set_connection_status(cid, "revoked");
                        drop(store);
                        let mut rt = self.rt.lock().unwrap();
                        let ids: Vec<String> = rt
                            .tasks
                            .values()
                            .filter(|t| t.connection_id == cid && !t.state.is_terminal())
                            .map(|t| t.id.clone())
                            .collect();
                        for id in ids {
                            Self::finish_task(
                                &mut rt,
                                &id,
                                RelayTaskState::Cancelled,
                                Some("cancelled".into()),
                                Some(("connection_revoked".into(), "The user disconnected this website".into())),
                                limits,
                            );
                        }
                    }
                }
                return None;
            }
            Body::ConnectionState(s) => {
                let cid = env.connection_id.as_deref().unwrap_or_default();
                let store = self.store.lock().unwrap();
                if let Ok(Some(c)) = store.connection(cid) {
                    if c.desktop_id == desktop_id {
                        let st = match s.state {
                            bridge_protocol::ConnectionState::Active => "active",
                            bridge_protocol::ConnectionState::Paused => "paused",
                        };
                        let _ = store.set_connection_status(cid, st);
                    }
                }
                return None;
            }
            Body::Hello(_) | Body::Error(_) => return None,
            _ => {}
        }

        // Task-scoped messages.
        let task_id = env.task_id.clone().unwrap_or_default();
        let mut rt = self.rt.lock().unwrap();
        let Some(task) = rt.tasks.get_mut(&task_id) else {
            return None;
        };
        // A desktop may only report on its own tasks, under the right connection.
        if task.desktop_id != desktop_id || Some(&task.connection_id) != env.connection_id.as_ref() {
            return Some(Envelope::new(Body::Error(bridge_protocol::ErrorPayload::new(
                "task_not_found",
                "unknown task",
            ))));
        }
        if task.state.is_terminal() {
            return None;
        }
        // Deduplicate / order by desktop sequence.
        if env.sequence != 0 {
            if env.sequence <= task.last_desktop_seq {
                return None;
            }
            task.last_desktop_seq = env.sequence;
        }
        match env.body {
            Body::TaskAccepted(_) => {
                if task.state == RelayTaskState::Pending {
                    task.state = RelayTaskState::Running;
                    Self::push_event(&mut rt, &task_id, "task.accepted", json!({}), limits);
                }
            }
            Body::TaskRejected(e) => Self::finish_task(
                &mut rt,
                &task_id,
                RelayTaskState::Rejected,
                None,
                Some((e.code, e.message)),
                limits,
            ),
            Body::TaskEvent(ev) => {
                if task.state == RelayTaskState::Pending {
                    if let TaskEvent::Status { .. } = ev {
                    } else {
                        task.state = RelayTaskState::Running;
                    }
                }
                let payload = serde_json::to_value(&ev).unwrap_or(Value::Null);
                Self::push_event(&mut rt, &task_id, "task.event", payload, limits);
            }
            Body::TaskCompleted(c) => {
                let st = if c.stop_reason == "cancelled" {
                    RelayTaskState::Cancelled
                } else {
                    RelayTaskState::Completed
                };
                Self::finish_task(&mut rt, &task_id, st, Some(c.stop_reason), None, limits)
            }
            Body::TaskFailed(e) => Self::finish_task(
                &mut rt,
                &task_id,
                RelayTaskState::Failed,
                None,
                Some((e.code, e.message)),
                limits,
            ),
            _ => {}
        }
        None
    }

    /// Periodic maintenance: expire pairings, fail tasks of desktops that
    /// stayed offline, enforce max durations and drop old terminal tasks.
    pub fn sweep(&self) {
        let now = Utc::now();
        let limits = self.cfg.limits.clone();
        let mut cancel_envs: Vec<(String, Envelope)> = vec![];
        {
            let mut rt = self.rt.lock().unwrap();
            // Pairings
            let expired: Vec<String> = rt
                .pairings
                .values()
                .filter(|p| p.effective_status(now) == PairingStatus::Expired && now - p.expires_at > Duration::minutes(10))
                .map(|p| p.id.clone())
                .collect();
            for id in expired {
                if let Some(p) = rt.pairings.remove(&id) {
                    rt.tickets.remove(&p.ticket_sha256);
                    rt.codes.remove(&p.code);
                }
            }
            // Tasks
            let mut to_fail: Vec<(String, &'static str, &'static str)> = vec![];
            for t in rt.tasks.values() {
                if t.state.is_terminal() {
                    continue;
                }
                if let Some(since) = rt.offline_since.get(&t.desktop_id) {
                    if now - *since > Duration::seconds(limits.desktop_offline_grace_secs) {
                        to_fail.push((t.id.clone(), "desktop_offline", "The desktop app went offline"));
                        continue;
                    }
                }
                if t.state == RelayTaskState::Pending
                    && now - t.created_at > Duration::seconds(limits.task_approval_timeout_secs)
                {
                    to_fail.push((t.id.clone(), "approval_timeout", "No one approved the task on the desktop in time"));
                    cancel_envs.push((
                        t.desktop_id.clone(),
                        Envelope::for_task(Body::TaskCancel(Default::default()), &t.connection_id, &t.id, 0),
                    ));
                    continue;
                }
                if now - t.created_at > Duration::seconds(limits.task_max_duration_secs) {
                    to_fail.push((t.id.clone(), "task_timeout", "The task exceeded the maximum duration"));
                    cancel_envs.push((
                        t.desktop_id.clone(),
                        Envelope::for_task(Body::TaskCancel(Default::default()), &t.connection_id, &t.id, 0),
                    ));
                }
            }
            for (id, code, msg) in to_fail {
                Self::finish_task(&mut rt, &id, RelayTaskState::Failed, None, Some((code.into(), msg.into())), &limits);
            }
            let old: Vec<String> = rt
                .tasks
                .values()
                .filter(|t| {
                    t.finished_at
                        .map(|f| now - f > Duration::seconds(limits.terminal_task_retention_secs))
                        .unwrap_or(false)
                })
                .map(|t| t.id.clone())
                .collect();
            for id in old {
                if let Some(t) = rt.tasks.remove(&id) {
                    rt.idempotency.remove(&(t.service_id, t.idempotency_key));
                }
            }
        }
        for (d, env) in cancel_envs {
            self.send_to_desktop(&d, &env);
        }
    }
}
