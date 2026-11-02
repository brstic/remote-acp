//! Deterministic mock ACP v1 agent used for tests and the built-in
//! "Test agent" provider. It speaks real ACP over stdio.
//!
//! Prompt keywords select a scenario:
//! - default: streams an echo reply in chunks with a plan update
//! - `permission`: asks for permission, then writes `mock-output.txt` via `fs/write_text_file`
//! - `read <path>`: reads a file through `fs/read_text_file` and reports the result
//! - `slow`: streams 60 chunks 50 ms apart (cancellable)
//! - `crash`: exits mid-stream
//! - `noise`: prints a non-JSON line on stdout first
//! - `flood`: streams 5000 chunks as fast as possible
//!
//! Env `MOCK_REQUIRE_AUTH=1` makes `session/new` fail with auth_required until
//! `authenticate` is called.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

struct State {
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    cancelled: Mutex<HashMap<String, Arc<AtomicBool>>>,
    authenticated: AtomicBool,
    sessions: AtomicU64,
}

impl State {
    fn send(&self, v: Value) {
        let _ = self.out.send(v.to_string());
    }

    fn update(&self, session: &str, update: Value) {
        self.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}}));
    }

    fn chunk(&self, session: &str, text: &str) {
        self.update(
            session,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        );
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1000;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        rx.await.unwrap_or(Value::Null)
    }
}

pub async fn run() {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.write_all(b"\n").await;
            let _ = stdout.flush().await;
        }
    });
    let state = Arc::new(State {
        out: out_tx,
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
        cancelled: Mutex::new(HashMap::new()),
        authenticated: AtomicBool::new(std::env::var("MOCK_REQUIRE_AUTH").ok().as_deref() != Some("1")),
        sessions: AtomicU64::new(0),
    });
    eprintln!("mock-acp-agent: started");
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (None, Some(id)) => {
                if let Some(n) = id.as_u64() {
                    if let Some(tx) = state.pending.lock().unwrap().remove(&n) {
                        let v = msg.get("result").cloned().unwrap_or_else(|| json!({"error": msg.get("error")}));
                        let _ = tx.send(v);
                    }
                }
            }
            (Some(m), None) if m == "session/cancel" => {
                if let Some(s) = params.get("sessionId").and_then(Value::as_str) {
                    if let Some(flag) = state.cancelled.lock().unwrap().get(s) {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            }
            (Some(_), None) => {}
            (Some(m), Some(id)) => {
                let state = state.clone();
                tokio::spawn(async move {
                    let reply = handle(&state, &m, params).await;
                    let msg = match reply {
                        Ok(r) => json!({"jsonrpc":"2.0","id":id,"result":r}),
                        Err((code, message)) => {
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
                        }
                    };
                    state.send(msg);
                });
            }
            (None, None) => {}
        }
    }
}

async fn handle(state: &Arc<State>, method: &str, params: Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let auth = if state.authenticated.load(Ordering::SeqCst) {
                json!([])
            } else {
                json!([{"id":"mock-login","name":"Mock login","description":"Test-only auth"}])
            };
            Ok(json!({
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": false, "promptCapabilities": {"image": false, "audio": false, "embeddedContext": false}},
                "authMethods": auth,
                "agentInfo": {"name": "mock-acp-agent", "title": "Test agent", "version": "1.0.0"}
            }))
        }
        "authenticate" => {
            if params.get("methodId").and_then(Value::as_str) == Some("mock-login") {
                state.authenticated.store(true, Ordering::SeqCst);
                Ok(json!({}))
            } else {
                Err((-32602, "unknown auth method".into()))
            }
        }
        "session/new" => {
            if !state.authenticated.load(Ordering::SeqCst) {
                return Err((-32000, "Authentication required".into()));
            }
            let n = state.sessions.fetch_add(1, Ordering::SeqCst) + 1;
            let sid = format!("mock-session-{n}");
            state
                .cancelled
                .lock()
                .unwrap()
                .insert(sid.clone(), Arc::new(AtomicBool::new(false)));
            Ok(json!({
                "sessionId": sid,
                "modes": {"currentModeId": "ask", "availableModes": [
                    {"id": "ask", "name": "Ask before changes"},
                    {"id": "edit", "name": "Edit files"}
                ]}
            }))
        }
        "session/set_mode" => Ok(json!({})),
        "session/prompt" => {
            let sid = params
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or((-32602, "sessionId".to_string()))?
                .to_string();
            let flag = state
                .cancelled
                .lock()
                .unwrap()
                .get(&sid)
                .cloned()
                .ok_or((-32002, "unknown session".to_string()))?;
            flag.store(false, Ordering::SeqCst);
            let text: String = params
                .get("prompt")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            prompt(state, &sid, &text, &flag).await
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    }
}

