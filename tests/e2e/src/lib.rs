//! Test harness: in-process relay + headless desktop bridge + service client.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bridge_core::secrets::MemoryStore;
use bridge_core::{Bridge, BridgeConfig, UiEvent};
use futures::StreamExt;
use relay::config::{RelayConfig, ServiceConfig, VerificationMode};
use relay::{AppState, Shared};
use serde_json::{json, Value};

pub const SVC_A: &str = "svc_alpha";
pub const SVC_B: &str = "svc_beta";
pub const SECRET_A: &str = "alpha-secret-for-tests-only-0123456789";
pub const SECRET_B: &str = "beta-secret-for-tests-only-0123456789";

pub struct Relay {
    pub url: String,
    pub state: Shared,
    pub server: tokio::task::JoinHandle<()>,
}

pub async fn start_relay_with(db: &str, mutate: impl FnOnce(&mut RelayConfig)) -> Relay {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}");
    let mut cfg = RelayConfig {
        listen: addr.to_string(),
        public_url: url.clone(),
        database: db.into(),
        services: vec![
            ServiceConfig {
                id: SVC_A.into(),
                display_name: "Alpha Notes".into(),
                origin: "http://localhost:3000".into(),
                secret_sha256: bridge_protocol::ids::sha256_hex(SECRET_A),
                verification: VerificationMode::Operator,
            },
            ServiceConfig {
                id: SVC_B.into(),
                display_name: "Beta Evil".into(),
                origin: "http://localhost:4000".into(),
                secret_sha256: bridge_protocol::ids::sha256_hex(SECRET_B),
                verification: VerificationMode::Unverified,
            },
        ],
        limits: Default::default(),
    };
    mutate(&mut cfg);
    let state = AppState::new(cfg).unwrap();
    let app = relay::app(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Relay { url, state, server }
}

pub async fn start_relay() -> Relay {
    start_relay_with(":memory:", |_| {}).await
}

pub struct Desktop {
    pub bridge: Bridge,
    pub data: tempfile::TempDir,
    pub workspace: tempfile::TempDir,
}

pub async fn start_desktop_with(relay_url: &str, mock_agent: PathBuf) -> Desktop {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let bridge = Bridge::start(BridgeConfig {
        data_dir: data.path().to_path_buf(),
        default_relay_url: relay_url.into(),
        app_version: "test".into(),
        mock_command: Some((mock_agent, vec![])),
        secrets: Arc::new(MemoryStore::default()),
        in_memory_db: true,
    })
    .await
    .unwrap();
    let d = Desktop { bridge, data, workspace };
    d.wait_connected().await;
    d
}

impl Desktop {
    pub async fn wait_connected(&self) {
        for _ in 0..200 {
            if matches!(self.bridge.snapshot().bridge.relay, bridge_core::RelayStatus::Connected { .. }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("desktop never connected: {:?}", self.bridge.snapshot().bridge.relay);
    }

    pub fn workspace_path(&self) -> String {
        self.workspace.path().to_string_lossy().to_string()
    }

    /// Pair with a service using the default options; returns connection id.
    pub async fn pair(&self, svc: &Service, user: &str, require_approval: bool) -> String {
        let p = svc.create_pairing(user).await;
        let req = self.bridge.begin_pairing(p["url"].as_str().unwrap()).await.unwrap();
        let g = self
            .bridge
            .accept_pairing(
                &req.pairing_id,
                bridge_core::AcceptOptions {
                    provider_id: "mock".into(),
                    workspace: self.workspace_path(),
                    access: Default::default(),
                    require_task_approval: require_approval,
                    duration_secs: 3600,
                    acknowledge_terms: false,
                },
            )
            .await
            .unwrap();
        let st = svc.get(&format!("/v1/pairings/{}", p["pairingId"].as_str().unwrap())).await.1;
        assert_eq!(st["status"], "accepted");
        assert_eq!(st["connectionId"], g.connection_id.as_str());
        g.connection_id
    }
}

/// Wait for a UI event matching `f`.
pub async fn wait_event<T>(rx: &mut tokio::sync::broadcast::Receiver<UiEvent>, mut f: impl FnMut(&UiEvent) -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timed out waiting for ui event");
        match ev {
            Ok(e) => {
                if let Some(v) = f(&e) {
                    return v;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(e) => panic!("ui channel: {e}"),
        }
    }
}

pub struct Service {
    pub base: String,
    pub token: String,
    pub http: reqwest::Client,
}

impl Service {
    pub fn new(base: &str, id: &str, secret: &str) -> Self {
        Self {
            base: base.into(),
            token: format!("{id}.{secret}"),
            http: reqwest::Client::new(),
        }
    }

    pub async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let r = self
            .http
            .post(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let s = r.status().as_u16();
        (s, r.json().await.unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str) -> (u16, Value) {
        let r = self
            .http
            .get(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap();
        let s = r.status().as_u16();
        (s, r.json().await.unwrap_or(Value::Null))
    }

    pub async fn create_pairing(&self, user: &str) -> Value {
        let (s, v) = self.post("/v1/pairings", json!({"externalUserId": user, "scopes": ["task.interactive"]})).await;
        assert_eq!(s, 200, "{v}");
        v
    }

    pub async fn start_task(&self, conn: &str, user: &str, prompt: &str) -> (u16, Value) {
        self.post(
            "/v1/tasks",
            json!({"connectionId": conn, "externalUserId": user, "prompt": prompt,
                   "idempotencyKey": bridge_protocol::ids::new_id("idem")}),
        )
        .await
    }

    /// Collect SSE events until a terminal event (or timeout).
    pub async fn events(&self, task_id: &str, last_event_id: Option<u64>) -> Vec<Value> {
        let mut req = self
            .http
            .get(format!("{}/v1/tasks/{task_id}/events", self.base))
            .bearer_auth(&self.token);
        if let Some(id) = last_event_id {
            req = req.header("last-event-id", id.to_string());
        }
        let resp = req.send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut out = vec![];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let chunk = match tokio::time::timeout_at(deadline, stream.next()).await {
                Ok(Some(Ok(c))) => c,
                _ => break,
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find("\n\n") {
                let block = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                for line in block.lines() {
                    if let Some(d) = line.strip_prefix("data:") {
                        if let Ok(v) = serde_json::from_str::<Value>(d.trim()) {
                            out.push(v);
                        }
                    }
                }
            }
            if out.iter().any(|e| matches!(e["kind"].as_str(), Some("task.completed" | "task.failed" | "task.rejected"))) {
                break;
            }
        }
        out
    }
}

pub fn text_of(events: &[Value]) -> String {
    events
        .iter()
        .filter(|e| e["kind"] == "task.event" && e["payload"]["type"] == "text_delta")
        .map(|e| e["payload"]["text"].as_str().unwrap_or("").to_string())
        .collect()
}

pub fn terminal(events: &[Value]) -> Option<&Value> {
    events
        .iter()
        .find(|e| matches!(e["kind"].as_str(), Some("task.completed" | "task.failed" | "task.rejected")))
}
