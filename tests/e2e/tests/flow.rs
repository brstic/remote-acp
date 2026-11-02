//! End-to-end: website backend -> relay -> desktop bridge -> local ACP agent.

use std::time::Duration;

use bridge_core::UiEvent;
use e2e_tests::*;
use serde_json::json;

async fn start_desktop(url: &str) -> Desktop {
    start_desktop_with(url, std::path::PathBuf::from(env!("CARGO_BIN_EXE_mock-acp-agent"))).await
}

async fn setup() -> (Relay, Desktop, Service) {
    let relay = start_relay().await;
    let desktop = start_desktop(&relay.url).await;
    let svc = Service::new(&relay.url, SVC_A, SECRET_A);
    (relay, desktop, svc)
}

#[tokio::test]
async fn pair_approve_stream_complete() {
    let (_r, d, svc) = setup().await;
    let mut ui = d.bridge.subscribe();
    let conn = d.pair(&svc, "user-1", true).await;

    // Desktop shows verified service identity from the relay, not the link.
    let snap = d.bridge.snapshot();
    let g = snap.grants.iter().find(|g| g.connection_id == conn).unwrap();
    assert_eq!(g.service.as_ref().unwrap().display_name, "Alpha Notes");
    assert!(g.service.as_ref().unwrap().verified);

    let (s, t) = svc.start_task(&conn, "user-1", "hello bridge").await;
    assert_eq!(s, 201, "{t}");
    let task_id = t["taskId"].as_str().unwrap().to_string();

    let tid = wait_event(&mut ui, |e| match e {
        UiEvent::TaskApprovalRequested { task_id, .. } => Some(task_id.clone()),
        _ => None,
    })
    .await;
    assert_eq!(tid, task_id);
    d.bridge.approve_task(&task_id, true).await.unwrap();

    let events = svc.events(&task_id, None).await;
    assert_eq!(text_of(&events), "Hello from the test agent. You said: hello bridge");
    let fin = terminal(&events).unwrap();
    assert_eq!(fin["kind"], "task.completed");
    assert_eq!(fin["payload"]["stopReason"], "end_turn");
    assert!(events.iter().any(|e| e["kind"] == "task.accepted"));
    assert!(events.iter().any(|e| e["payload"]["type"] == "plan"));
    // Sequence ids strictly increase with no duplicates.
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[1] > w[0]));

    let (_, st) = svc.get(&format!("/v1/tasks/{task_id}")).await;
    assert_eq!(st["state"], "completed");

    // Desktop shows the same task and transcript.
    let snap = d.bridge.snapshot();
    let tv = snap.tasks.iter().find(|t| t.id == task_id).unwrap();
    assert_eq!(tv.state, bridge_protocol::TaskState::Completed);

    // Resume with Last-Event-ID replays only later events.
    let mid = seqs[seqs.len() / 2];
    let replay = svc.events(&task_id, Some(mid)).await;
    assert!(replay.iter().all(|e| e["seq"].as_u64().unwrap() > mid));
    assert!(terminal(&replay).is_some());

    // Multi-turn: second task reuses the same agent session.
    let (_, t2) = svc.start_task(&conn, "user-1", "second").await;
    let t2id = t2["taskId"].as_str().unwrap().to_string();
    wait_event(&mut ui, |e| matches!(e, UiEvent::TaskApprovalRequested { task_id, .. } if *task_id == t2id).then_some(())).await;
    d.bridge.approve_task(&t2id, true).await.unwrap();
    let ev2 = svc.events(&t2id, None).await;
    assert!(text_of(&ev2).contains("You said: second"));
    let diag = d.bridge.diagnostics().await;
    assert_eq!(diag.sessions.len(), 1);
    assert_eq!(diag.sessions[0].current_mode.as_deref(), Some("ask"));
    assert!(diag.sessions[0].sandbox_enforced);
}

