//! Outbound-only relay connection: registration, authenticated HTTP calls
//! and the WebSocket loop with heartbeat, backoff and resend-on-reconnect.

use std::time::{Duration, Instant};

use bridge_protocol::{Body, Envelope, Hello, Sender, MAX_FRAME_BYTES, PROTOCOL_VERSION};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::engine::{validate_relay_url, BResult, Bridge, BridgeError};
use crate::views::RelayStatus;

fn token_key(relay: &str) -> String {
    format!("relay-token:{}", relay.trim_end_matches('/'))
}

fn friendly_http_error(status: u16, body: &Value) -> BridgeError {
    let msg = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Relay returned HTTP {status}"));
    BridgeError::User(msg)
}

/// Get (or create by registering) this desktop's relay credential.
pub(crate) async fn desktop_token(b: &Bridge) -> BResult<String> {
    let relay = b.relay_url();
    let key = token_key(&relay);
    // OS keychains may block (e.g. an authorization prompt); keep it off the async runtime.
    let secrets = b.inner.cfg.secrets.clone();
    let k2 = key.clone();
    let existing = tokio::task::spawn_blocking(move || secrets.get(&k2)).await.ok().flatten();
    if let Some(t) = existing {
        if let Some((id, _)) = t.split_once('.') {
            *b.inner.desktop_id.lock().unwrap() = Some(id.to_string());
        }
        return Ok(t);
    }
    validate_relay_url(&relay).map_err(BridgeError::User)?;
    let url = format!("{}/v1/desktops/register", relay.trim_end_matches('/'));
    let resp = b
        .inner
        .http
        .post(&url)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| BridgeError::User("Can't reach the relay. Check your internet connection and relay address.".into()))?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status != 200 {
        return Err(friendly_http_error(status, &v));
    }
    let token = v["desktopToken"].as_str().ok_or_else(|| BridgeError::Internal("bad registration".into()))?.to_string();
    let secrets = b.inner.cfg.secrets.clone();
    let (k2, t2) = (key.clone(), token.clone());
    tokio::task::spawn_blocking(move || secrets.set(&k2, &t2))
        .await
        .map_err(|e| BridgeError::Internal(e.to_string()))?
        .map_err(|e| BridgeError::Internal(e.to_string()))?;
    *b.inner.desktop_id.lock().unwrap() = v["desktopId"].as_str().map(str::to_string);
    b.inner.store.lock().unwrap().audit(None, None, "desktop_registered", serde_json::json!({"relay": relay}));
    Ok(token)
}

/// Authenticated POST to the relay as this desktop.
pub(crate) async fn post(b: &Bridge, path: &str, body: Value) -> BResult<Value> {
    let token = desktop_token(b).await?;
    let url = format!("{}{}", b.relay_url().trim_end_matches('/'), path);
    let resp = b
        .inner
        .http
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|_| BridgeError::User("Can't reach the relay right now".into()))?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status == 401 {
        // Credential no longer valid (e.g. relay database reset): re-register next time.
        let _ = b.inner.cfg.secrets.delete(&token_key(&b.relay_url()));
    }
    if !(200..300).contains(&status) {
        return Err(friendly_http_error(status, &v));
    }
    Ok(v)
}

fn set_status(b: &Bridge, s: RelayStatus) {
    let changed = {
        let mut cur = b.inner.relay_status.lock().unwrap();
        let changed = *cur != s;
        *cur = s;
        changed
    };
    if changed {
        b.changed();
    }
}

fn backoff(attempt: u32) -> Duration {
    let base = 500u64.saturating_mul(1u64 << attempt.min(6)).min(30_000);
    let mut r = [0u8; 2];
    let _ = getrandom::fill(&mut r);
    let jitter = (u16::from_le_bytes(r) as u64) % (base / 2 + 1);
    Duration::from_millis(base / 2 + jitter)
}

pub(crate) async fn run(b: Bridge, mut out_rx: mpsc::Receiver<Envelope>) {
    let mut attempt: u32 = 0;
    let mut resend: Option<String> = None;
    loop {
        set_status(&b, RelayStatus::Connecting);
        match session(&b, &mut out_rx, &mut resend).await {
            Ok(()) => attempt = 0,
            Err(msg) => {
                b.record_error(format!("relay: {msg}"));
                set_status(&b, RelayStatus::Disconnected { message: msg });
                attempt = attempt.saturating_add(1);
            }
        }
        if matches!(*b.inner.relay_status.lock().unwrap(), RelayStatus::Connected { .. }) {
            set_status(&b, RelayStatus::Disconnected { message: "Reconnecting…".into() });
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff(attempt)) => {}
            _ = b.inner.restart_relay.notified() => { attempt = 0; }
        }
    }
}

