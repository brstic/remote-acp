//! Remote ACP Bridge relay.
//!
//! Routes authorized task traffic between registered website backends and
//! paired desktops. It never sees provider credentials, stores no prompts or
//! results on disk, and keeps only a bounded in-memory event buffer per task
//! so a website can resume an SSE stream.

pub mod config;
pub mod http;
pub mod state;
pub mod store;
pub mod ws;

use std::time::Duration;

pub use config::RelayConfig;
pub use state::{AppState, Shared};

/// Verify `well_known` services by fetching `<origin>/.well-known/remote-acp.json`
/// and checking it names the same service id.
pub async fn verify_services(st: &Shared) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client");
    for s in &st.cfg.services {
        if s.verification != config::VerificationMode::WellKnown {
            continue;
        }
        let url = format!("{}/.well-known/remote-acp.json", s.origin.trim_end_matches('/'));
        let ok = match client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("serviceId").and_then(|x| x.as_str()).map(|x| x == s.id))
                .unwrap_or(false),
            _ => false,
        };
        tracing::info!(service = %s.id, verified = ok, "well-known verification");
        st.verified.lock().unwrap().insert(s.id.clone(), ok);
    }
}

/// Build the router and spawn the maintenance sweeper.
pub fn app(st: Shared) -> axum::Router {
    let sweeper = st.clone();
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(5));
        loop {
            iv.tick().await;
            sweeper.sweep();
        }
    });
    http::router(st)
}