#[tokio::test]
async fn desktop_declines_task() {
    let (_r, d, svc) = setup().await;
    let mut ui = d.bridge.subscribe();
    let conn = d.pair(&svc, "u", true).await;
    let (_, t) = svc.start_task(&conn, "u", "do something").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    wait_event(&mut ui, |e| matches!(e, UiEvent::TaskApprovalRequested { .. }).then_some(())).await;
    d.bridge.approve_task(&id, false).await.unwrap();
    let ev = svc.events(&id, None).await;
    let fin = terminal(&ev).unwrap();
    assert_eq!(fin["kind"], "task.rejected");
    assert_eq!(fin["payload"]["code"], "declined");
}

#[tokio::test]
async fn permission_allow_and_deny_are_local_only() {
    let (_r, d, svc) = setup().await;
    let mut ui = d.bridge.subscribe();
    let conn = d.pair(&svc, "u", false).await;

    // Allow
    let (_, t) = svc.start_task(&conn, "u", "permission please").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    let req = wait_event(&mut ui, |e| match e {
        UiEvent::PermissionRequested { request_id, .. } => Some(request_id.clone()),
        _ => None,
    })
    .await;
    // The website has no API to answer permission prompts.
    let (s, _) = svc.post(&format!("/v1/tasks/{id}/permissions/{req}"), json!({"optionId": "allow"})).await;
    assert!(s == 404 || s == 405, "status {s}");
    d.bridge.respond_permission(&req, "allow_once").unwrap();
    let ev = svc.events(&id, None).await;
    assert!(text_of(&ev).contains("PERMISSION_GRANTED"));
    assert!(ev.iter().any(|e| e["payload"]["type"] == "permission_pending"));
    assert!(ev.iter().any(|e| e["payload"]["type"] == "permission_resolved" && e["payload"]["outcome"] == "allowed"));
    assert!(d.workspace.path().join("mock-output.txt").exists());
    std::fs::remove_file(d.workspace.path().join("mock-output.txt")).unwrap();

    // Deny
    let (_, t) = svc.start_task(&conn, "u", "permission again").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    let req = wait_event(&mut ui, |e| match e {
        UiEvent::PermissionRequested { request_id, .. } => Some(request_id.clone()),
        _ => None,
    })
    .await;
    d.bridge.respond_permission(&req, "deny").unwrap();
    let ev = svc.events(&id, None).await;
    assert!(text_of(&ev).contains("PERMISSION_DENIED"));
    assert!(ev.iter().any(|e| e["payload"]["outcome"] == "denied"));
    assert!(!d.workspace.path().join("mock-output.txt").exists());
}

#[tokio::test]
async fn cancel_from_website_and_desktop() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;

    let (_, t) = svc.start_task(&conn, "u", "slow").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let (s, _) = svc.post(&format!("/v1/tasks/{id}/cancel"), json!({})).await;
    assert_eq!(s, 200);
    let ev = svc.events(&id, None).await;
    let fin = terminal(&ev).unwrap();
    assert_eq!(fin["payload"]["stopReason"], "cancelled");
    assert!(!text_of(&ev).contains("step 59"));

    let (_, t) = svc.start_task(&conn, "u", "slow").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(400)).await;
    d.bridge.cancel_task(&id, "user pressed stop").await;
    let ev = svc.events(&id, None).await;
    assert_eq!(terminal(&ev).unwrap()["payload"]["stopReason"], "cancelled");
    let (_, st) = svc.get(&format!("/v1/tasks/{id}")).await;
    assert_eq!(st["state"], "cancelled");
}

#[tokio::test]
async fn revoke_from_desktop_blocks_new_tasks_and_stops_running() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    let (_, t) = svc.start_task(&conn, "u", "slow").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(300)).await;
    d.bridge.revoke_grant(&conn).await.unwrap();
    let ev = svc.events(&id, None).await;
    assert_eq!(terminal(&ev).unwrap()["payload"]["stopReason"], "cancelled");
    let (s, v) = svc.start_task(&conn, "u", "hi").await;
    assert_eq!(s, 410, "{v}");
    assert_eq!(v["error"]["code"], "connection_revoked");
    let (_, c) = svc.get(&format!("/v1/connections/{conn}")).await;
    assert_eq!(c["status"], "revoked");
}

