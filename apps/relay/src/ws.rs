//! Outbound desktop WebSocket: `WSS /v1/desktop`.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use bridge_protocol::{Body, Envelope, Ready, Sender, MAX_FRAME_BYTES, PROTOCOL_VERSION};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::http::{auth_desktop, ApiError};
use crate::state::Shared;

pub async fn desktop_ws(State(st): State<Shared>, headers: HeaderMap, ws: WebSocketUpgrade) -> Result<Response, ApiError> {
    let desktop_id = auth_desktop(&st, &headers)?;
    Ok(ws
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle(st, desktop_id, socket)))
}

async fn handle(st: Shared, desktop_id: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // Require a valid hello within 10 seconds.
    let hello = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
    let ok = match hello {
        Ok(Some(Ok(Message::Text(t)))) => match Envelope::parse(t.as_str(), Sender::Desktop) {
            Ok(env) => match &env.body {
                Body::Hello(h) => h.supported_versions.contains(&PROTOCOL_VERSION),
                _ => false,
            },
            Err(_) => false,
        },
        _ => false,
    };
    if !ok {
        let err = Envelope::new(Body::Error(bridge_protocol::ErrorPayload::new(
            "handshake_failed",
            "expected connection.hello with a supported version",
        )));
        let _ = sink.send(Message::Text(err.to_json().into())).await;
        let _ = sink.close().await;
        return;
    }

    let (tx, mut rx) = mpsc::channel::<String>(512);
    let (generation, kill) = st.register_online(&desktop_id, tx.clone());
    tracing::info!(%desktop_id, generation, "desktop connected");

    let active: Vec<String> = st
        .store
        .lock()
        .unwrap()
        .connections_for_desktop(&desktop_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.effective_status(Utc::now()) != "revoked" && c.effective_status(Utc::now()) != "expired")
        .map(|c| c.id)
        .collect();
    let ready = Envelope::new(Body::Ready(Ready {
        desktop_id: desktop_id.clone(),
        negotiated_version: PROTOCOL_VERSION,
        active_connections: active,
    }));
    let _ = tx.send(ready.to_json()).await;

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(Message::Text(m.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Reader: the desktop sends a heartbeat at least every 20 s.
    loop {
        let next = tokio::select! {
            n = tokio::time::timeout(Duration::from_secs(60), stream.next()) => n,
            _ = kill.notified() => break,
        };
        let msg = match next {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        match msg {
            Message::Text(t) => match Envelope::parse(t.as_str(), Sender::Desktop) {
                Ok(env) => {
                    if let Some(reply) = st.handle_desktop_envelope(&desktop_id, env) {
                        if tx.try_send(reply.to_json()).is_err() {
                            break;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(%desktop_id, error = %e, "invalid desktop frame");
                    let err = Envelope::new(Body::Error(bridge_protocol::ErrorPayload::new("invalid_frame", e.to_string())));
                    let _ = tx.try_send(err.to_json());
                }
            },
            Message::Close(_) => break,
            Message::Binary(_) => {
                let err = Envelope::new(Body::Error(bridge_protocol::ErrorPayload::new("invalid_frame", "binary frames are not supported")));
                let _ = tx.try_send(err.to_json());
            }
            _ => {}
        }
    }
    st.unregister_online(&desktop_id, generation);
    drop(tx);
    writer.abort();
    tracing::info!(%desktop_id, generation, "desktop disconnected");
}
