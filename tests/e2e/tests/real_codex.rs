//! Real provider check. Ignored by default because it uses the developer's
//! own signed-in Codex account (a single tiny prompt). Run with:
//!   cargo test -p e2e-tests --test real_codex -- --ignored --nocapture

use bridge_core::UiEvent;
use e2e_tests::*;

#[tokio::test]
#[ignore]
async fn codex_through_bridge() {
    through_bridge("codex", "read-only").await;
}

#[tokio::test]
#[ignore]
async fn claude_through_bridge() {
    through_bridge("claude", "default").await;
}

async fn through_bridge(provider: &str, expected_mode: &str) {
    let relay = start_relay().await;
    let d = start_desktop_with(&relay.url, std::path::PathBuf::from(env!("CARGO_BIN_EXE_mock-acp-agent"))).await;
    let version = d.bridge.install_adapter(provider).await.expect("install codex adapter");
    println!("installed {provider} adapter {version}");
    let codex = d.bridge.providers().into_iter().find(|p| p.id == provider).unwrap();
    println!("{provider} provider: {:?} - {}", codex.state, codex.status_message);
    assert_eq!(codex.state, bridge_core::providers::ProviderState::Ready);

    let svc = Service::new(&relay.url, SVC_A, SECRET_A);
    let p = svc.create_pairing("dev").await;
    let req = d.bridge.begin_pairing(p["url"].as_str().unwrap()).await.unwrap();
    // Codex ChatGPT mode requires acknowledging the plan notice.
    let opts_base = bridge_core::AcceptOptions {
        provider_id: provider.into(),
        workspace: d.workspace_path(),
        access: Default::default(),
        require_task_approval: true,
        duration_secs: 3600,
        acknowledge_terms: false,
    };
    let mut opts = opts_base;
    opts.acknowledge_terms = true;
    let g = d.bridge.accept_pairing(&req.pairing_id, opts).await.unwrap();

    let mut ui = d.bridge.subscribe();
    let (_, t) = svc.start_task(&g.connection_id, "dev", "Reply with exactly the text BRIDGE_OK and nothing else. Do not run any tools.").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    wait_event(&mut ui, |e| matches!(e, UiEvent::TaskApprovalRequested { .. }).then_some(())).await;
    d.bridge.approve_task(&id, true).await.unwrap();
    let ev = svc.events(&id, None).await;
    let text = text_of(&ev);
    println!("{provider} said: {text:?}");
    println!("terminal: {:?}", terminal(&ev));
    let diag = d.bridge.diagnostics().await;
    println!("session: {:?}", diag.sessions.first().map(|s| (&s.agent_name, &s.current_mode, s.sandbox_enforced)));
    assert!(text.contains("BRIDGE_OK"));
    assert_eq!(terminal(&ev).unwrap()["kind"], "task.completed");
    let s = diag.sessions.first().unwrap();
    assert_eq!(s.current_mode.as_deref(), Some(expected_mode));
    // No account email / auth label leaked to the website stream.
    let raw = serde_json::to_string(&ev).unwrap();
    assert!(!raw.contains('@'), "{raw}");
}
