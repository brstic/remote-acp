//! Headless desktop used by the TypeScript SDK end-to-end test.
//! TEST HARNESS ONLY: it auto-approves according to env flags and is never
//! shipped. Reads a pairing link on stdin; prints JSON status lines.
use std::sync::Arc;

use bridge_core::secrets::MemoryStore;
use bridge_core::{AcceptOptions, Bridge, BridgeConfig, UiEvent};
use tokio::io::AsyncBufReadExt;

#[tokio::main]
async fn main() {
    let relay = std::env::var("RELAY_URL").expect("RELAY_URL");
    let workspace = std::env::var("WORKSPACE").expect("WORKSPACE");
    let mock = std::env::var("MOCK_AGENT").expect("MOCK_AGENT");
    let permission = std::env::var("PERMISSION_CHOICE").unwrap_or_else(|_| "allow_once".into());
    let data = tempfile::tempdir().unwrap();
    let bridge = Bridge::start(BridgeConfig {
        data_dir: data.path().into(),
        default_relay_url: relay,
        app_version: "e2e".into(),
        mock_command: Some((mock.into(), vec![])),
        secrets: Arc::new(MemoryStore::default()),
        in_memory_db: true,
    })
    .await
    .unwrap();
    let mut ui = bridge.subscribe();
    let b2 = bridge.clone();
    tokio::spawn(async move {
        while let Ok(ev) = ui.recv().await {
            match ev {
                UiEvent::TaskApprovalRequested { task_id, .. } => {
                    println!("{}", serde_json::json!({"event": "approval", "taskId": task_id}));
                    b2.approve_task(&task_id, true).await.unwrap();
                }
                UiEvent::PermissionRequested { request_id, .. } => {
                    println!("{}", serde_json::json!({"event": "permission", "requestId": request_id}));
                    b2.respond_permission(&request_id, &permission).unwrap();
                }
                _ => {}
            }
        }
    });
    println!("{}", serde_json::json!({"event": "ready"}));
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let link = line.trim();
        if link.is_empty() { continue; }
        match bridge.begin_pairing(link).await {
            Ok(req) => {
                let g = bridge
                    .accept_pairing(&req.pairing_id, AcceptOptions {
                        provider_id: "mock".into(),
                        workspace: workspace.clone(),
                        access: Default::default(),
                        require_task_approval: true,
                        duration_secs: 3600,
                        acknowledge_terms: false,
                    })
                    .await;
                match g {
                    Ok(g) => println!("{}", serde_json::json!({"event": "paired", "connectionId": g.connection_id, "service": req.service.display_name})),
                    Err(e) => println!("{}", serde_json::json!({"event": "error", "message": e.to_string()})),
                }
            }
            Err(e) => println!("{}", serde_json::json!({"event": "error", "message": e.to_string()})),
        }
    }
    bridge.shutdown().await;
}