#[tokio::test]
async fn revoke_from_service_reaches_desktop() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    let (s, _) = svc.post(&format!("/v1/connections/{conn}/revoke"), json!({})).await;
    assert_eq!(s, 200);
    for _ in 0..100 {
        let snap = d.bridge.snapshot();
        if snap.grants.iter().any(|g| g.connection_id == conn && g.status == connection_policy::GrantStatus::Revoked) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("desktop grant not revoked");
}

#[tokio::test]
async fn tenant_and_user_isolation() {
    let (r, d, svc) = setup().await;
    let conn = d.pair(&svc, "alice", false).await;
    let other = Service::new(&r.url, SVC_B, SECRET_B);

    // Wrong user of the right service.
    let (s, _) = svc.start_task(&conn, "mallory", "hi").await;
    assert_eq!(s, 404);
    // Another service cannot use, read or revoke the connection.
    let (s, _) = other.start_task(&conn, "alice", "hi").await;
    assert_eq!(s, 404);
    assert_eq!(other.get(&format!("/v1/connections/{conn}")).await.0, 404);
    assert_eq!(other.post(&format!("/v1/connections/{conn}/revoke"), json!({})).await.0, 404);
    let (_, list) = other.get("/v1/connections?externalUserId=alice").await;
    assert_eq!(list["connections"].as_array().unwrap().len(), 0);
    // ...nor read its tasks.
    let (_, t) = svc.start_task(&conn, "alice", "hi").await;
    let id = t["taskId"].as_str().unwrap();
    assert_eq!(other.get(&format!("/v1/tasks/{id}")).await.0, 404);
    assert_eq!(other.post(&format!("/v1/tasks/{id}/cancel"), json!({})).await.0, 404);
    // Bad credentials.
    let bad = Service::new(&r.url, SVC_A, "wrong-secret");
    assert_eq!(bad.start_task(&conn, "alice", "x").await.0, 401);
    let _ = svc.events(id, None).await;
}

#[tokio::test]
async fn pairing_ticket_single_use_and_expiry_and_brand() {
    let (r, d, svc) = setup().await;
    let p = svc.create_pairing("u").await;
    let url = p["url"].as_str().unwrap();
    let req = d.bridge.begin_pairing(url).await.unwrap();
    assert_eq!(req.service.domain, "localhost");
    // A second desktop cannot reuse the ticket.
    let d2 = start_desktop(&r.url).await;
    let err = d2.bridge.begin_pairing(url).await.unwrap_err();
    assert!(err.to_string().contains("already used"), "{err}");
    // Code form works and identity always comes from the relay registry.
    let p2 = svc.create_pairing("u").await;
    let req2 = d2.bridge.begin_pairing(p2["code"].as_str().unwrap()).await.unwrap();
    assert_eq!(req2.service.display_name, "Alpha Notes");
    // An unverified service is flagged.
    let evil = Service::new(&r.url, SVC_B, SECRET_B);
    let p3 = evil.create_pairing("u").await;
    let req3 = d.bridge.begin_pairing(p3["url"].as_str().unwrap()).await.unwrap();
    assert!(!req3.service.verified);
    // A link pointing to a different relay is refused.
    let foreign = url.replace(&r.url.replace(':', "%3A").replace('/', "%2F"), "https%3A%2F%2Fevil.example");
    let err = d.bridge.begin_pairing(&foreign).await.unwrap_err();
    assert!(err.to_string().contains("different relay"), "{err}");
    // Garbage tickets.
    assert!(d.bridge.begin_pairing("remoteacp://pair?ticket=nope").await.is_err());
    let _ = req;
}

#[tokio::test]
async fn expired_ticket_is_rejected() {
    let relay = start_relay_with(":memory:", |c| c.limits.pairing_ttl_max_secs = 1).await;
    let d = start_desktop(&relay.url).await;
    let svc = Service::new(&relay.url, SVC_A, SECRET_A);
    let (_, p) = svc.post("/v1/pairings", json!({"externalUserId": "u", "expiresInSeconds": 1})).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let r = d.bridge.begin_pairing(p["url"].as_str().unwrap()).await;
    assert!(r.unwrap_err().to_string().contains("expired"));
}