async fn prompt(
    state: &Arc<State>,
    sid: &str,
    text: &str,
    cancelled: &AtomicBool,
) -> Result<Value, (i64, String)> {
    let lower = text.to_lowercase();
    let done = |reason: &str| Ok(json!({"stopReason": reason}));

    if lower.contains("noise") {
        let _ = state.out.send("this is not json-rpc".into());
    }
    state.update(
        sid,
        json!({"sessionUpdate":"plan","entries":[
            {"content":"Understand the request","priority":"high","status":"completed"},
            {"content":"Respond","priority":"medium","status":"in_progress"}
        ]}),
    );

    if lower.contains("crash") {
        state.chunk(sid, "About to crash...");
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::process::exit(3);
    }

    if lower.contains("flood") {
        for i in 0..5000 {
            state.chunk(sid, &format!("{i} "));
        }
        return done("end_turn");
    }

    if lower.contains("slow") {
        for i in 0..60 {
            if cancelled.load(Ordering::SeqCst) {
                return done("cancelled");
            }
            state.chunk(sid, &format!("step {i}. "));
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        return done("end_turn");
    }

    // Simulates an agent with its own file tools (like real adapters): it
    // announces the tool call and then streams the file directly.
    if lower.starts_with("leak ") {
        let path = text.get(5..).unwrap_or("").trim().to_string();
        state.update(sid, json!({"sessionUpdate":"tool_call","toolCallId":"leak-1","title":format!("Read file '{path}'"),"kind":"read","status":"in_progress","locations":[{"path":path}]}));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        state.chunk(sid, &format!("Contents: {content}"));
        return done("end_turn");
    }
    if lower.contains("secret") {
        state.chunk(sid, "Here you go: ");
        state.chunk(sid, "AKIAIOSFO");
        state.chunk(sid, "DNN7EXAMPLE and more text");
        return done("end_turn");
    }

    if lower.starts_with("read ") {
        let path = text.get(5..).unwrap_or("").trim().to_string();
        state.update(sid, json!({"sessionUpdate":"tool_call","toolCallId":"read-1","title":format!("Read {path}"),"kind":"read","status":"in_progress"}));
        let res = state
            .call("fs/read_text_file", json!({"sessionId": sid, "path": path}))
            .await;
        if let Some(content) = res.get("content").and_then(Value::as_str) {
            state.update(sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"completed"}));
            state.chunk(sid, &format!("READ_OK {} bytes", content.len()));
        } else {
            state.update(sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"failed"}));
            state.chunk(sid, "READ_DENIED");
        }
        return done("end_turn");
    }

    if lower.contains("permission") {
        state.update(sid, json!({"sessionUpdate":"tool_call","toolCallId":"edit-1","title":"Write mock-output.txt","kind":"edit","status":"pending"}));
        let res = state
            .call(
                "session/request_permission",
                json!({
                    "sessionId": sid,
                    "toolCall": {"toolCallId":"edit-1","title":"Write mock-output.txt","kind":"edit","status":"pending",
                                  "rawInput": {"path": "mock-output.txt"}},
                    "options": [
                        {"optionId":"allow","name":"Allow once","kind":"allow_once"},
                        {"optionId":"reject","name":"Deny","kind":"reject_once"}
                    ]
                }),
            )
            .await;
        let outcome = res.pointer("/outcome/outcome").and_then(Value::as_str).unwrap_or("");
        let option = res.pointer("/outcome/optionId").and_then(Value::as_str).unwrap_or("");
        if cancelled.load(Ordering::SeqCst) || outcome == "cancelled" {
            state.update(sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"edit-1","status":"failed"}));
            return done("cancelled");
        }
        if option == "allow" {
            let cwd = std::env::current_dir().unwrap_or_default();
            let path = cwd.join("mock-output.txt");
            let w = state
                .call(
                    "fs/write_text_file",
                    json!({"sessionId": sid, "path": path.to_string_lossy(), "content": "written by mock agent\n"}),
                )
                .await;
            if w.get("error").is_some() {
                state.update(sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"edit-1","status":"failed"}));
                state.chunk(sid, "WRITE_FAILED");
            } else {
                state.update(sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"edit-1","status":"completed"}));
                state.chunk(sid, "PERMISSION_GRANTED file written.");
            }
        } else {
            state.update(sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"edit-1","status":"failed"}));
            state.chunk(sid, "PERMISSION_DENIED nothing was changed.");
        }
        return done("end_turn");
    }

    let reply = format!("Hello from the test agent. You said: {text}");
    for word in reply.split_inclusive(' ') {
        if cancelled.load(Ordering::SeqCst) {
            return done("cancelled");
        }
        state.chunk(sid, word);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    state.update(
        sid,
        json!({"sessionUpdate":"plan","entries":[
            {"content":"Understand the request","priority":"high","status":"completed"},
            {"content":"Respond","priority":"medium","status":"completed"}
        ]}),
    );
    done("end_turn")
}
