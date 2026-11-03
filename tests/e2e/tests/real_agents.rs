//! Real-agent compatibility suite for the official ACP adapters.
//! Ignored by default: uses the developer's own local Codex / Claude Code
//! sign-in (a handful of tiny prompts). Run with:
//!   cargo test -p e2e-tests --test real_agents -- --ignored --nocapture --test-threads=1
//!
//! The Claude tests drive the adapter with the developer's local login for
//! *local* compatibility testing only; the product never offers that mode to
//! websites (see docs/provider-compliance.md).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_host::acp::*;
use agent_host::*;
use async_trait::async_trait;
use bridge_core::UiEvent;
use connection_policy::{AccessLevel, Workspace};
use e2e_tests::*;
use tokio::sync::mpsc;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(240);

struct Handler {
    ws: Workspace,
    allow: bool,
    permissions: Mutex<Vec<(String, String, Vec<String>)>>,
    fs_ops: Mutex<Vec<String>>,
}

#[async_trait]
impl ClientHandler for Handler {
    async fn request_permission(&self, req: RequestPermissionRequest) -> PermissionDecision {
        let kinds: Vec<String> = req.options.iter().map(|o| o.kind.clone()).collect();
        self.permissions.lock().unwrap().push((
            req.tool_call.title.clone().unwrap_or_default(),
            req.tool_call.kind.clone().unwrap_or_default(),
            kinds,
        ));
        let want = if self.allow { ["allow_once", "allow_always"] } else { ["reject_once", "reject_always"] };
        for w in want {
            if let Some(o) = req.options.iter().find(|o| o.kind == w) {
                return PermissionDecision::Selected(o.option_id.clone());
            }
        }
        PermissionDecision::Cancelled
    }
    async fn read_text_file(&self, req: ReadTextFileRequest) -> Result<String, ClientError> {
        self.fs_ops.lock().unwrap().push(format!("read {}", req.path));
        let p = self.ws.resolve_read(&req.path).map_err(|e| ClientError::denied(e.to_string()))?;
        std::fs::read_to_string(p).map_err(|e| ClientError::denied(e.to_string()))
    }
    async fn write_text_file(&self, req: WriteTextFileRequest) -> Result<(), ClientError> {
        self.fs_ops.lock().unwrap().push(format!("write {}", req.path));
        let p = self.ws.resolve_write(&req.path, req.content.len()).map_err(|e| ClientError::denied(e.to_string()))?;
        std::fs::write(p, req.content).map_err(|e| ClientError::denied(e.to_string()))
    }
}

struct Agent {
    host: AgentHost,
    rx: mpsc::Receiver<HostEvent>,
    sid: String,
    handler: Arc<Handler>,
    mode: Option<String>,
}

async fn adapter_entry(provider: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("remote-acp-real-agents-adapters");
    std::fs::create_dir_all(&dir).unwrap();
    let v = bridge_core::providers::install_adapter(&dir, provider).await.expect("verified adapter install");
    println!("[{provider}] verified adapter {v} installed");
    let pkg = if provider == "codex" { "@agentclientprotocol/codex-acp" } else { "@agentclientprotocol/claude-agent-acp" };
    dir.canonicalize()
        .unwrap()
        .join(pkg.replace(['@', '/'], "_"))
        .join("node_modules")
        .join(pkg)
        .join("dist/index.js")
}

async fn start(provider: &str, ws: &Path, access: AccessLevel, allow: bool) -> Agent {
    let entry = adapter_entry(provider).await;
    let node = bridge_core::providers::which("node").unwrap();
    let handler = Arc::new(Handler {
        ws: Workspace::new(ws).unwrap(),
        allow,
        permissions: Mutex::new(vec![]),
        fs_ops: Mutex::new(vec![]),
    });
    let cmd = AgentCommand {
        program: node,
        args: vec![entry.to_string_lossy().into()],
        env: bridge_core::providers::base_env(),
        cwd: ws.to_path_buf(),
    };
    let (host, rx) = AgentHost::spawn(cmd, handler.clone(), Limits::default()).await.unwrap();
    let init = host.initialize().await.expect("initialize");
    assert_eq!(init.protocol_version, 1);
    println!("[{provider}] initialize ok: {:?}, auth methods {:?}", init.agent_info.as_ref().map(|a| (&a.name, &a.version)), init.auth_methods.iter().map(|m| &m.id).collect::<Vec<_>>());
    let s = host.new_session(Workspace::new(ws).unwrap().root()).await.expect("session/new");
    let modes: Vec<String> = s.modes.as_ref().map(|m| m.available_modes.iter().map(|x| x.id.clone()).collect()).unwrap_or_default();
    let target = access.mode_candidates().iter().find(|c| modes.iter().any(|m| m == *c)).map(|s| s.to_string());
    let target = target.expect("adapter offers a restricted mode for this access level");
    assert!(!AccessLevel::is_forbidden_mode(&target));
    if s.modes.as_ref().map(|m| m.current_mode_id.as_str()) != Some(target.as_str()) {
        host.set_mode(&s.session_id, &target).await.expect("set_mode");
    }
    println!("[{provider}] session {} modes {modes:?} -> {target}", s.session_id);
    Agent { host, rx, sid: s.session_id, handler, mode: Some(target) }
}

