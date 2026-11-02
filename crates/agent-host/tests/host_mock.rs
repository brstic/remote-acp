use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_host::acp::*;
use agent_host::*;
use async_trait::async_trait;
use tokio::sync::mpsc;

#[derive(Default)]
struct TestHandler {
    allow: bool,
    root: PathBuf,
    permission_requests: Mutex<Vec<String>>,
    writes: Mutex<Vec<String>>,
}

#[async_trait]
impl ClientHandler for TestHandler {
    async fn request_permission(&self, req: RequestPermissionRequest) -> PermissionDecision {
        self.permission_requests
            .lock()
            .unwrap()
            .push(req.tool_call.title.clone().unwrap_or_default());
        let kind = if self.allow { "allow_once" } else { "reject_once" };
        let opt = req.options.iter().find(|o| o.kind == kind).unwrap();
        PermissionDecision::Selected(opt.option_id.clone())
    }
    async fn read_text_file(&self, req: ReadTextFileRequest) -> Result<String, ClientError> {
        let p = Path::new(&req.path);
        let canon = p.canonicalize().map_err(|e| ClientError::denied(e.to_string()))?;
        if !canon.starts_with(self.root.canonicalize().unwrap()) {
            return Err(ClientError::denied("outside workspace"));
        }
        std::fs::read_to_string(canon).map_err(|e| ClientError::denied(e.to_string()))
    }
    async fn write_text_file(&self, req: WriteTextFileRequest) -> Result<(), ClientError> {
        self.writes.lock().unwrap().push(req.path.clone());
        std::fs::write(&req.path, req.content).map_err(|e| ClientError::denied(e.to_string()))
    }
}

fn mock_cmd(cwd: &Path, extra_env: &[(&str, &str)]) -> AgentCommand {
    let mut env = vec![];
    for (k, v) in extra_env {
        env.push((k.to_string(), v.to_string()));
    }
    AgentCommand {
        program: PathBuf::from(env!("CARGO_BIN_EXE_mock-acp-agent")),
        args: vec![],
        env,
        cwd: cwd.to_path_buf(),
    }
}

async fn start(
    handler: Arc<TestHandler>,
    dir: &Path,
) -> (AgentHost, mpsc::Receiver<HostEvent>, String) {
    let (host, rx) = AgentHost::spawn(mock_cmd(dir, &[]), handler, Limits::default())
        .await
        .unwrap();
    let init = host.initialize().await.unwrap();
    assert_eq!(init.protocol_version, 1);
    assert_eq!(init.agent_info.unwrap().name, "mock-acp-agent");
    let s = host.new_session(dir).await.unwrap();
    assert_eq!(s.modes.unwrap().current_mode_id, "ask");
    (host, rx, s.session_id)
}

fn collect_text(events: &[HostEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            HostEvent::Session(n) => match &n.update {
                SessionUpdate::AgentMessageChunk { content } => content.text().map(str::to_string),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

async fn drain(rx: &mut mpsc::Receiver<HostEvent>) -> Vec<HostEvent> {
    let mut v = vec![];
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
        v.push(e);
    }
    v
}

#[tokio::test]
async fn full_prompt_turn_streams_updates() {
    let dir = tempfile::tempdir().unwrap();
    let handler = Arc::new(TestHandler::default());
    let (host, mut rx, sid) = start(handler, dir.path()).await;
    let stop = host.prompt(&sid, "hi there").await.unwrap();
    assert_eq!(stop, "end_turn");
    let events = drain(&mut rx).await;
    assert_eq!(collect_text(&events), "Hello from the test agent. You said: hi there");
    assert!(events.iter().any(|e| matches!(e, HostEvent::Session(n) if matches!(n.update, SessionUpdate::Plan{..}))));
    assert!(host.stderr_tail().iter().any(|l| l.contains("started")));
    host.shutdown().await;
    assert!(!host.is_alive());
}

#[tokio::test]
async fn permission_allow_writes_file() {
    let dir = tempfile::tempdir().unwrap();
    let handler = Arc::new(TestHandler {
        allow: true,
        root: dir.path().to_path_buf(),
        ..Default::default()
    });
    let (host, mut rx, sid) = start(handler.clone(), dir.path()).await;
    assert_eq!(host.prompt(&sid, "please use permission").await.unwrap(), "end_turn");
    let text = collect_text(&drain(&mut rx).await);
    assert!(text.contains("PERMISSION_GRANTED"), "{text}");
    assert_eq!(handler.permission_requests.lock().unwrap().len(), 1);
    assert!(dir.path().join("mock-output.txt").exists());
    host.shutdown().await;
}

#[tokio::test]
async fn permission_deny_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let handler = Arc::new(TestHandler {
        allow: false,
        root: dir.path().to_path_buf(),
        ..Default::default()
    });
    let (host, mut rx, sid) = start(handler.clone(), dir.path()).await;
    assert_eq!(host.prompt(&sid, "permission").await.unwrap(), "end_turn");
    assert!(collect_text(&drain(&mut rx).await).contains("PERMISSION_DENIED"));
    assert!(handler.writes.lock().unwrap().is_empty());
    assert!(!dir.path().join("mock-output.txt").exists());
    host.shutdown().await;
}

#[tokio::test]
async fn read_outside_workspace_is_denied() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("inside.txt"), "abc").unwrap();
    let handler = Arc::new(TestHandler {
        root: dir.path().to_path_buf(),
        ..Default::default()
    });
    let (host, mut rx, sid) = start(handler, dir.path()).await;
    let inside = dir.path().join("inside.txt");
    host.prompt(&sid, &format!("read {}", inside.display())).await.unwrap();
    assert!(collect_text(&drain(&mut rx).await).contains("READ_OK 3 bytes"));
    host.prompt(&sid, "read /etc/hosts").await.unwrap();
    assert!(collect_text(&drain(&mut rx).await).contains("READ_DENIED"));
    host.shutdown().await;
}

