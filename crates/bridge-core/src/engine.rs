//! The bridge engine: mediates every remote request through local policy and
//! owns the local ACP lifecycle.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use agent_host::acp::{
    InitializeResponse, PermissionDecision, ReadTextFileRequest, RequestPermissionRequest, SessionUpdate,
    WriteTextFileRequest,
};
use agent_host::{AgentHost, ClientError, ClientHandler, HostError, HostEvent, Limits};
use async_trait::async_trait;
use bridge_protocol::{
    Body, Envelope, ErrorPayload, PermissionOutcome, TaskCompleted, TaskEvent, TaskStart, TaskState,
    MAX_TEXT_DELTA_BYTES,
};
use chrono::{Duration as ChronoDuration, Utc};
use connection_policy::{AccessLevel, Grant, GrantStatus, Workspace};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::providers::{self, AuthMode, ProviderEnv, ProviderState, ProviderView, RemotePolicy};
use crate::relay_client;
use crate::secrets::SecretStore;
use crate::store::{Store, TaskRow, TrustedService};
use crate::views::*;

pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const PERMISSION_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const CANCEL_GRACE: Duration = Duration::from_secs(10);
const MAX_LIVE_TASKS: usize = 30;
const MAX_TRANSCRIPT_ITEMS: usize = 2000;
/// Tool kinds for which "Allow for this task" may be offered.
const TASK_SCOPED_SAFE_KINDS: &[&str] = &["read", "search", "edit", "think", "fetch"];

pub struct BridgeConfig {
    pub data_dir: PathBuf,
    pub default_relay_url: String,
    pub app_version: String,
    /// Command that runs the built-in mock ACP agent (None hides it).
    pub mock_command: Option<(PathBuf, Vec<String>)>,
    pub secrets: Arc<dyn SecretStore>,
    pub in_memory_db: bool,
}

pub(crate) struct LiveTask {
    pub view: TaskView,
    pub approval_tx: Option<oneshot::Sender<bool>>,
    pub cancel_tx: watch::Sender<bool>,
    pub seq: u64,
    pub allowed_kinds: HashSet<String>,
    /// Set when the output firewall stopped the task; nothing more is sent.
    pub blocked: Option<String>,
    pub scan_tail: String,
}

struct PendingPermission {
    view: PermissionView,
    options: Vec<agent_host::acp::PermissionOption>,
    tx: Option<oneshot::Sender<PermissionDecision>>,
}

struct LiveSession {
    host: AgentHost,
    session_id: String,
    events: Arc<tokio::sync::Mutex<mpsc::Receiver<HostEvent>>>,
    handler: Arc<SessionHandler>,
    last_used: Instant,
    provider_id: String,
    init: InitializeResponse,
    modes: Vec<String>,
    current_mode: Option<String>,
    sandbox_enforced: bool,
}

pub(crate) struct Inner {
    pub cfg: BridgeConfig,
    pub store: Mutex<Store>,
    pub ui_tx: broadcast::Sender<UiEvent>,
    pub out_tx: mpsc::Sender<Envelope>,
    pub relay_status: Mutex<RelayStatus>,
    pub desktop_id: Mutex<Option<String>>,
    pub restart_relay: tokio::sync::Notify,
    pub http: reqwest::Client,
    paused: AtomicBool,
    settings: Mutex<Settings>,
    pairing_requests: Mutex<HashMap<String, PairingRequestView>>,
    tasks: Mutex<HashMap<String, LiveTask>>,
    task_order: Mutex<VecDeque<String>>,
    sessions: tokio::sync::Mutex<HashMap<String, LiveSession>>,
    permissions: Mutex<HashMap<String, PendingPermission>>,
    providers: Mutex<Vec<ProviderView>>,
    errors: Mutex<VecDeque<String>>,
}