#[tokio::test]
async fn idempotency_and_single_active_task() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    let body = json!({"connectionId": conn, "externalUserId": "u", "prompt": "slow", "idempotencyKey": "key-1"});
    let (s1, a) = svc.post("/v1/tasks", body.clone()).await;
    let (s2, b) = svc.post("/v1/tasks", body.clone()).await;
    assert_eq!(s1, 201);
    assert_eq!(s2, 200);
    assert_eq!(a["taskId"], b["taskId"]);
    let mut changed = body.clone();
    changed["prompt"] = json!("different");
    assert_eq!(svc.post("/v1/tasks", changed).await.0, 409);
    // A second concurrent task on the same connection is refused.
    let (s, v) = svc.start_task(&conn, "u", "another").await;
    assert_eq!(s, 409);
    assert_eq!(v["error"]["code"], "task_in_progress");
    let id = a["taskId"].as_str().unwrap();
    svc.post(&format!("/v1/tasks/{id}/cancel"), json!({})).await;
    svc.events(id, None).await;
    // Exactly one task ran on the desktop.
    let n = d.bridge.snapshot().tasks.iter().filter(|t| t.source == "remote").count();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn kill_switch_and_paused_connection() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    d.bridge.set_paused(true).await.unwrap();
    let (_, t) = svc.start_task(&conn, "u", "hi").await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    assert_eq!(terminal(&ev).unwrap()["payload"]["code"], "bridge_paused");
    d.bridge.set_paused(false).await.unwrap();

    d.bridge.set_grant_paused(&conn, true).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (s, v) = svc.start_task(&conn, "u", "hi").await;
    assert_eq!(s, 409, "{v}");
    assert_eq!(v["error"]["code"], "connection_paused");
    d.bridge.set_grant_paused(&conn, false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (s, t) = svc.start_task(&conn, "u", "hi").await;
    assert_eq!(s, 201);
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    assert_eq!(terminal(&ev).unwrap()["kind"], "task.completed");
}

#[tokio::test]
async fn workspace_confinement_and_redaction() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    std::fs::write(d.workspace.path().join("notes.txt"), "inside").unwrap();
    let inside = d.workspace.path().canonicalize().unwrap().join("notes.txt");

    let (_, t) = svc.start_task(&conn, "u", &format!("read {}", inside.display())).await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    assert!(text_of(&ev).contains("READ_OK 6 bytes"));
    // Tool titles are redacted: the absolute workspace path never leaves the machine.
    let raw = serde_json::to_string(&ev).unwrap();
    assert!(!raw.contains(&inside.parent().unwrap().to_string_lossy().to_string()), "{raw}");

    for target in ["/etc/hosts".to_string(), format!("{}/.ssh/id_rsa", std::env::var("HOME").unwrap())] {
        let (_, t) = svc.start_task(&conn, "u", &format!("read {target}")).await;
        let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
        // Blocked by the output firewall before (or by fs confinement at) the read.
        let fin = terminal(&ev).unwrap();
        assert!(fin["payload"]["code"] == "policy_blocked" || text_of(&ev).contains("READ_DENIED"), "{target}: {ev:?}");
        assert!(!text_of(&ev).contains("READ_OK"));
    }
    let audit = d.bridge.diagnostics().await.audit;
    assert!(audit.iter().any(|a| a.event_type == "output_blocked" || a.event_type == "fs_denied"));
}

#[tokio::test]
async fn agent_crash_reports_failure_and_recovers() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    let (_, t) = svc.start_task(&conn, "u", "crash").await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    let fin = terminal(&ev).unwrap();
    assert_eq!(fin["kind"], "task.failed");
    assert_eq!(fin["payload"]["code"], "agent_crashed");
    // Next task gets a fresh agent.
    let (_, t) = svc.start_task(&conn, "u", "recovered fine").await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    assert!(text_of(&ev).contains("recovered fine"), "{ev:?}");
}