#[tokio::test]
async fn cancel_mid_stream() {
    let dir = tempfile::tempdir().unwrap();
    let (host, mut rx, sid) = start(Arc::new(TestHandler::default()), dir.path()).await;
    let h2 = host.clone();
    let sid2 = sid.clone();
    let task = tokio::spawn(async move { h2.prompt(&sid2, "slow").await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    host.cancel(&sid).await.unwrap();
    let stop = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap();
    assert_eq!(stop, "cancelled");
    let text = collect_text(&drain(&mut rx).await);
    assert!(text.contains("step 0"));
    assert!(!text.contains("step 59"));
    host.shutdown().await;
}

#[tokio::test]
async fn crash_fails_pending_and_reports_exit() {
    let dir = tempfile::tempdir().unwrap();
    let (host, mut rx, sid) = start(Arc::new(TestHandler::default()), dir.path()).await;
    let err = host.prompt(&sid, "crash").await.unwrap_err();
    assert_eq!(err, HostError::AgentExited);
    let events = drain(&mut rx).await;
    assert!(events.iter().any(|e| matches!(e, HostEvent::Exited { code: Some(3) })), "{events:?}");
    assert!(!host.is_alive());
    assert_eq!(host.prompt(&sid, "again").await.unwrap_err(), HostError::AgentExited);
}

#[tokio::test]
async fn non_json_noise_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let (host, mut rx, sid) = start(Arc::new(TestHandler::default()), dir.path()).await;
    assert_eq!(host.prompt(&sid, "noise please").await.unwrap(), "end_turn");
    let events = drain(&mut rx).await;
    assert!(events.iter().any(|e| matches!(e, HostEvent::ProtocolNoise(s) if s.contains("not json-rpc"))));
    assert!(collect_text(&events).contains("You said: noise please"));
    host.shutdown().await;
}

#[tokio::test]
async fn flood_with_slow_consumer_backpressure() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits {
        event_channel_capacity: 8,
        ..Default::default()
    };
    let (host, mut rx) = AgentHost::spawn(mock_cmd(dir.path(), &[]), Arc::new(TestHandler::default()), limits)
        .await
        .unwrap();
    host.initialize().await.unwrap();
    let sid = host.new_session(dir.path()).await.unwrap().session_id;
    let h2 = host.clone();
    let t = tokio::spawn(async move { h2.prompt(&sid, "flood").await });
    let mut chunks = 0;
    loop {
        match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() {
            Some(HostEvent::Session(n)) => {
                if matches!(n.update, SessionUpdate::AgentMessageChunk { .. }) {
                    chunks += 1;
                    if chunks == 5000 {
                        break;
                    }
                }
            }
            Some(_) => {}
            None => break,
        }
    }
    assert_eq!(chunks, 5000);
    assert_eq!(t.await.unwrap().unwrap(), "end_turn");
    host.shutdown().await;
}

#[tokio::test]
async fn auth_required_then_authenticate() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _rx) = AgentHost::spawn(
        mock_cmd(dir.path(), &[("MOCK_REQUIRE_AUTH", "1")]),
        Arc::new(TestHandler::default()),
        Limits::default(),
    )
    .await
    .unwrap();
    let init = host.initialize().await.unwrap();
    assert_eq!(init.auth_methods[0].id, "mock-login");
    let err = host.new_session(dir.path()).await.unwrap_err();
    assert!(err.is_auth_required());
    host.authenticate("mock-login").await.unwrap();
    assert!(host.new_session(dir.path()).await.is_ok());
    host.shutdown().await;
}

#[tokio::test]
async fn spawn_missing_binary_errors() {
    let dir = tempfile::tempdir().unwrap();
    let cmd = AgentCommand {
        program: PathBuf::from("/nonexistent/agent-binary"),
        args: vec![],
        env: vec![],
        cwd: dir.path().to_path_buf(),
    };
    let r = AgentHost::spawn(cmd, Arc::new(TestHandler::default()), Limits::default()).await;
    assert!(matches!(r, Err(HostError::Spawn(_))));
}

#[tokio::test]
async fn request_timeout_and_unknown_method() {
    let dir = tempfile::tempdir().unwrap();
    let (host, _rx, _sid) = start(Arc::new(TestHandler::default()), dir.path()).await;
    let err = host
        .request("nonexistent/method", serde_json::json!({}), Some(Duration::from_secs(5)))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Rpc { code: -32601, .. }));
    host.shutdown().await;
}