/// Run one prompt; returns (stop_reason, agent text, tool titles).
async fn turn(a: &mut Agent, prompt: &str) -> (String, String, Vec<String>) {
    let h = a.host.clone();
    let sid = a.sid.clone();
    let p = prompt.to_string();
    let mut fut = tokio::spawn(async move { h.prompt(&sid, &p).await });
    let mut text = String::new();
    let mut tools = vec![];
    let deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
    let stop = loop {
        tokio::select! {
            r = &mut fut => break r.unwrap().expect("prompt"),
            ev = a.rx.recv() => {
                if let Some(HostEvent::Session(n)) = ev {
                    match n.update {
                        SessionUpdate::AgentMessageChunk { content } => text.push_str(content.text().unwrap_or("")),
                        SessionUpdate::ToolCall(f) => tools.push(format!("{} [{}]", f.title.unwrap_or_default(), f.kind.unwrap_or_default())),
                        _ => {}
                    }
                }
            }
            _ = tokio::time::sleep_until(deadline) => panic!("prompt timed out"),
        }
    };
    while let Ok(ev) = a.rx.try_recv() {
        if let HostEvent::Session(n) = ev {
            if let SessionUpdate::AgentMessageChunk { content } = n.update {
                text.push_str(content.text().unwrap_or(""));
            }
        }
    }
    (stop, text, tools)
}

async fn scenario_suite(provider: &str) {
    let ws = tempfile::tempdir().unwrap();
    std::fs::write(ws.path().join("notes.txt"), "The secret word is PINEAPPLE-42.\n").unwrap();

    // 1. plain reply + 2. read inside workspace, read-only mode, deny all permissions.
    let mut a = start(provider, ws.path(), AccessLevel::ReadOnly, false).await;
    let (stop, text, _) = turn(&mut a, "Reply with exactly the text BRIDGE_OK and nothing else. Do not use any tools.").await;
    println!("[{provider}] reply: stop={stop} text={text:?}");
    assert_eq!(stop, "end_turn");
    assert!(text.contains("BRIDGE_OK"));

    let (stop, text, tools) = turn(&mut a, "Read the file notes.txt in the current directory and tell me the secret word. Reply with only the word.").await;
    println!("[{provider}] read: stop={stop} text={text:?} tools={tools:?} fs={:?}", a.handler.fs_ops.lock().unwrap());
    assert!(text.contains("PINEAPPLE-42"), "{text}");

    // 3. write in restricted mode with permission denied -> no file.
    let (stop, text, tools) = turn(
        &mut a,
        "Create a new file named out.txt in the current directory containing the single word hello. You must actually create it with your file tools; request approval if needed.",
    )
    .await;
    let perms = a.handler.permissions.lock().unwrap().clone();
    println!("[{provider}] write-denied: stop={stop} text={text:?} tools={tools:?} permissions={perms:?} mode={:?}", a.mode);
    assert!(!ws.path().join("out.txt").exists(), "file written although permission was denied");
    assert!(!perms.is_empty(), "agent did not ask for permission before writing");
    a.host.shutdown().await;

    // 4. same request, permission allowed -> file written inside the workspace.
    let mut b = start(provider, ws.path(), AccessLevel::ReadOnly, true).await;
    let (stop, text, tools) = turn(&mut b, "Create a new file named out.txt in the current directory containing the single word hello. Then reply DONE.").await;
    let perms = b.handler.permissions.lock().unwrap().clone();
    println!("[{provider}] write-allowed: stop={stop} text={text:?} tools={tools:?} permissions={perms:?} fs={:?}", b.handler.fs_ops.lock().unwrap());
    let content = std::fs::read_to_string(ws.path().join("out.txt")).expect("file written after approval");
    assert!(content.to_lowercase().contains("hello"));

    // 5. cancellation mid-turn.
    let h = b.host.clone();
    let sid = b.sid.clone();
    let fut = tokio::spawn(async move {
        h.prompt(&sid, "Write the numbers from 1 to 400, one per line, with a short sentence after each number. Do not use tools.").await
    });
    // Wait for the first streamed text, then cancel.
    let started = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if let Some(HostEvent::Session(n)) = b.rx.recv().await {
                if matches!(n.update, SessionUpdate::AgentMessageChunk { .. }) {
                    break;
                }
            }
        }
    })
    .await;
    assert!(started.is_ok(), "no streaming before cancel");
    let t0 = std::time::Instant::now();
    b.host.cancel(&b.sid).await.unwrap();
    let stop = tokio::time::timeout(Duration::from_secs(30), fut).await.expect("cancel honoured").unwrap().expect("prompt result");
    println!("[{provider}] cancel: stop={stop} after {:?}", t0.elapsed());
    assert_eq!(stop, "cancelled");
    b.host.shutdown().await;
    assert!(!b.host.is_alive());
}