#[tokio::test]
async fn reconnect_mid_task_without_duplicates() {
    let (r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    let (_, t) = svc.start_task(&conn, "u", "slow").await;
    let id = t["taskId"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let desktop_id = d.bridge.snapshot().bridge.desktop_id.unwrap();
    assert!(r.state.kick_desktop(&desktop_id));
    let ev = svc.events(&id, None).await;
    let fin = terminal(&ev).expect("task finished after reconnect");
    assert_eq!(fin["kind"], "task.completed");
    assert_eq!(fin["payload"]["stopReason"], "end_turn");
    let text = text_of(&ev);
    for i in 0..60 {
        assert_eq!(text.matches(&format!("step {i}. ")).count(), 1, "step {i} missing or duplicated in {text}");
    }
    d.wait_connected().await;
    let n = d.bridge.snapshot().tasks.iter().filter(|t| t.source == "remote").count();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn desktop_offline_task_fails_fast() {
    let (r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    d.bridge.shutdown().await;
    let desktop_id = d.bridge.snapshot().bridge.desktop_id.unwrap();
    // Simulate the desktop app quitting: kick and prevent reconnect by
    // pointing the bridge at an unreachable relay.
    let mut s = d.bridge.settings();
    s.relay_url = "http://127.0.0.1:9".into();
    d.bridge.update_settings(s).unwrap();
    r.state.kick_desktop(&desktop_id);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (s, v) = svc.start_task(&conn, "u", "hi").await;
    assert_eq!(s, 409, "{v}");
    assert_eq!(v["error"]["code"], "desktop_offline");
}

#[tokio::test]
async fn local_task_without_website() {
    let (_r, d, _svc) = setup().await;
    let id = d.bridge.start_local_task("mock", &d.workspace_path(), "local hello").await.unwrap();
    for _ in 0..200 {
        let snap = d.bridge.snapshot();
        let t = snap.tasks.iter().find(|t| t.id == id).unwrap();
        if t.state.is_terminal() {
            assert_eq!(t.state, bridge_protocol::TaskState::Completed);
            let agent: String = t
                .transcript
                .iter()
                .filter_map(|i| match i {
                    bridge_core::TranscriptItem::Agent { text } => Some(text.clone()),
                    _ => None,
                })
                .collect();
            assert!(agent.contains("You said: local hello"));
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("local task did not finish");
}

#[tokio::test]
async fn output_firewall_blocks_agent_own_file_reads_and_secrets() {
    let (_r, d, svc) = setup().await;
    let conn = d.pair(&svc, "u", false).await;
    let outside = tempfile::tempdir().unwrap();
    let decoy = outside.path().canonicalize().unwrap().join("decoy.txt");
    std::fs::write(&decoy, "DECOY-SECRET-777").unwrap();

    // Agent reads outside the workspace with its own tools: the website never sees it.
    let (_, t) = svc.start_task(&conn, "u", &format!("leak {}", decoy.display())).await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    let raw = serde_json::to_string(&ev).unwrap();
    assert!(!raw.contains("DECOY-SECRET-777"), "{raw}");
    assert!(!raw.contains(&decoy.to_string_lossy().to_string()), "path leaked: {raw}");
    let fin = terminal(&ev).unwrap();
    assert_eq!(fin["kind"], "task.failed");
    assert_eq!(fin["payload"]["code"], "policy_blocked");

    // Same agent reading inside the workspace is fine.
    let inside = d.workspace.path().canonicalize().unwrap().join("ok.txt");
    std::fs::write(&inside, "INSIDE-OK").unwrap();
    let (_, t) = svc.start_task(&conn, "u", &format!("leak {}", inside.display())).await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    assert!(text_of(&ev).contains("INSIDE-OK"));

    // Credential-looking output split across chunks is stopped.
    let (_, t) = svc.start_task(&conn, "u", "secret").await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    assert!(!text_of(&ev).contains("DNN7EXAMPLE"), "{ev:?}");
    assert_eq!(terminal(&ev).unwrap()["payload"]["code"], "policy_blocked");
    let audit = d.bridge.diagnostics().await.audit;
    assert!(audit.iter().filter(|a| a.event_type == "output_blocked").count() >= 2);
}