#[derive(Clone)]
pub struct Bridge {
    pub(crate) inner: Arc<Inner>,
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("{0}")]
    User(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for BridgeError {
    fn from(e: rusqlite::Error) -> Self {
        BridgeError::Internal(e.to_string())
    }
}

pub type BResult<T> = Result<T, BridgeError>;

fn user<T>(msg: impl Into<String>) -> BResult<T> {
    Err(BridgeError::User(msg.into()))
}

/// Remove secrets-looking substrings and local absolute paths from text that
/// may leave the machine or end up in diagnostics.
pub fn redact(text: &str, workspace: Option<&std::path::Path>) -> String {
    let mut s = text.to_string();
    if let Some(ws) = workspace {
        let w = ws.to_string_lossy();
        if !w.is_empty() {
            s = s.replace(w.as_ref(), ".");
        }
    }
    if let Some(home) = dirs::home_dir() {
        let h = home.to_string_lossy();
        if h.len() > 1 {
            s = s.replace(h.as_ref(), "~");
        }
    }
    // Mask token-like words.
    s.split_inclusive(char::is_whitespace)
        .map(|w| {
            let t = w.trim();
            let looks_secret = t.starts_with("sk-")
                || t.starts_with("Bearer")
                || (t.len() >= 32 && t.chars().all(|c| c.is_ascii_alphanumeric() || "-_.=".contains(c)) && t.chars().any(|c| c.is_ascii_digit()));
            if looks_secret {
                w.replace(t, "[redacted]")
            } else {
                w.to_string()
            }
        })
        .collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

pub fn validate_relay_url(s: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(s.trim()).map_err(|_| "Enter a valid relay URL".to_string())?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    match u.scheme() {
        "https" => Ok(u),
        "http" if local => Ok(u),
        "http" => Err("Relay connections must use https (plain http is only allowed for localhost)".into()),
        _ => Err("Relay URL must start with https://".into()),
    }
}

impl Bridge {
    pub async fn start(cfg: BridgeConfig) -> BResult<Bridge> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        std::fs::create_dir_all(&cfg.data_dir).map_err(|e| BridgeError::Internal(e.to_string()))?;
        let store = if cfg.in_memory_db {
            Store::open_in_memory()?
        } else {
            Store::open(&cfg.data_dir.join("bridge.sqlite3"))?
        };
        let interrupted = store.fail_interrupted_tasks()?;
        if interrupted > 0 {
            store.audit(None, None, "tasks_interrupted", json!({"count": interrupted}));
        }
        let settings = store
            .get_setting("settings")
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_else(|| Settings::defaults(&cfg.default_relay_url));
        let paused = store.get_setting("paused").as_deref() == Some("true");
        let (ui_tx, _) = broadcast::channel(4096);
        let (out_tx, out_rx) = mpsc::channel(4096);
        let inner = Arc::new(Inner {
            cfg,
            store: Mutex::new(store),
            ui_tx,
            out_tx,
            relay_status: Mutex::new(RelayStatus::Connecting),
            desktop_id: Mutex::new(None),
            restart_relay: tokio::sync::Notify::new(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| BridgeError::Internal(e.to_string()))?,
            paused: AtomicBool::new(paused),
            settings: Mutex::new(settings),
            pairing_requests: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            task_order: Mutex::new(VecDeque::new()),
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            providers: Mutex::new(vec![]),
            errors: Mutex::new(VecDeque::new()),
        });
        let bridge = Bridge { inner };
        tokio::spawn(relay_client::run(bridge.clone(), out_rx));
        {
            let b = bridge.clone();
            tokio::spawn(async move {
                let mut iv = tokio::time::interval(Duration::from_secs(30));
                loop {
                    iv.tick().await;
                    b.sweep_idle_sessions().await;
                }
            });
        }
        bridge.refresh_providers().await;
        Ok(bridge)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<UiEvent> {
        self.inner.ui_tx.subscribe()
    }

    pub(crate) fn emit(&self, e: UiEvent) {
        let _ = self.inner.ui_tx.send(e);
    }

    pub(crate) fn changed(&self) {
        self.emit(UiEvent::StateChanged);
    }

    pub(crate) fn record_error(&self, msg: impl Into<String>) {
        let msg = redact(&msg.into(), None);
        let mut q = self.inner.errors.lock().unwrap();
        if q.len() >= 50 {
            q.pop_front();
        }
        q.push_back(format!("{} {}", Utc::now().format("%H:%M:%S"), msg));
    }

    pub fn settings(&self) -> Settings {
        self.inner.settings.lock().unwrap().clone()
    }

    pub fn relay_url(&self) -> String {
        self.inner.settings.lock().unwrap().relay_url.clone()
    }

    pub fn update_settings(&self, mut s: Settings) -> BResult<Settings> {
        if let Err(e) = validate_relay_url(&s.relay_url) {
            return user(e);
        }
        s.session_idle_minutes = s.session_idle_minutes.clamp(1, 240);
        let relay_changed = {
            let mut cur = self.inner.settings.lock().unwrap();
            // Custom agents are only changed through add/remove calls.
            s.custom_agents = cur.custom_agents.clone();
            let changed = cur.relay_url != s.relay_url;
            *cur = s.clone();
            changed
        };
        self.persist_settings()?;
        if relay_changed {
            self.inner.restart_relay.notify_one();
        }
        self.changed();
        Ok(s)
    }

    fn persist_settings(&self) -> BResult<()> {
        let json = serde_json::to_string(&*self.inner.settings.lock().unwrap()).unwrap();
        self.inner.store.lock().unwrap().set_setting("settings", &json)?;
        Ok(())
    }

    fn provider_env(&self) -> ProviderEnv<'_> {
        let s = self.inner.settings.lock().unwrap();
        ProviderEnv {
            adapters_dir: self.inner.cfg.data_dir.join("adapters"),
            mock_command: self.inner.cfg.mock_command.clone(),
            secrets: self.inner.cfg.secrets.as_ref(),
            custom_agents: s.custom_agents.clone(),
            codex_mode: AuthMode::Subscription,
        }
    }

    pub async fn refresh_providers(&self) -> Vec<ProviderView> {
        let list = providers::detect(&self.provider_env()).await;
        *self.inner.providers.lock().unwrap() = list.clone();
        self.changed();
        list
    }

    pub fn providers(&self) -> Vec<ProviderView> {
        self.inner.providers.lock().unwrap().clone()
    }

    pub async fn install_adapter(&self, provider: &str) -> BResult<String> {
        let dir = self.inner.cfg.data_dir.join("adapters");
        let res = providers::install_adapter(&dir, provider).await;
        self.inner
            .store
            .lock()
            .unwrap()
            .audit(None, None, "adapter_install", json!({"provider": provider, "ok": res.is_ok()}));
        self.refresh_providers().await;
        res.map_err(BridgeError::User)
    }

    pub async fn provider_sign_in(&self, provider: &str) -> BResult<()> {
        match provider {
            "codex" => providers::codex_sign_in().await.map_err(BridgeError::User),
            "claude" => providers::claude_sign_in().await.map_err(BridgeError::User),
            _ => user("This provider has no sign-in"),
        }
    }

    pub async fn provider_sign_out(&self, provider: &str) -> BResult<()> {
        let r = match provider {
            "codex" => providers::codex_sign_out().await.map_err(BridgeError::User),
            "claude" => providers::claude_sign_out().await.map_err(BridgeError::User),
            _ => user("This provider has no sign-out"),
        };
        self.close_sessions_for_provider(provider).await;
        self.refresh_providers().await;
        r
    }

    pub async fn add_custom_agent(&self, name: &str, program: &str, args: Vec<String>) -> BResult<()> {
        let p = PathBuf::from(program);
        if !p.is_absolute() || !p.is_file() {
            return user("Choose the agent's executable file (absolute path)");
        }
        let sha = providers::sha256_file(&p).ok_or_else(|| BridgeError::User("Can't read executable".into()))?;
        let id = format!("custom:{}", bridge_protocol::ids::new_id("agent"));
        {
            let mut s = self.inner.settings.lock().unwrap();
            s.custom_agents.push(providers::CustomAgent {
                id,
                name: truncate(name.trim(), 60),
                program: p,
                args,
                sha256: sha,
            });
        }
        self.persist_settings()?;
        self.refresh_providers().await;
        Ok(())
    }

    pub async fn remove_custom_agent(&self, id: &str) -> BResult<()> {
        self.inner.settings.lock().unwrap().custom_agents.retain(|c| c.id != id);
        self.persist_settings()?;
        self.close_sessions_for_provider(id).await;
        self.refresh_providers().await;
        Ok(())
    }

    // ---------------------------------------------------------------- state

    pub fn is_paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    /// Global kill switch: stops all running tasks and refuses new ones.
    pub async fn set_paused(&self, paused: bool) -> BResult<()> {
        self.inner.paused.store(paused, Ordering::SeqCst);
        self.inner
            .store
            .lock()
            .unwrap()
            .set_setting("paused", if paused { "true" } else { "false" })?;
        self.inner
            .store
            .lock()
            .unwrap()
            .audit(None, None, if paused { "bridge_paused" } else { "bridge_resumed" }, json!({}));
        if paused {
            let ids: Vec<String> = self
                .inner
                .tasks
                .lock()
                .unwrap()
                .values()
                .filter(|t| !t.view.state.is_terminal())
                .map(|t| t.view.id.clone())
                .collect();
            for id in ids {
                self.cancel_task(&id, "bridge paused").await;
            }
        }
        self.changed();
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        let store = self.inner.store.lock().unwrap();
        let services: HashMap<String, TrustedService> =
            store.services().unwrap_or_default().into_iter().map(|s| (s.id.clone(), s)).collect();
        let busy: HashSet<String> = self
            .inner
            .tasks
            .lock()
            .unwrap()
            .values()
            .filter(|t| !t.view.state.is_terminal())
            .filter_map(|t| t.view.connection_id.clone())
            .collect();
        let now = Utc::now();
        let grants = store
            .grants()
            .unwrap_or_default()
            .into_iter()
            .map(|g| GrantView {
                connection_id: g.grant.connection_id.clone(),
                service: services.get(&g.grant.service_id).cloned(),
                external_user_id: g.grant.external_user_id.clone(),
                provider_id: g.grant.provider_id.clone(),
                workspace: g.grant.workspace_root.to_string_lossy().to_string(),
                scopes: g.grant.scopes.clone(),
                require_task_approval: g.grant.require_task_approval,
                access: g.grant.access,
                expires_at: g.grant.expires_at,
                status: g.grant.status,
                expired: now >= g.grant.expires_at,
                created_at: g.created_at,
                last_active_at: g.last_active_at,
                busy: busy.contains(&g.grant.connection_id),
            })
            .collect();
        drop(store);
        let tasks = {
            let order = self.inner.task_order.lock().unwrap();
            let map = self.inner.tasks.lock().unwrap();
            order.iter().rev().filter_map(|id| map.get(id).map(|t| t.view.clone())).collect::<Vec<_>>()
        };
        let activity = if !self.inner.permissions.lock().unwrap().is_empty()
            || tasks.iter().any(|t| t.state == TaskState::AwaitingApproval)
        {
            "waiting_for_approval"
        } else if tasks.iter().any(|t| !t.state.is_terminal()) {
            "working"
        } else {
            "idle"
        };
        let mut pairing_requests: Vec<PairingRequestView> =
            self.inner.pairing_requests.lock().unwrap().values().cloned().collect();
        pairing_requests.retain(|p| p.expires_at > now);
        Snapshot {
            bridge: BridgeStatus {
                paused: self.is_paused(),
                relay: self.inner.relay_status.lock().unwrap().clone(),
                relay_url: self.relay_url(),
                desktop_id: self.inner.desktop_id.lock().unwrap().clone(),
                activity: activity.into(),
            },
            providers: self.providers(),
            grants,
            pairing_requests,
            tasks,
            permissions: self.inner.permissions.lock().unwrap().values().map(|p| p.view.clone()).collect(),
            settings: self.settings(),
        }
    }

    pub async fn diagnostics(&self) -> Diagnostics {
        let sessions = {
            let map = self.inner.sessions.lock().await;
            map.iter()
                .map(|(k, s)| SessionDiag {
                    key: if k.starts_with("local:") { "local".into() } else { k.clone() },
                    provider_id: s.provider_id.clone(),
                    agent_name: s.init.agent_info.as_ref().map(|a| a.name.clone()),
                    agent_version: s.init.agent_info.as_ref().map(|a| a.version.clone()),
                    protocol_version: s.init.protocol_version,
                    auth_methods: s.init.auth_methods.iter().map(|m| m.id.clone()).collect(),
                    modes: s.modes.clone(),
                    current_mode: s.current_mode.clone(),
                    sandbox_enforced: s.sandbox_enforced,
                    alive: s.host.is_alive(),
                    stderr_tail: s.host.stderr_tail().iter().rev().take(30).rev().map(|l| redact(l, None)).collect(),
                })
                .collect()
        };
        Diagnostics {
            app_version: self.inner.cfg.app_version.clone(),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            relay_url: self.relay_url(),
            relay: self.inner.relay_status.lock().unwrap().clone(),
            desktop_id: self.inner.desktop_id.lock().unwrap().clone(),
            secret_backend: self.inner.cfg.secrets.backend().into(),
            secret_backend_secure: self.inner.cfg.secrets.is_secure(),
            bridge_protocol_version: bridge_protocol::PROTOCOL_VERSION,
            acp_protocol_version: agent_host::acp::ACP_PROTOCOL_VERSION,
            providers: self.providers(),
            sessions,
            recent_errors: self.inner.errors.lock().unwrap().iter().cloned().collect(),
            audit: self.inner.store.lock().unwrap().audit_events(100).unwrap_or_default(),
        }
    }

    pub fn clear_diagnostics(&self) -> BResult<()> {
        self.inner.errors.lock().unwrap().clear();
        self.inner.store.lock().unwrap().clear_audit()?;
        self.changed();
        Ok(())
    }

    // ------------------------------------------------------------- pairing

    /// Redeem a pairing link (`remoteacp://pair?...`) or code. Returns the
    /// relay-verified service identity for the consent screen. Nothing is
    /// granted until [`Bridge::accept_pairing`].
    pub async fn begin_pairing(&self, input: &str) -> BResult<PairingRequestView> {
        let input = input.trim();
        let body = if input.to_lowercase().starts_with("remoteacp:") {
            let u = url::Url::parse(input).map_err(|_| BridgeError::User("This pairing link is invalid".into()))?;
            if u.host_str() != Some("pair") && u.path().trim_matches('/') != "pair" {
                return user("This link is not a pairing link");
            }
            let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
            let ticket = q.get("ticket").filter(|t| !t.is_empty() && t.len() <= 128).ok_or_else(|| BridgeError::User("This pairing link is invalid".into()))?;
            if let Some(r) = q.get("relay") {
                let mine = self.relay_url();
                if r.trim_end_matches('/') != mine.trim_end_matches('/') {
                    return user(format!(
                        "This link is for a different relay ({r}). Your app uses {mine}. Change the relay in Settings only if you trust it."
                    ));
                }
            }
            json!({"ticket": ticket})
        } else {
            let code = bridge_protocol::ids::normalize_code(input);
            if code.len() != 11 {
                return user("Enter the 10-character code shown on the website");
            }
            json!({"code": code})
        };
        let v = relay_client::post(self, "/v1/pairings/redeem", body).await?;
        let s = &v["service"];
        let view = PairingRequestView {
            pairing_id: v["pairingId"].as_str().unwrap_or_default().into(),
            service: ServiceIdentity {
                id: s["id"].as_str().unwrap_or_default().into(),
                display_name: s["displayName"].as_str().unwrap_or_default().into(),
                origin: s["origin"].as_str().unwrap_or_default().into(),
                domain: s["domain"].as_str().unwrap_or_default().into(),
                verified: s["verified"].as_bool().unwrap_or(false),
                verification: s["verification"].as_str().unwrap_or("unverified").into(),
            },
            external_user_id: v["externalUserId"].as_str().unwrap_or_default().into(),
            scopes: serde_json::from_value(v["scopes"].clone()).unwrap_or_default(),
            expires_at: serde_json::from_value(v["expiresAt"].clone()).unwrap_or_else(|_| Utc::now()),
            received_at: Utc::now(),
        };
        if view.pairing_id.is_empty() || view.service.id.is_empty() {
            return Err(BridgeError::Internal("relay returned an incomplete pairing".into()));
        }
        self.inner.store.lock().unwrap().audit(
            None,
            None,
            "pairing_requested",
            json!({"service": view.service.id, "domain": view.service.domain, "verified": view.service.verified}),
        );
        self.inner
            .pairing_requests
            .lock()
            .unwrap()
            .insert(view.pairing_id.clone(), view.clone());
        self.emit(UiEvent::PairingRequested {
            pairing_id: view.pairing_id.clone(),
            service_name: view.service.display_name.clone(),
        });
        self.changed();
        Ok(view)
    }

    pub async fn accept_pairing(&self, pairing_id: &str, opts: AcceptOptions) -> BResult<GrantView> {
        let req = self
            .inner
            .pairing_requests
            .lock()
            .unwrap()
            .get(pairing_id)
            .cloned()
            .ok_or_else(|| BridgeError::User("This connection request is no longer pending".into()))?;
        let ws = Workspace::new(&opts.workspace).map_err(|e| BridgeError::User(e.to_string()))?;
        let provider = self
            .providers()
            .into_iter()
            .find(|p| p.id == opts.provider_id)
            .ok_or_else(|| BridgeError::User("Choose an AI provider".into()))?;
        match provider.policy.remote {
            RemotePolicy::Blocked => return user(provider.policy.note),
            RemotePolicy::AllowedWithNotice if !opts.acknowledge_terms => {
                return user("Please confirm the provider notice before connecting")
            }
            _ => {}
        }
        let duration = opts.duration_secs.clamp(300, 30 * 24 * 3600);
        let v = relay_client::post(
            self,
            &format!("/v1/pairings/{pairing_id}/accept"),
            json!({"grantExpiresInSeconds": duration, "providerLabel": provider.name}),
        )
        .await?;
        let connection_id = v["connectionId"].as_str().unwrap_or_default().to_string();
        if !connection_id.starts_with("conn_") {
            return Err(BridgeError::Internal("relay returned an invalid connection id".into()));
        }
        let expires_at = serde_json::from_value(v["expiresAt"].clone()).unwrap_or_else(|_| Utc::now() + ChronoDuration::seconds(duration));
        let grant = Grant {
            connection_id: connection_id.clone(),
            service_id: req.service.id.clone(),
            external_user_id: req.external_user_id.clone(),
            provider_id: provider.id.clone(),
            workspace_root: ws.root().to_path_buf(),
            scopes: req.scopes.clone(),
            require_task_approval: opts.require_task_approval,
            access: opts.access,
            expires_at,
            status: GrantStatus::Active,
        };
        {
            let store = self.inner.store.lock().unwrap();
            store.upsert_service(&TrustedService {
                id: req.service.id.clone(),
                display_name: req.service.display_name.clone(),
                origin: req.service.origin.clone(),
                domain: req.service.domain.clone(),
                verified: req.service.verified,
            })?;
            store.insert_grant(&grant)?;
            store.audit(
                Some(&connection_id),
                None,
                "connection_granted",
                json!({
                    "service": req.service.id, "domain": req.service.domain, "provider": provider.id,
                    "access": grant.access, "requireTaskApproval": grant.require_task_approval,
                    "expiresAt": grant.expires_at,
                }),
            );
        }
        self.inner.pairing_requests.lock().unwrap().remove(pairing_id);
        self.changed();
        Ok(self
            .snapshot()
            .grants
            .into_iter()
            .find(|g| g.connection_id == connection_id)
            .expect("grant just inserted"))
    }

    pub async fn reject_pairing(&self, pairing_id: &str) -> BResult<()> {
        let req = self.inner.pairing_requests.lock().unwrap().remove(pairing_id);
        if let Some(req) = req {
            let _ = relay_client::post(self, &format!("/v1/pairings/{pairing_id}/reject"), json!({})).await;
            self.inner
                .store
                .lock()
                .unwrap()
                .audit(None, None, "pairing_rejected", json!({"service": req.service.id}));
        }
        self.changed();
        Ok(())
    }

    // --------------------------------------------------------- connections

    pub async fn revoke_grant(&self, connection_id: &str) -> BResult<()> {
        let changed = self
            .inner
            .store
            .lock()
            .unwrap()
            .set_grant_status(connection_id, GrantStatus::Revoked)?;
        self.stop_connection(connection_id, "connection revoked").await;
        if changed {
            self.inner
                .store
                .lock()
                .unwrap()
                .audit(Some(connection_id), None, "connection_revoked", json!({"by": "desktop"}));
            if relay_client::post(self, &format!("/v1/connections/{connection_id}/revoke"), json!({}))
                .await
                .is_err()
            {
                // Relay unreachable: queue a revoke envelope for when it reconnects.
                let mut env = Envelope::new(Body::Revoke(bridge_protocol::Revoke { reason: "revoked".into() }));
                env.connection_id = Some(connection_id.into());
                let _ = self.inner.out_tx.try_send(env);
            }
        }
        self.changed();
        Ok(())
    }

    pub async fn revoke_all(&self) -> BResult<()> {
        let ids: Vec<String> = self
            .inner
            .store
            .lock()
            .unwrap()
            .grants()?
            .into_iter()
            .filter(|g| g.grant.status != GrantStatus::Revoked)
            .map(|g| g.grant.connection_id)
            .collect();
        for id in ids {
            self.revoke_grant(&id).await?;
        }
        Ok(())
    }

    pub fn forget_grant(&self, connection_id: &str) -> BResult<()> {
        let store = self.inner.store.lock().unwrap();
        match store.grant(connection_id) {
            Some(g) if g.grant.status == GrantStatus::Revoked || Utc::now() >= g.grant.expires_at => {
                store.delete_grant(connection_id)?;
            }
            Some(_) => return user("Disconnect the website before removing it"),
            None => {}
        }
        drop(store);
        self.changed();
        Ok(())
    }

    pub async fn set_grant_paused(&self, connection_id: &str, paused: bool) -> BResult<()> {
        let status = if paused { GrantStatus::Paused } else { GrantStatus::Active };
        if !self.inner.store.lock().unwrap().set_grant_status(connection_id, status)? {
            return user("This connection was revoked");
        }
        if paused {
            self.stop_connection(connection_id, "connection paused").await;
        }
        let mut env = Envelope::new(Body::ConnectionState(bridge_protocol::ConnectionStatePayload {
            state: if paused {
                bridge_protocol::ConnectionState::Paused
            } else {
                bridge_protocol::ConnectionState::Active
            },
        }));
        env.connection_id = Some(connection_id.into());
        let _ = self.inner.out_tx.try_send(env);
        self.inner.store.lock().unwrap().audit(
            Some(connection_id),
            None,
            if paused { "connection_paused" } else { "connection_resumed" },
            json!({}),
        );
        self.changed();
        Ok(())
    }

    pub async fn update_grant(&self, connection_id: &str, require_task_approval: bool, access: AccessLevel) -> BResult<()> {
        self.inner
            .store
            .lock()
            .unwrap()
            .update_grant_settings(connection_id, require_task_approval, access)?;
        // Access level is applied at session start; restart the session.
        self.close_session(connection_id).await;
        self.inner.store.lock().unwrap().audit(
            Some(connection_id),
            None,
            "connection_updated",
            json!({"access": access, "requireTaskApproval": require_task_approval}),
        );
        self.changed();
        Ok(())
    }

    /// Cancel tasks and kill the agent session for a connection.
    async fn stop_connection(&self, connection_id: &str, reason: &str) {
        let ids: Vec<String> = self
            .inner
            .tasks
            .lock()
            .unwrap()
            .values()
            .filter(|t| t.view.connection_id.as_deref() == Some(connection_id) && !t.view.state.is_terminal())
            .map(|t| t.view.id.clone())
            .collect();
        for id in ids {
            self.cancel_task(&id, reason).await;
        }
        self.close_session(connection_id).await;
    }

    /// Called when the relay tells us a connection is gone.
    pub(crate) async fn on_remote_revoke(&self, connection_id: &str, by: &str) {
        let changed = self
            .inner
            .store
            .lock()
            .unwrap()
            .set_grant_status(connection_id, GrantStatus::Revoked)
            .unwrap_or(false);
        if changed {
            self.inner
                .store
                .lock()
                .unwrap()
                .audit(Some(connection_id), None, "connection_revoked", json!({"by": by}));
        }
        self.stop_connection(connection_id, "connection revoked").await;
        self.changed();
    }

    pub(crate) async fn reconcile(&self, active: &[String]) {
        let grants = self.inner.store.lock().unwrap().grants().unwrap_or_default();
        for g in grants {
            if g.grant.status == GrantStatus::Revoked {
                continue;
            }
            if !active.contains(&g.grant.connection_id) {
                self.on_remote_revoke(&g.grant.connection_id, "relay").await;
            } else if g.grant.status == GrantStatus::Paused {
                let mut env = Envelope::new(Body::ConnectionState(bridge_protocol::ConnectionStatePayload {
                    state: bridge_protocol::ConnectionState::Paused,
                }));
                env.connection_id = Some(g.grant.connection_id.clone());
                let _ = self.inner.out_tx.try_send(env);
            }
        }
    }

    // ---------------------------------------------------------------- tasks

    fn insert_task(&self, view: TaskView, approval_tx: Option<oneshot::Sender<bool>>) -> watch::Receiver<bool> {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let id = view.id.clone();
        self.inner.store.lock().unwrap().insert_task(&TaskRow {
            id: id.clone(),
            connection_id: view.connection_id.clone(),
            source: view.source.clone(),
            provider_id: view.provider_id.clone(),
            state: view.state.as_str().into(),
            created_at: view.created_at,
            finished_at: None,
            failure_code: None,
            stop_reason: None,
        }).ok();
        self.inner.tasks.lock().unwrap().insert(
            id.clone(),
            LiveTask {
                view,
                approval_tx,
                cancel_tx,
                seq: 0,
                allowed_kinds: HashSet::new(),
                blocked: None,
                scan_tail: String::new(),
            },
        );
        let mut order = self.inner.task_order.lock().unwrap();
        order.push_back(id);
        // Keep the in-memory activity list bounded (finished tasks only).
        while order.len() > MAX_LIVE_TASKS {
            let oldest = order.front().cloned().unwrap();
            let mut tasks = self.inner.tasks.lock().unwrap();
            if tasks.get(&oldest).map(|t| t.view.state.is_terminal()).unwrap_or(true) {
                tasks.remove(&oldest);
                order.pop_front();
            } else {
                break;
            }
        }
        cancel_rx
    }

    fn with_task<R>(&self, id: &str, f: impl FnOnce(&mut LiveTask) -> R) -> Option<R> {
        self.inner.tasks.lock().unwrap().get_mut(id).map(f)
    }

    fn push_item(&self, id: &str, item: TranscriptItem) {
        self.with_task(id, |t| {
            if t.view.transcript.len() < MAX_TRANSCRIPT_ITEMS {
                t.view.transcript.push(item);
            }
        });
    }

    fn set_state(&self, id: &str, state: TaskState) -> bool {
        let ok = self
            .with_task(id, |t| {
                if t.view.state == state {
                    return false;
                }
                if !t.view.state.can_transition_to(state) {
                    return false;
                }
                t.view.state = state;
                if state.is_terminal() {
                    t.view.finished_at = Some(Utc::now());
                }
                true
            })
            .unwrap_or(false);
        if ok {
            let (stop, err) = self
                .with_task(id, |t| (t.view.stop_reason.clone(), t.view.error.clone()))
                .unwrap_or((None, None));
            let _ = self.inner.store.lock().unwrap().update_task(
                id,
                state.as_str(),
                state.is_terminal(),
                err.as_deref(),
                stop.as_deref(),
            );
            self.changed();
        }
        ok
    }

    /// Send a task-scoped envelope to the relay with the next sequence number.
    async fn send_remote(&self, task_id: &str, body: Body) -> bool {
        let Some((conn, seq)) = self.with_task(task_id, |t| {
            t.seq += 1;
            (t.view.connection_id.clone(), t.seq)
        }) else {
            return false;
        };
        let Some(conn) = conn else { return true };
        let env = Envelope::for_task(body, &conn, task_id, seq);
        match tokio::time::timeout(Duration::from_secs(60), self.inner.out_tx.send(env)).await {
            Ok(Ok(())) => true,
            _ => false,
        }
    }

    async fn reject_remote(&self, connection_id: &str, task_id: &str, code: &str, message: &str) {
        let env = Envelope::for_task(
            Body::TaskRejected(ErrorPayload::new(code, message)),
            connection_id,
            task_id,
            1,
        );
        let _ = self.inner.out_tx.send(env).await;
        self.inner.store.lock().unwrap().audit(
            Some(connection_id),
            Some(task_id),
            "task_rejected",
            json!({"code": code}),
        );
    }

    /// Entry point for `task.start` from the relay.
    pub(crate) async fn on_task_start(&self, env: Envelope, start: TaskStart) {
        let task_id = env.task_id.clone().unwrap_or_default();
        let connection_id = env.connection_id.clone().unwrap_or_default();
        // At-most-once: never run the same task id twice.
        if self.inner.tasks.lock().unwrap().contains_key(&task_id) || self.inner.store.lock().unwrap().task_exists(&task_id) {
            return;
        }
        let grant = self.inner.store.lock().unwrap().grant(&connection_id);
        let Some(grant) = grant else {
            self.reject_remote(&connection_id, &task_id, "unknown_connection", "This connection is not known on the desktop").await;
            return;
        };
        if let Err(denied) = grant.grant.authorize_task(&start, Utc::now(), self.is_paused()) {
            self.reject_remote(&connection_id, &task_id, denied.code(), &denied.to_string()).await;
            return;
        }
        let provider = self.providers().into_iter().find(|p| p.id == grant.grant.provider_id);
        match &provider {
            Some(p) if p.state == ProviderState::Ready && p.policy.remote != RemotePolicy::Blocked => {}
            Some(p) if p.policy.remote == RemotePolicy::Blocked => {
                self.reject_remote(&connection_id, &task_id, "provider_policy", &p.policy.note).await;
                return;
            }
            Some(p) => {
                self.reject_remote(
                    &connection_id,
                    &task_id,
                    "provider_unavailable",
                    &format!("{} is not ready on this computer: {}", p.name, p.status_message),
                )
                .await;
                return;
            }
            None => {
                self.reject_remote(&connection_id, &task_id, "provider_unavailable", "The selected AI provider is not available").await;
                return;
            }
        }
        let busy = self
            .inner
            .tasks
            .lock()
            .unwrap()
            .values()
            .any(|t| t.view.connection_id.as_deref() == Some(&connection_id) && !t.view.state.is_terminal());
        if busy {
            self.reject_remote(&connection_id, &task_id, "task_in_progress", "Another task is still running for this website").await;
            return;
        }
        let service = self
            .inner
            .store
            .lock()
            .unwrap()
            .services()
            .unwrap_or_default()
            .into_iter()
            .find(|s| s.id == grant.grant.service_id);
        let prompt = start.prompt_text();
        let (approval_tx, approval_rx) = if grant.grant.require_task_approval {
            let (tx, rx) = oneshot::channel();
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let view = TaskView {
            id: task_id.clone(),
            source: "remote".into(),
            connection_id: Some(connection_id.clone()),
            service_name: service.as_ref().map(|s| s.display_name.clone()),
            service_domain: service.as_ref().map(|s| s.domain.clone()),
            provider_id: grant.grant.provider_id.clone(),
            workspace: grant.grant.workspace_root.to_string_lossy().to_string(),
            state: TaskState::Created,
            prompt: prompt.clone(),
            transcript: vec![TranscriptItem::User { text: prompt.clone() }],
            created_at: Utc::now(),
            finished_at: None,
            stop_reason: None,
            error: None,
        };
        let cancel_rx = self.insert_task(view, approval_tx);
        self.inner.store.lock().unwrap().touch_grant(&connection_id);
        self.inner.store.lock().unwrap().audit(
            Some(&connection_id),
            Some(&task_id),
            "task_received",
            json!({"service": grant.grant.service_id}),
        );
        let b = self.clone();
        let g = grant.grant.clone();
        tokio::spawn(async move {
            b.run_task(task_id, Some(g.clone()), g.provider_id.clone(), g.workspace_root.clone(), g.access, prompt, approval_rx, cancel_rx)
                .await;
        });
    }

    /// Start a task from the desktop UI itself (no website involved).
    pub async fn start_local_task(&self, provider_id: &str, workspace: &str, prompt: &str) -> BResult<String> {
        if self.is_paused() {
            return user("The bridge is paused");
        }
        if prompt.trim().is_empty() {
            return user("Type a message first");
        }
        let ws = Workspace::new(workspace).map_err(|e| BridgeError::User(e.to_string()))?;
        let provider = self
            .providers()
            .into_iter()
            .find(|p| p.id == provider_id)
            .ok_or_else(|| BridgeError::User("Unknown provider".into()))?;
        if provider.state != ProviderState::Ready {
            return user(format!("{} is not ready: {}", provider.name, provider.status_message));
        }
        let id = bridge_protocol::ids::new_id("local");
        let view = TaskView {
            id: id.clone(),
            source: "local".into(),
            connection_id: None,
            service_name: None,
            service_domain: None,
            provider_id: provider_id.into(),
            workspace: ws.root().to_string_lossy().to_string(),
            state: TaskState::Created,
            prompt: prompt.into(),
            transcript: vec![TranscriptItem::User { text: prompt.into() }],
            created_at: Utc::now(),
            finished_at: None,
            stop_reason: None,
            error: None,
        };
        let cancel_rx = self.insert_task(view, None);
        let b = self.clone();
        let (tid, pid, root, text) = (id.clone(), provider_id.to_string(), ws.root().to_path_buf(), prompt.to_string());
        tokio::spawn(async move {
            b.run_task(tid, None, pid, root, AccessLevel::WorkspaceWrite, text, None, cancel_rx).await;
        });
        Ok(id)
    }

    pub async fn approve_task(&self, task_id: &str, approve: bool) -> BResult<()> {
        let tx = self.with_task(task_id, |t| t.approval_tx.take()).flatten();
        match tx {
            Some(tx) => {
                let _ = tx.send(approve);
                Ok(())
            }
            None => user("This task is no longer waiting for approval"),
        }
    }

    pub async fn cancel_task(&self, task_id: &str, reason: &str) {
        let found = self.with_task(task_id, |t| {
            if t.view.state.is_terminal() {
                return false;
            }
            let _ = t.cancel_tx.send(true);
            if let Some(tx) = t.approval_tx.take() {
                let _ = tx.send(false);
            }
            true
        });
        if found == Some(true) {
            // Resolve any pending permission prompts of this task as cancelled.
            let ids: Vec<String> = self
                .inner
                .permissions
                .lock()
                .unwrap()
                .values()
                .filter(|p| p.view.task_id == task_id)
                .map(|p| p.view.request_id.clone())
                .collect();
            for id in ids {
                self.resolve_permission_inner(&id, None);
            }
            self.push_item(task_id, TranscriptItem::Notice { text: format!("Stopping: {reason}") });
            self.changed();
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_task(
        &self,
        task_id: String,
        grant: Option<Grant>,
        provider_id: String,
        workspace: PathBuf,
        access: AccessLevel,
        prompt: String,
        approval_rx: Option<oneshot::Receiver<bool>>,
        mut cancel_rx: watch::Receiver<bool>,
    ) {
        let remote = grant.is_some();
        let conn_id = grant.as_ref().map(|g| g.connection_id.clone());

        // 1. Local approval.
        if let Some(rx) = approval_rx {
            self.set_state(&task_id, TaskState::AwaitingApproval);
            let service_name = self.with_task(&task_id, |t| t.view.service_name.clone()).flatten();
            self.emit(UiEvent::TaskApprovalRequested {
                task_id: task_id.clone(),
                service_name,
                prompt: truncate(&prompt, 300),
            });
            let _ = self.send_remote(&task_id, Body::TaskEvent(TaskEvent::Status { state: TaskState::AwaitingApproval })).await;
            let decision = tokio::time::timeout(APPROVAL_TIMEOUT, rx).await;
            match decision {
                Ok(Ok(true)) if !*cancel_rx.borrow() => {}
                Ok(_) => {
                    self.finish_rejected(&task_id, "declined", "The desktop user declined this task", TaskState::Rejected).await;
                    return;
                }
                Err(_) => {
                    self.with_task(&task_id, |t| t.approval_tx = None);
                    self.finish_rejected(&task_id, "approval_timeout", "No one approved the task on the desktop in time", TaskState::Expired).await;
                    return;
                }
            }
        }
        self.set_state(&task_id, TaskState::Queued);
        if remote {
            self.send_remote(&task_id, Body::TaskAccepted(Default::default())).await;
        }
        if *cancel_rx.borrow() {
            self.finish(&task_id, Ok("cancelled".into())).await;
            return;
        }

        // 2. Agent session.
        let key = conn_id.clone().unwrap_or_else(|| format!("local:{task_id}"));
        let session = match self.get_or_create_session(&key, &provider_id, &workspace, access).await {
            Ok(s) => s,
            Err((code, msg)) => {
                self.finish_failed(&task_id, &code, &msg).await;
                if !remote {
                    self.close_session(&key).await;
                }
                return;
            }
        };
        let (host, session_id, events, handler) = session;
        *handler.current_task.lock().unwrap() = Some(task_id.clone());
        self.set_state(&task_id, TaskState::Running);
        let _ = self.send_remote(&task_id, Body::TaskEvent(TaskEvent::Status { state: TaskState::Running })).await;
        self.inner.store.lock().unwrap().audit(conn_id.as_deref(), Some(&task_id), "task_started", json!({"provider": provider_id}));

        // 3. Prompt turn with streaming and cancellation.
        let mut events = events.lock().await;
        while events.try_recv().is_ok() {} // drop stale updates from earlier turns
        let h2 = host.clone();
        let sid2 = session_id.clone();
        let text = prompt.clone();
        let mut prompt_fut = tokio::spawn(async move { h2.prompt(&sid2, &text).await });
        let mut cancel_deadline: Option<tokio::time::Instant> = None;
        let mut relay_ok = true;
        let result: Result<String, HostError> = loop {
            let deadline = cancel_deadline;
            tokio::select! {
                res = &mut prompt_fut => {
                    break res.unwrap_or(Err(HostError::AgentExited));
                }
                ev = events.recv() => {
                    match ev {
                        Some(HostEvent::Session(n)) if n.session_id == session_id => {
                            if !self.forward_update(&task_id, n.update, &workspace).await {
                                relay_ok = false;
                            }
                        }
                        Some(HostEvent::Session(_)) => {}
                        Some(HostEvent::ProtocolNoise(s)) => self.record_error(format!("agent protocol: {s}")),
                        Some(HostEvent::Exited { code }) => {
                            self.record_error(format!("agent exited with {code:?}"));
                        }
                        None => {}
                    }
                    if !relay_ok && cancel_deadline.is_none() {
                        self.push_item(&task_id, TranscriptItem::Notice { text: "Lost connection to the relay; stopping the task".into() });
                        let _ = host.cancel(&session_id).await;
                        self.set_state(&task_id, TaskState::Cancelling);
                        cancel_deadline = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                    }
                }
                _ = cancel_rx.changed(), if cancel_deadline.is_none() => {
                    if *cancel_rx.borrow() {
                        let _ = host.cancel(&session_id).await;
                        self.set_state(&task_id, TaskState::Cancelling);
                        let _ = self.send_remote(&task_id, Body::TaskEvent(TaskEvent::Status { state: TaskState::Cancelling })).await;
                        cancel_deadline = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                    }
                }
                _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => {
                    // Agent ignored cancellation: terminate the process tree.
                    host.shutdown().await;
                    prompt_fut.abort();
                    break Ok("cancelled".into());
                }
            }
        };
        // Forward trailing updates that arrived before the response.
        while let Ok(ev) = events.try_recv() {
            if let HostEvent::Session(n) = ev {
                if n.session_id == session_id {
                    self.forward_update(&task_id, n.update, &workspace).await;
                }
            }
        }
        drop(events);
        *handler.current_task.lock().unwrap() = None;
        let crashed = matches!(result, Err(HostError::AgentExited)) || !host.is_alive();
        let cancelled = *cancel_rx.borrow();
        let result = match result {
            Ok(r) if cancelled => Ok(if r == "end_turn" { r } else { "cancelled".into() }),
            Err(_) if cancelled => Ok("cancelled".into()),
            other => other,
        };
        if crashed || !remote || cancelled {
            self.close_session(&key).await;
        } else if let Some(s) = self.inner.sessions.lock().await.get_mut(&key) {
            s.last_used = Instant::now();
        }
        if let Some(reason) = self.with_task(&task_id, |t| t.blocked.clone()).flatten() {
            self.close_session(&key).await;
            // The detailed reason (with local paths) stays on the desktop.
            let public = if reason.contains("credential") {
                "Stopped by the desktop's safety checks: the reply contained what looks like a credential"
            } else {
                "Stopped by the desktop's safety checks: the agent tried to access a file outside the project folder"
            };
            self.finish_failed(&task_id, "policy_blocked", public).await;
            return;
        }
        self.finish(&task_id, result).await;
    }

    /// Stop a website task because the output firewall triggered.
    fn block_task(&self, task_id: &str, reason: String) {
        let first = self
            .with_task(task_id, |t| {
                let first = t.blocked.is_none();
                if first {
                    t.blocked = Some(reason.clone());
                }
                first
            })
            .unwrap_or(false);
        if !first {
            return;
        }
        self.push_item(task_id, TranscriptItem::Error { text: format!("Blocked: {reason}. The task was stopped and nothing more was sent to the website.") });
        let conn = self.with_task(task_id, |t| t.view.connection_id.clone()).flatten();
        self.inner.store.lock().unwrap().audit(conn.as_deref(), Some(task_id), "output_blocked", json!({"reason": redact(&reason, None)}));
        self.record_error(format!("output firewall: {reason}"));
        let b = self.clone();
        let id = task_id.to_string();
        tokio::spawn(async move { b.cancel_task(&id, "blocked by the bridge's safety checks").await });
        self.changed();
    }

    async fn forward_update(&self, task_id: &str, update: SessionUpdate, workspace: &std::path::Path) -> bool {
        let (remote, blocked) = self
            .with_task(task_id, |t| (t.view.connection_id.is_some(), t.blocked.is_some()))
            .unwrap_or((false, false));
        if blocked {
            return true;
        }
        if remote {
            match &update {
                SessionUpdate::ToolCall(f) | SessionUpdate::ToolCallUpdate(f) => {
                    let mut texts: Vec<String> = f.title.iter().cloned().collect();
                    if let Some(v) = &f.raw_input {
                        crate::guard::json_strings(v, &mut texts);
                    }
                    texts.extend(f.locations.iter().map(|l| l.path.clone()));
                    let hits = crate::guard::paths_outside(&texts, workspace);
                    if let Some(p) = hits.first() {
                        self.block_task(task_id, format!("the agent tried to access {} outside the project folder", redact(p, None)));
                        return true;
                    }
                }
                SessionUpdate::AgentMessageChunk { content } | SessionUpdate::AgentThoughtChunk { content } => {
                    if let Some(text) = content.text() {
                        let window = self
                            .with_task(task_id, |t| {
                                let w = format!("{}{}", t.scan_tail, text);
                                let keep = w.char_indices().rev().nth(200).map(|(i, _)| i).unwrap_or(0);
                                t.scan_tail = w[keep..].to_string();
                                w
                            })
                            .unwrap_or_default();
                        if crate::guard::looks_like_secret(&window) {
                            self.block_task(task_id, "the agent's reply contained what looks like a credential".into());
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
        let ev = match update {
            SessionUpdate::AgentMessageChunk { content } => {
                let Some(text) = content.text() else { return true };
                let text = truncate(text, MAX_TEXT_DELTA_BYTES - 8);
                self.with_task(task_id, |t| {
                    match t.view.transcript.last_mut() {
                        Some(TranscriptItem::Agent { text: existing }) if existing.len() < 1_000_000 => existing.push_str(&text),
                        _ => {
                            if t.view.transcript.len() < MAX_TRANSCRIPT_ITEMS {
                                t.view.transcript.push(TranscriptItem::Agent { text: text.clone() })
                            }
                        }
                    }
                });
                self.emit(UiEvent::TaskDelta { task_id: task_id.into(), text: text.clone() });
                TaskEvent::TextDelta { text }
            }
            SessionUpdate::AgentThoughtChunk { content } => {
                let Some(text) = content.text() else { return true };
                let text = truncate(text, MAX_TEXT_DELTA_BYTES - 8);
                self.with_task(task_id, |t| match t.view.transcript.last_mut() {
                    Some(TranscriptItem::Thought { text: existing }) if existing.len() < 200_000 => existing.push_str(&text),
                    _ => {
                        if t.view.transcript.len() < MAX_TRANSCRIPT_ITEMS {
                            t.view.transcript.push(TranscriptItem::Thought { text: text.clone() })
                        }
                    }
                });
                self.changed();
                TaskEvent::ThoughtDelta { text }
            }
            SessionUpdate::ToolCall(f) => {
                let title = truncate(&redact(f.title.as_deref().unwrap_or("Tool call"), Some(workspace)), 200);
                let kind = f.kind.clone().unwrap_or_else(|| "other".into());
                let status = f.status.clone().unwrap_or_else(|| "pending".into());
                self.push_item(task_id, TranscriptItem::Tool {
                    tool_call_id: f.tool_call_id.clone(),
                    title: title.clone(),
                    kind: kind.clone(),
                    status: status.clone(),
                });
                self.changed();
                TaskEvent::ToolCall { tool_call_id: truncate(&f.tool_call_id, 120), title, kind, status }
            }
            SessionUpdate::ToolCallUpdate(f) => {
                let title = f.title.as_deref().map(|t| truncate(&redact(t, Some(workspace)), 200));
                self.with_task(task_id, |t| {
                    for item in t.view.transcript.iter_mut().rev() {
                        if let TranscriptItem::Tool { tool_call_id, title: tt, status, .. } = item {
                            if *tool_call_id == f.tool_call_id {
                                if let Some(s) = &f.status {
                                    *status = s.clone();
                                }
                                if let Some(nt) = &title {
                                    *tt = nt.clone();
                                }
                                break;
                            }
                        }
                    }
                });
                self.changed();
                TaskEvent::ToolCallUpdate { tool_call_id: truncate(&f.tool_call_id, 120), title, status: f.status }
            }
            SessionUpdate::Plan { entries } => {
                let entries: Vec<bridge_protocol::PlanEntry> = entries
                    .into_iter()
                    .take(50)
                    .map(|e| bridge_protocol::PlanEntry {
                        content: truncate(&redact(&e.content, Some(workspace)), 500),
                        status: e.status.unwrap_or_else(|| "pending".into()),
                        priority: e.priority,
                    })
                    .collect();
                self.with_task(task_id, |t| {
                    if let Some(pos) = t.view.transcript.iter().rposition(|i| matches!(i, TranscriptItem::Plan { .. })) {
                        t.view.transcript[pos] = TranscriptItem::Plan { entries: entries.clone() };
                    } else if t.view.transcript.len() < MAX_TRANSCRIPT_ITEMS {
                        t.view.transcript.push(TranscriptItem::Plan { entries: entries.clone() });
                    }
                });
                self.changed();
                TaskEvent::Plan { entries }
            }
            SessionUpdate::CurrentModeUpdate { current_mode_id } => {
                let remote = self.with_task(task_id, |t| t.view.connection_id.is_some()).unwrap_or(false);
                if remote && AccessLevel::is_forbidden_mode(&current_mode_id) {
                    self.push_item(task_id, TranscriptItem::Error {
                        text: format!("The agent switched to an unrestricted mode ({current_mode_id}); the task was stopped"),
                    });
                    self.record_error(format!("agent switched to forbidden mode {current_mode_id}"));
                    let b = self.clone();
                    let id = task_id.to_string();
                    tokio::spawn(async move { b.cancel_task(&id, "agent left the restricted mode").await });
                }
                return true;
            }
            _ => return true,
        };
        self.send_remote(task_id, Body::TaskEvent(ev)).await
    }

    async fn finish(&self, task_id: &str, result: Result<String, HostError>) {
        match result {
            Ok(stop) => {
                self.with_task(task_id, |t| t.view.stop_reason = Some(stop.clone()));
                let state = if stop == "cancelled" { TaskState::Cancelled } else { TaskState::Completed };
                if state == TaskState::Cancelled {
                    self.set_state(task_id, TaskState::Cancelled);
                } else {
                    self.set_state(task_id, TaskState::Completed);
                }
                self.send_remote(task_id, Body::TaskCompleted(TaskCompleted { stop_reason: stop.clone() })).await;
                let conn = self.with_task(task_id, |t| t.view.connection_id.clone()).flatten();
                self.inner.store.lock().unwrap().audit(conn.as_deref(), Some(task_id), "task_finished", json!({"stopReason": stop}));
            }
            Err(e) => {
                let (code, msg) = map_host_error(&e);
                self.finish_failed(task_id, &code, &msg).await;
            }
        }
    }

    async fn finish_failed(&self, task_id: &str, code: &str, msg: &str) {
        self.with_task(task_id, |t| t.view.error = Some(msg.to_string()));
        self.push_item(task_id, TranscriptItem::Error { text: msg.to_string() });
        self.set_state(task_id, TaskState::Failed);
        self.send_remote(task_id, Body::TaskFailed(ErrorPayload::new(code, msg))).await;
        let conn = self.with_task(task_id, |t| t.view.connection_id.clone()).flatten();
        self.record_error(format!("task failed: {code}"));
        self.inner.store.lock().unwrap().audit(conn.as_deref(), Some(task_id), "task_failed", json!({"code": code}));
    }

    async fn finish_rejected(&self, task_id: &str, code: &str, msg: &str, state: TaskState) {
        self.with_task(task_id, |t| t.view.error = Some(msg.to_string()));
        self.push_item(task_id, TranscriptItem::Notice { text: msg.to_string() });
        self.set_state(task_id, state);
        self.send_remote(task_id, Body::TaskRejected(ErrorPayload::new(code, msg))).await;
        let conn = self.with_task(task_id, |t| t.view.connection_id.clone()).flatten();
        self.inner.store.lock().unwrap().audit(conn.as_deref(), Some(task_id), "task_rejected", json!({"code": code}));
    }

    // ------------------------------------------------------------- sessions

    #[allow(clippy::type_complexity)]
    async fn get_or_create_session(
        &self,
        key: &str,
        provider_id: &str,
        workspace: &std::path::Path,
        access: AccessLevel,
    ) -> Result<(AgentHost, String, Arc<tokio::sync::Mutex<mpsc::Receiver<HostEvent>>>, Arc<SessionHandler>), (String, String)> {
        let mut sessions = self.inner.sessions.lock().await;
        if let Some(s) = sessions.get(key) {
            if s.host.is_alive() && s.provider_id == provider_id {
                return Ok((s.host.clone(), s.session_id.clone(), s.events.clone(), s.handler.clone()));
            }
            let old = sessions.remove(key).unwrap();
            old.host.shutdown().await;
        }
        let ws = Workspace::new(workspace).map_err(|e| ("workspace_unavailable".to_string(), e.to_string()))?;
        let cmd = providers::launch_command(&self.provider_env(), provider_id, ws.root())
            .await
            .map_err(|e| ("provider_unavailable".to_string(), e))?;
        let handler = Arc::new(SessionHandler {
            bridge: Arc::downgrade(&self.inner),
            workspace: ws.clone(),
            current_task: Mutex::new(None),
        });
        let (host, rx) = AgentHost::spawn(cmd, handler.clone(), Limits::default())
            .await
            .map_err(|e| ("provider_unavailable".to_string(), format!("Could not start the AI agent: {e}")))?;
        let init = match host.initialize().await {
            Ok(i) => i,
            Err(e) => {
                let tail = host.stderr_tail().join("\n");
                host.shutdown().await;
                self.record_error(format!("initialize failed: {e}; {}", truncate(&tail, 500)));
                return Err(map_host_error(&e));
            }
        };
        let new = match host.new_session(ws.root()).await {
            Ok(s) => s,
            Err(e) => {
                host.shutdown().await;
                return Err(map_host_error(&e));
            }
        };
        let modes: Vec<String> = new
            .modes
            .as_ref()
            .map(|m| m.available_modes.iter().map(|x| x.id.clone()).collect())
            .unwrap_or_default();
        let mut current_mode = new.modes.as_ref().map(|m| m.current_mode_id.clone());
        let mut sandbox_enforced = false;
        if let Some(target) = access
            .mode_candidates()
            .iter()
            .find(|c| modes.iter().any(|m| m == *c) && !AccessLevel::is_forbidden_mode(c))
        {
            if current_mode.as_deref() == Some(*target) {
                sandbox_enforced = true;
            } else if host.set_mode(&new.session_id, target).await.is_ok() {
                current_mode = Some(target.to_string());
                sandbox_enforced = true;
            }
        }
        if !sandbox_enforced && !modes.is_empty() {
            // Never run a remote session in an unknown/permissive mode.
            if !key.starts_with("local:") {
                host.shutdown().await;
                return Err((
                    "sandbox_unavailable".into(),
                    "The agent could not be switched to a restricted mode, so the task was stopped".into(),
                ));
            }
        }
        let events = Arc::new(tokio::sync::Mutex::new(rx));
        sessions.insert(
            key.to_string(),
            LiveSession {
                host: host.clone(),
                session_id: new.session_id.clone(),
                events: events.clone(),
                handler: handler.clone(),
                last_used: Instant::now(),
                provider_id: provider_id.into(),
                init,
                modes,
                current_mode,
                sandbox_enforced,
            },
        );
        Ok((host, new.session_id, events, handler))
    }

    async fn close_session(&self, key: &str) {
        let s = self.inner.sessions.lock().await.remove(key);
        if let Some(s) = s {
            s.host.shutdown().await;
        }
    }

    async fn close_sessions_for_provider(&self, provider: &str) {
        let keys: Vec<String> = self
            .inner
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(_, s)| s.provider_id == provider)
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys {
            self.close_session(&k).await;
        }
    }

    async fn sweep_idle_sessions(&self) {
        let idle = Duration::from_secs(self.settings().session_idle_minutes as u64 * 60);
        let busy: HashSet<String> = self
            .inner
            .tasks
            .lock()
            .unwrap()
            .values()
            .filter(|t| !t.view.state.is_terminal())
            .filter_map(|t| t.view.connection_id.clone())
            .collect();
        let keys: Vec<String> = self
            .inner
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(k, s)| !busy.contains(*k) && (s.last_used.elapsed() > idle || !s.host.is_alive()))
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys {
            self.close_session(&k).await;
        }
        // Drop expired pairing requests from the consent queue.
        let now = Utc::now();
        self.inner.pairing_requests.lock().unwrap().retain(|_, p| p.expires_at > now);
    }

    /// Shut down every agent process (app quit).
    pub async fn shutdown(&self) {
        let ids: Vec<String> = self.inner.tasks.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.cancel_task(&id, "app is quitting").await;
        }
        let keys: Vec<String> = self.inner.sessions.lock().await.keys().cloned().collect();
        for k in keys {
            self.close_session(&k).await;
        }
    }

    // ---------------------------------------------------------- permissions

    async fn request_permission(&self, task_id: Option<String>, req: RequestPermissionRequest, workspace: &std::path::Path) -> PermissionDecision {
        let Some(task_id) = task_id else { return PermissionDecision::Cancelled };
        if self.is_paused() {
            return PermissionDecision::Cancelled;
        }
        let kind = req.tool_call.kind.clone().unwrap_or_else(|| "other".into());
        let state = self.with_task(&task_id, |t| (t.view.state, t.allowed_kinds.contains(&kind), t.view.service_name.clone()));
        let Some((state, auto_allow, service_name)) = state else { return PermissionDecision::Cancelled };
        if state.is_terminal() || state == TaskState::Cancelling {
            return PermissionDecision::Cancelled;
        }
        if auto_allow {
            if let Some(o) = req.options.iter().find(|o| o.kind == "allow_once") {
                return PermissionDecision::Selected(o.option_id.clone());
            }
        }
        let remote = self.with_task(&task_id, |t| t.view.connection_id.is_some()).unwrap_or(false);
        if remote {
            let mut texts: Vec<String> = req.tool_call.title.iter().cloned().collect();
            crate::guard::json_strings(&req.raw_tool_call, &mut texts);
            if let Some(p) = crate::guard::paths_outside(&texts, workspace).first() {
                let reason = format!("Denied automatically: access to {} outside the project folder", redact(p, None));
                self.push_item(&task_id, TranscriptItem::Notice { text: reason.clone() });
                let conn = self.with_task(&task_id, |t| t.view.connection_id.clone()).flatten();
                self.inner.store.lock().unwrap().audit(conn.as_deref(), Some(&task_id), "permission_auto_denied", json!({"kind": kind}));
                self.send_remote(&task_id, Body::TaskEvent(TaskEvent::PermissionResolved {
                    request_id: bridge_protocol::ids::new_id("perm"),
                    outcome: PermissionOutcome::Denied,
                }))
                .await;
                self.changed();
                return req
                    .options
                    .iter()
                    .find(|o| o.kind == "reject_once" || o.kind == "reject_always")
                    .map(|o| PermissionDecision::Selected(o.option_id.clone()))
                    .unwrap_or(PermissionDecision::Cancelled);
            }
        }
        let request_id = bridge_protocol::ids::new_id("perm");
        let title = truncate(&redact(req.tool_call.title.as_deref().unwrap_or("The agent wants to use a tool"), Some(workspace)), 200);
        let details = if req.raw_tool_call.is_null() {
            None
        } else {
            let raw = req.raw_tool_call.get("rawInput").cloned().unwrap_or(Value::Null);
            (!raw.is_null()).then(|| truncate(&redact(&serde_json::to_string_pretty(&raw).unwrap_or_default(), Some(workspace)), 2000))
        };
        let (tx, rx) = oneshot::channel();
        let view = PermissionView {
            request_id: request_id.clone(),
            task_id: task_id.clone(),
            title: title.clone(),
            kind: kind.clone(),
            details,
            can_allow_for_task: TASK_SCOPED_SAFE_KINDS.contains(&kind.as_str()),
            service_name: service_name.clone(),
            created_at: Utc::now(),
        };
        self.inner.permissions.lock().unwrap().insert(
            request_id.clone(),
            PendingPermission { view, options: req.options.clone(), tx: Some(tx) },
        );
        self.push_item(&task_id, TranscriptItem::Permission { request_id: request_id.clone(), title: title.clone(), outcome: None });
        self.emit(UiEvent::PermissionRequested { request_id: request_id.clone(), task_id: task_id.clone(), title: title.clone(), service_name });
        self.changed();
        self.send_remote(&task_id, Body::TaskEvent(TaskEvent::PermissionPending { request_id: request_id.clone(), title })).await;

        let decision = match tokio::time::timeout(PERMISSION_TIMEOUT, rx).await {
            Ok(Ok(d)) => d,
            _ => {
                self.inner.permissions.lock().unwrap().remove(&request_id);
                PermissionDecision::Cancelled
            }
        };
        let outcome = match &decision {
            PermissionDecision::Selected(id) => {
                let allowed = req.options.iter().any(|o| &o.option_id == id && o.kind.starts_with("allow"));
                if allowed { PermissionOutcome::Allowed } else { PermissionOutcome::Denied }
            }
            PermissionDecision::Cancelled => PermissionOutcome::Cancelled,
        };
        let label = match outcome {
            PermissionOutcome::Allowed => "allowed",
            PermissionOutcome::Denied => "denied",
            PermissionOutcome::Cancelled => "cancelled",
        };
        self.with_task(&task_id, |t| {
            for item in t.view.transcript.iter_mut().rev() {
                if let TranscriptItem::Permission { request_id: r, outcome: o, .. } = item {
                    if *r == request_id {
                        *o = Some(label.into());
                        break;
                    }
                }
            }
        });
        let conn = self.with_task(&task_id, |t| t.view.connection_id.clone()).flatten();
        self.inner.store.lock().unwrap().audit(conn.as_deref(), Some(&task_id), "permission_resolved", json!({"kind": kind, "outcome": label}));
        self.send_remote(&task_id, Body::TaskEvent(TaskEvent::PermissionResolved { request_id, outcome })).await;
        self.changed();
        decision
    }

    /// Answer a permission prompt locally: `allow_once`, `allow_task` or `deny`.
    pub fn respond_permission(&self, request_id: &str, choice: &str) -> BResult<()> {
        let (kind, options, task_id, can_task) = {
            let perms = self.inner.permissions.lock().unwrap();
            let p = perms.get(request_id).ok_or_else(|| BridgeError::User("This request is no longer pending".into()))?;
            (p.view.kind.clone(), p.options.clone(), p.view.task_id.clone(), p.view.can_allow_for_task)
        };
        let pick = |kinds: &[&str]| -> Option<String> {
            kinds.iter().find_map(|k| options.iter().find(|o| o.kind == *k).map(|o| o.option_id.clone()))
        };
        let option = match choice {
            "allow_once" => pick(&["allow_once", "allow_always"]),
            "allow_task" => {
                if !can_task {
                    return user("This kind of action must be approved each time");
                }
                self.with_task(&task_id, |t| t.allowed_kinds.insert(kind.clone()));
                pick(&["allow_once", "allow_always"])
            }
            "deny" => pick(&["reject_once", "reject_always"]),
            _ => return user("Unknown choice"),
        };
        self.resolve_permission_inner(request_id, option);
        Ok(())
    }

    fn resolve_permission_inner(&self, request_id: &str, option: Option<String>) {
        let p = self.inner.permissions.lock().unwrap().remove(request_id);
        if let Some(mut p) = p {
            if let Some(tx) = p.tx.take() {
                let _ = tx.send(match option {
                    Some(id) => PermissionDecision::Selected(id),
                    None => PermissionDecision::Cancelled,
                });
            }
        }
        self.changed();
    }
}

fn map_host_error(e: &HostError) -> (String, String) {
    match e {
        HostError::Rpc { code, message, .. } if *code == agent_host::acp::error_codes::AUTH_REQUIRED => (
            "provider_signed_out".into(),
            "The AI provider needs you to sign in again on the desktop".into(),
        ),
        HostError::Rpc { message, .. } => ("agent_error".into(), format!("The agent reported an error: {}", truncate(&redact(message, None), 300))),
        HostError::AgentExited => ("agent_crashed".into(), "The AI agent stopped unexpectedly".into()),
        HostError::Timeout => ("agent_timeout".into(), "The AI agent did not respond in time".into()),
        HostError::Spawn(_) => ("provider_unavailable".into(), "Could not start the AI agent".into()),
        HostError::InvalidResponse(_) => ("agent_protocol".into(), "The AI agent sent an invalid response".into()),
        HostError::UnsupportedProtocol(v) => ("agent_protocol".into(), format!("The AI agent uses unsupported ACP version {v}")),
    }
}

/// Per-session ACP client handler; enforces workspace confinement.
pub(crate) struct SessionHandler {
    bridge: Weak<Inner>,
    workspace: Workspace,
    current_task: Mutex<Option<String>>,
}

impl SessionHandler {
    fn bridge(&self) -> Option<Bridge> {
        self.bridge.upgrade().map(|inner| Bridge { inner })
    }

    fn audit_denied(&self, op: &str, reason: &str) {
        if let Some(b) = self.bridge() {
            let task = self.current_task.lock().unwrap().clone();
            b.inner.store.lock().unwrap().audit(None, task.as_deref(), "fs_denied", json!({"op": op, "reason": reason}));
            b.record_error(format!("blocked {op}: {reason}"));
        }
    }
}

#[async_trait]
impl ClientHandler for SessionHandler {
    async fn request_permission(&self, req: RequestPermissionRequest) -> PermissionDecision {
        let Some(b) = self.bridge() else { return PermissionDecision::Cancelled };
        let task = self.current_task.lock().unwrap().clone();
        b.request_permission(task, req, self.workspace.root()).await
    }

    async fn read_text_file(&self, req: ReadTextFileRequest) -> Result<String, ClientError> {
        let path = self.workspace.resolve_read(&req.path).map_err(|e| {
            self.audit_denied("read", &e.to_string());
            ClientError::new(agent_host::acp::error_codes::INVALID_REQUEST, e.to_string())
        })?;
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|_| ClientError::new(agent_host::acp::error_codes::RESOURCE_NOT_FOUND, "file is not readable text"))?;
        let start = req.line.unwrap_or(1).max(1) as usize - 1;
        Ok(match req.limit {
            Some(limit) => content.lines().skip(start).take(limit as usize).collect::<Vec<_>>().join("\n"),
            None if start > 0 => content.lines().skip(start).collect::<Vec<_>>().join("\n"),
            None => content,
        })
    }

    async fn write_text_file(&self, req: WriteTextFileRequest) -> Result<(), ClientError> {
        let path = self.workspace.resolve_write(&req.path, req.content.len()).map_err(|e| {
            self.audit_denied("write", &e.to_string());
            ClientError::new(agent_host::acp::error_codes::INVALID_REQUEST, e.to_string())
        })?;
        tokio::fs::write(&path, req.content)
            .await
            .map_err(|e| ClientError::new(agent_host::acp::error_codes::INTERNAL_ERROR, e.to_string()))
    }
}