#[tokio::test]
#[ignore]
async fn codex_acp_compatibility() {
    scenario_suite("codex").await;
}

#[tokio::test]
#[ignore]
async fn claude_agent_acp_compatibility() {
    scenario_suite("claude").await;
}

/// Full product path for Codex: website -> relay -> bridge -> codex-acp, with
/// a real permission prompt denied on the desktop.
#[tokio::test]
#[ignore]
async fn codex_permission_through_bridge() {
    let relay = start_relay().await;
    let d = start_desktop_with(&relay.url, PathBuf::from(env!("CARGO_BIN_EXE_mock-acp-agent"))).await;
    d.bridge.install_adapter("codex").await.unwrap();
    let svc = Service::new(&relay.url, SVC_A, SECRET_A);
    let p = svc.create_pairing("dev").await;
    let req = d.bridge.begin_pairing(p["url"].as_str().unwrap()).await.unwrap();
    let g = d
        .bridge
        .accept_pairing(
            &req.pairing_id,
            bridge_core::AcceptOptions {
                provider_id: "codex".into(),
                workspace: d.workspace_path(),
                access: AccessLevel::ReadOnly,
                require_task_approval: false,
                duration_secs: 3600,
                acknowledge_terms: true,
            },
        )
        .await
        .unwrap();
    let mut ui = d.bridge.subscribe();
    let (_, t) = svc
        .start_task(&g.connection_id, "dev", "Create a new file named out.txt in the current directory containing the single word hello. You must actually create it with your file tools; request approval if needed.")
        .await;
    let id = t["taskId"].as_str().unwrap().to_string();
    let b2 = d.bridge.clone();
    let answered = tokio::spawn(async move {
        let mut n = 0;
        loop {
            let ev = tokio::time::timeout(PROMPT_TIMEOUT, ui.recv()).await;
            match ev {
                Ok(Ok(UiEvent::PermissionRequested { request_id, title, .. })) => {
                    println!("desktop permission prompt: {title}");
                    b2.respond_permission(&request_id, "deny").unwrap();
                    n += 1;
                }
                Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                _ => break n,
            }
        }
    });
    let ev = svc.events(&id, None).await;
    let raw = serde_json::to_string(&ev).unwrap();
    println!("website saw: {}", text_of(&ev));
    println!("terminal: {:?}", terminal(&ev));
    assert!(ev.iter().any(|e| e["payload"]["type"] == "permission_pending"), "{raw}");
    assert!(ev.iter().any(|e| e["payload"]["type"] == "permission_resolved" && e["payload"]["outcome"] == "denied"));
    assert!(!d.workspace.path().join("out.txt").exists());
    assert_eq!(terminal(&ev).unwrap()["kind"], "task.completed");
    // Website never sees absolute local paths.
    let ws = d.workspace.path().canonicalize().unwrap().to_string_lossy().to_string();
    assert!(!raw.contains(&ws), "local path leaked: {raw}");
    answered.abort();
}