async fn session(b: &Bridge, out_rx: &mut mpsc::Receiver<Envelope>, resend: &mut Option<String>) -> Result<(), String> {
    let relay = b.relay_url();
    let base = validate_relay_url(&relay)?;
    let token = desktop_token(b).await.map_err(|e| e.to_string())?;
    let mut ws_url = base.clone();
    let scheme = if base.scheme() == "https" { "wss" } else { "ws" };
    ws_url.set_scheme(scheme).map_err(|_| "invalid relay url".to_string())?;
    ws_url.set_path(&format!("{}/v1/desktop", base.path().trim_end_matches('/')));
    let mut req = ws_url.as_str().into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {token}").parse().map_err(|_| "bad token".to_string())?,
    );
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_FRAME_BYTES);
    cfg.max_frame_size = Some(MAX_FRAME_BYTES);
    let connect = tokio_tungstenite::connect_async_with_config(req, Some(cfg), false);
    let (ws, _) = match tokio::time::timeout(Duration::from_secs(15), connect).await {
        Ok(Ok(x)) => x,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(resp))) if resp.status() == 401 => {
            let _ = b.inner.cfg.secrets.delete(&token_key(&relay));
            return Err("Relay did not recognize this computer; registering again".into());
        }
        Ok(Err(e)) => return Err(format!("Can't connect to relay ({e})")),
        Err(_) => return Err("Relay connection timed out".into()),
    };
    let (mut sink, mut stream) = ws.split();
    let hello = Envelope::new(Body::Hello(Hello {
        app_version: b.inner.cfg.app_version.clone(),
        supported_versions: vec![PROTOCOL_VERSION],
    }));
    sink.send(Message::Text(hello.to_json().into())).await.map_err(|e| e.to_string())?;
    // Await ready.
    let ready = loop {
        match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let env = Envelope::parse(t.as_str(), Sender::Relay).map_err(|e| e.to_string())?;
                match env.body {
                    Body::Ready(r) => break r,
                    Body::Error(e) => return Err(e.message),
                    _ => continue,
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => return Err("Relay handshake failed".into()),
        }
    };
    if ready.negotiated_version != PROTOCOL_VERSION {
        return Err("Relay uses an incompatible protocol version".into());
    }
    *b.inner.desktop_id.lock().unwrap() = Some(ready.desktop_id.clone());
    b.reconcile(&ready.active_connections).await;
    set_status(b, RelayStatus::Connected { latency_ms: None });

    if let Some(frame) = resend.take() {
        if sink.send(Message::Text(frame.clone().into())).await.is_err() {
            *resend = Some(frame);
            return Err("connection lost".into());
        }
    }

    let mut hb = tokio::time::interval(Duration::from_secs(20));
    hb.tick().await;
    let mut last_rx = Instant::now();
    let mut hb_sent: Option<Instant> = None;
    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { return Err("Relay connection lost".into()) };
                last_rx = Instant::now();
                match msg {
                    Message::Text(t) => {
                        match Envelope::parse(t.as_str(), Sender::Relay) {
                            Ok(env) => handle_inbound(b, env, &mut hb_sent).await,
                            Err(e) => b.record_error(format!("invalid relay frame: {e}")),
                        }
                    }
                    Message::Close(_) => return Err("Relay closed the connection".into()),
                    _ => {}
                }
            }
            env = out_rx.recv() => {
                let Some(env) = env else { return Ok(()) };
                let frame = env.to_json();
                if sink.send(Message::Text(frame.clone().into())).await.is_err() {
                    *resend = Some(frame);
                    return Err("Relay connection lost".into());
                }
            }
            _ = hb.tick() => {
                if last_rx.elapsed() > Duration::from_secs(60) {
                    return Err("Relay stopped responding".into());
                }
                hb_sent = Some(Instant::now());
                let env = Envelope::new(Body::Heartbeat(Default::default()));
                if sink.send(Message::Text(env.to_json().into())).await.is_err() {
                    return Err("Relay connection lost".into());
                }
            }
            _ = b.inner.restart_relay.notified() => {
                let _ = sink.close().await;
                return Ok(());
            }
        }
    }
}

async fn handle_inbound(b: &Bridge, env: Envelope, hb_sent: &mut Option<Instant>) {
    match env.body.clone() {
        Body::TaskStart(start) => {
            let b = b.clone();
            tokio::spawn(async move { b.on_task_start(env, start).await });
        }
        Body::TaskCancel(_) => {
            if let Some(t) = &env.task_id {
                b.cancel_task(t, "cancelled by the website").await;
            }
        }
        Body::Revoke(_) => {
            if let Some(c) = &env.connection_id {
                b.on_remote_revoke(c, "website").await;
            }
        }
        Body::Heartbeat(_) => {
            if let Some(sent) = hb_sent.take() {
                let ms = sent.elapsed().as_millis() as u64;
                set_status(b, RelayStatus::Connected { latency_ms: Some(ms) });
            }
        }
        Body::Error(e) => b.record_error(format!("relay error {}: {}", e.code, e.message)),
        _ => {}
    }
}