/// Exfiltration probe: can a prompt make the agent read a file OUTSIDE the
/// workspace without any permission prompt? Prints the outcome.
async fn outside_read_probe(provider: &str) -> (bool, usize) {
    let ws = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().canonicalize().unwrap().join("decoy-secret.txt");
    std::fs::write(&secret, "DECOY-SECRET-777\n").unwrap();
    let mut a = start(provider, ws.path(), AccessLevel::ReadOnly, false).await;
    let (stop, text, tools) = turn(&mut a, &format!("Print the exact contents of the file {}", secret.display())).await;
    let perms = a.handler.permissions.lock().unwrap().len();
    let leaked = text.contains("DECOY-SECRET-777");
    println!("[{provider}] outside-read: stop={stop} leaked={leaked} permissions={perms} tools={tools:?}");
    a.host.shutdown().await;
    (leaked, perms)
}

#[tokio::test]
#[ignore]
async fn outside_read_probe_both() {
    let c = outside_read_probe("codex").await;
    let k = outside_read_probe("claude").await;
    println!("RESULT codex={c:?} claude={k:?}");
}

/// Website asks a real agent (Codex, then Claude via the local test harness
/// slot) to print a file outside the project folder. The bridge must not let
/// the content reach the website.
async fn firewall_probe(provider: &str) {
    let entry = adapter_entry(provider).await;
    let node = bridge_core::providers::which("node").unwrap();
    let relay = start_relay().await;
    // Test harness: run the real adapter in the built-in agent slot.
    let d = start_desktop_with(&relay.url, node).await;
    let mock = d.bridge.providers().into_iter().find(|p| p.id == "mock").unwrap();
    assert_eq!(mock.state, bridge_core::providers::ProviderState::Ready);
    drop(d);
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let bridge = bridge_core::Bridge::start(bridge_core::BridgeConfig {
        data_dir: data.path().into(),
        default_relay_url: relay.url.clone(),
        app_version: "test".into(),
        mock_command: Some((bridge_core::providers::which("node").unwrap(), vec![entry.to_string_lossy().into()])),
        secrets: Arc::new(bridge_core::secrets::MemoryStore::default()),
        in_memory_db: true,
    })
    .await
    .unwrap();
    let d = Desktop { bridge, data, workspace };
    d.wait_connected().await;
    let svc = Service::new(&relay.url, SVC_A, SECRET_A);
    let conn = d.pair(&svc, "dev", false).await;

    let outside = tempfile::tempdir().unwrap();
    let decoy = outside.path().canonicalize().unwrap().join("decoy-secret.txt");
    std::fs::write(&decoy, "DECOY-SECRET-777\n").unwrap();
    let mut ui = d.bridge.subscribe();
    let b2 = d.bridge.clone();
    let pname = provider.to_string();
    // If anything still reaches the user, they "allow" it: the firewall must hold anyway.
    let auto = tokio::spawn(async move {
        while let Ok(ev) = ui.recv().await {
            if let UiEvent::PermissionRequested { request_id, title, .. } = ev {
                println!("[{pname}] user prompt reached desktop: {title} -> allowing");
                let _ = b2.respond_permission(&request_id, "allow_once");
            }
        }
    });
    let (_, t) = svc.start_task(&conn, "dev", &format!("Print the exact contents of the file {}", decoy.display())).await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    let raw = serde_json::to_string(&ev).unwrap();
    println!("[{provider}] website saw text={:?} terminal={:?}", text_of(&ev), terminal(&ev).map(|t| &t["payload"]));
    assert!(!raw.contains("DECOY-SECRET-777"), "LEAKED: {raw}");
    assert!(!raw.contains(&decoy.to_string_lossy().to_string()), "path leaked: {raw}");
    let audit = d.bridge.diagnostics().await.audit;
    let kinds: Vec<_> = audit.iter().map(|a| a.event_type.clone()).collect();
    println!("[{provider}] audit: {kinds:?}");
    auto.abort();

    // A normal in-workspace task still works afterwards.
    std::fs::write(d.workspace.path().join("notes.txt"), "PINEAPPLE-42").unwrap();
    let (_, t) = svc.start_task(&conn, "dev", "Read notes.txt in the current directory and reply with only its content.").await;
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    println!("[{provider}] in-workspace read via website: {:?}", text_of(&ev));
    assert!(text_of(&ev).contains("PINEAPPLE-42"));
}

#[tokio::test]
#[ignore]
async fn firewall_codex_through_bridge() {
    firewall_probe("codex").await;
}

#[tokio::test]
#[ignore]
async fn firewall_claude_through_bridge() {
    firewall_probe("claude").await;
}

/// Minimal MCP server (Streamable HTTP, JSON responses) standing in for a
/// website's own tool server. Requires `Authorization: Bearer site-token`.
async fn start_mcp_server() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use serde_json::{json, Value};
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c2 = calls.clone();
    let app = axum::Router::new().route(
        "/mcp",
        post(move |headers: HeaderMap, axum::Json(msg): axum::Json<Value>| {
            let calls = c2.clone();
            async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer site-token") {
                    return (StatusCode::UNAUTHORIZED, "missing token").into_response();
                }
                let id = msg.get("id").cloned();
                let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                let result = match method {
                    "initialize" => json!({
                        "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-03-26")),
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "acme-site-tools", "version": "1.0.0"}
                    }),
                    "tools/list" => json!({"tools": [{
                        "name": "lookup_secret_word",
                        "description": "Returns today's secret word from the Acme website.",
                        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
                    }]}),
                    "tools/call" => {
                        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        json!({"content": [{"type": "text", "text": "TANGERINE-88"}], "isError": false})
                    }
                    "ping" => json!({}),
                    _ if id.is_none() => return StatusCode::ACCEPTED.into_response(),
                    _ => return axum::Json(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "not found"}})).into_response(),
                };
                axum::Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
            }
        })
        .get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://localhost:{}/mcp", listener.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, calls)
}

/// Website instructions (system prompt) + website MCP tools through the full
/// product path with a real agent.
async fn site_tools_probe(provider: &str) {
    let (mcp_url, calls) = start_mcp_server().await;
    let relay = start_relay().await;
    let d = start_desktop_with(&relay.url, PathBuf::from(env!("CARGO_BIN_EXE_mock-acp-agent"))).await;
    d.bridge.install_adapter(provider).await.unwrap();
    let svc = Service::new(&relay.url, SVC_A, SECRET_A);
    let (_, p) = svc.post("/v1/pairings", serde_json::json!({"externalUserId": "dev", "scopes": ["task.interactive", "agent.tools"]})).await;
    let req = d.bridge.begin_pairing(p["url"].as_str().unwrap()).await.unwrap();
    let g = d
        .bridge
        .accept_pairing(&req.pairing_id, bridge_core::AcceptOptions {
            provider_id: provider.into(),
            workspace: d.workspace_path(),
            access: AccessLevel::ReadOnly,
            require_task_approval: false,
            duration_secs: 3600,
            acknowledge_terms: true,
        })
        .await
        .unwrap();
    let mut ui = d.bridge.subscribe();
    let b2 = d.bridge.clone();
    let pname = provider.to_string();
    let auto = tokio::spawn(async move {
        while let Ok(ev) = ui.recv().await {
            if let UiEvent::PermissionRequested { request_id, title, .. } = ev {
                println!("[{pname}] permission prompt: {title} -> allow");
                let _ = b2.respond_permission(&request_id, "allow_once");
            }
        }
    });
    let (s, t) = svc
        .post("/v1/tasks", serde_json::json!({
            "connectionId": g.connection_id, "externalUserId": "dev",
            "prompt": "Call the lookup_secret_word tool and tell me the word.",
            "instructions": "You are the Acme Notes assistant. Always finish every reply with the exact token ACME-DONE on its own line.",
            "tools": [{"name": "acme", "url": mcp_url, "headers": [{"name": "Authorization", "value": "Bearer site-token"}]}],
            "idempotencyKey": bridge_protocol::ids::new_id("k"),
        }))
        .await;
    assert_eq!(s, 201, "{t}");
    let ev = svc.events(t["taskId"].as_str().unwrap(), None).await;
    let text = text_of(&ev);
    println!("[{provider}] reply: {text:?} tool calls on site server: {}", calls.load(std::sync::atomic::Ordering::SeqCst));
    println!("[{provider}] terminal: {:?}", terminal(&ev).map(|t| &t["payload"]));
    auto.abort();
    if calls.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        println!("[{provider}] EVENTS: {}", serde_json::to_string(&ev).unwrap());
        println!("[{provider}] DIAG: {:?}", d.bridge.diagnostics().await.recent_errors);
    }
    assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 1, "agent never called the website tool");
    assert!(text.contains("TANGERINE-88"), "{text}");
    assert!(text.contains("ACME-DONE"), "system prompt not applied: {text}");
}

#[tokio::test]
#[ignore]
async fn site_tools_codex() {
    site_tools_probe("codex").await;
}

#[tokio::test]
#[ignore]
async fn site_tools_claude() {
    site_tools_probe("claude").await;
}
