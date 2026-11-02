//! ACP client host: owns an agent subprocess and its JSON-RPC stdio channel.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Semaphore};

use crate::acp::{self, error_codes, methods, *};
use crate::framing::{read_frame, Frame};

/// How to launch an agent. Only constructed by trusted local code, never from
/// remote input.
#[derive(Debug, Clone)]
pub struct AgentCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Environment passed to the agent. The parent environment is **cleared**
    /// first; only these variables are visible to the agent.
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_line_bytes: usize,
    pub request_timeout: Duration,
    pub max_inflight_agent_requests: usize,
    pub event_channel_capacity: usize,
    pub max_stderr_lines: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_line_bytes: 16 * 1024 * 1024,
            request_timeout: Duration::from_secs(90),
            max_inflight_agent_requests: 32,
            event_channel_capacity: 1024,
            max_stderr_lines: 200,
        }
    }
}

#[derive(Debug, Clone, thiserror::Error, PartialEq)]
pub enum HostError {
    #[error("failed to start agent: {0}")]
    Spawn(String),
    #[error("agent exited")]
    AgentExited,
    #[error("timed out waiting for agent")]
    Timeout,
    #[error("agent returned error {code}: {message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("invalid response from agent: {0}")]
    InvalidResponse(String),
    #[error("unsupported ACP protocol version {0}")]
    UnsupportedProtocol(u64),
}

impl HostError {
    pub fn is_auth_required(&self) -> bool {
        matches!(self, HostError::Rpc { code, .. } if *code == error_codes::AUTH_REQUIRED)
    }
}

/// Error a client handler returns to the agent.
#[derive(Debug, Clone)]
pub struct ClientError {
    pub code: i64,
    pub message: String,
}

impl ClientError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(error_codes::INVALID_REQUEST, message)
    }
}

/// Callbacks for agent -> client requests. All of them run under the bridge's
/// local policy; the remote service never answers these directly.
#[async_trait]
pub trait ClientHandler: Send + Sync + 'static {
    async fn request_permission(&self, req: RequestPermissionRequest) -> PermissionDecision;
    async fn read_text_file(&self, req: ReadTextFileRequest) -> Result<String, ClientError>;
    async fn write_text_file(&self, req: WriteTextFileRequest) -> Result<(), ClientError>;
}

#[derive(Debug, Clone)]
pub enum HostEvent {
    Session(SessionNotification),
    /// A frame on stdout that was not valid JSON-RPC (diagnostics only).
    ProtocolNoise(String),
    Exited { code: Option<i32> },
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, HostError>>>>>;

struct Inner {
    out_tx: mpsc::Sender<String>,
    pending: Pending,
    next_id: AtomicU64,
    alive: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
    child: tokio::sync::Mutex<Option<Child>>,
    pid: Option<u32>,
    limits: Limits,
}

#[derive(Clone)]
pub struct AgentHost {
    inner: Arc<Inner>,
}

pub fn client_info() -> Implementation {
    Implementation {
        name: "remote-acp-bridge".into(),
        title: Some("Remote ACP Bridge".into()),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

impl AgentHost {
    /// Spawn the agent subprocess. Returns the host and its event stream.
    pub async fn spawn(
        cmd: AgentCommand,
        handler: Arc<dyn ClientHandler>,
        limits: Limits,
    ) -> Result<(Self, mpsc::Receiver<HostEvent>), HostError> {
        let mut command = Command::new(&cmd.program);
        command
            .args(&cmd.args)
            .current_dir(&cmd.cwd)
            .env_clear()
            .envs(cmd.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = command
            .spawn()
            .map_err(|e| HostError::Spawn(format!("{}: {e}", cmd.program.display())))?;
        let pid = child.id();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
        let (ev_tx, ev_rx) = mpsc::channel::<HostEvent>(limits.event_channel_capacity);

        let inner = Arc::new(Inner {
            out_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            stderr: Mutex::new(VecDeque::new()),
            child: tokio::sync::Mutex::new(Some(child)),
            pid,
            limits: limits.clone(),
        });

        // Writer task: serializes all outbound frames onto stdin.
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = out_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });

        // Stderr task: never mixed into the JSON-RPC stream; kept as a bounded tail.
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                let mut r = BufReader::new(stderr);
                while let Ok(Some(frame)) = read_frame(&mut r, 64 * 1024).await {
                    let line = match frame {
                        Frame::Line(s) => s,
                        Frame::TooLong(n) => format!("<{n} bytes omitted>"),
                        Frame::InvalidUtf8 => "<invalid utf-8>".into(),
                    };
                    let mut q = inner.stderr.lock().unwrap();
                    if q.len() >= inner.limits.max_stderr_lines {
                        q.pop_front();
                    }
                    q.push_back(line);
                }
            });
        }

        // Reader task.
        {
            let inner = inner.clone();
            let handler = handler.clone();
            let ev_tx = ev_tx.clone();
            tokio::spawn(async move {
                let sem = Arc::new(Semaphore::new(inner.limits.max_inflight_agent_requests));
                let mut r = BufReader::new(stdout);
                loop {
                    let frame = match read_frame(&mut r, inner.limits.max_line_bytes).await {
                        Ok(Some(f)) => f,
                        Ok(None) | Err(_) => break,
                    };
                    let line = match frame {
                        Frame::Line(l) => l,
                        Frame::TooLong(n) => {
                            let _ = ev_tx
                                .send(HostEvent::ProtocolNoise(format!("oversized frame ({n} bytes) dropped")))
                                .await;
                            continue;
                        }
                        Frame::InvalidUtf8 => {
                            let _ = ev_tx.send(HostEvent::ProtocolNoise("invalid utf-8 frame".into())).await;
                            continue;
                        }
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let msg: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => {
                            let preview: String = line.chars().take(120).collect();
                            let _ = ev_tx.send(HostEvent::ProtocolNoise(preview)).await;
                            continue;
                        }
                    };
                    Self::dispatch(&inner, &handler, &ev_tx, &sem, msg).await;
                }
                inner.alive.store(false, Ordering::SeqCst);
                // Fail every pending request.
                let drained: Vec<_> = inner.pending.lock().unwrap().drain().collect();
                for (_, tx) in drained {
                    let _ = tx.send(Err(HostError::AgentExited));
                }
                let code = {
                    let mut guard = inner.child.lock().await;
                    match guard.as_mut() {
                        Some(c) => match tokio::time::timeout(Duration::from_secs(2), c.wait()).await {
                            Ok(Ok(status)) => status.code(),
                            _ => None,
                        },
                        None => None,
                    }
                };
                let _ = ev_tx.send(HostEvent::Exited { code }).await;
            });
        }

        Ok((Self { inner }, ev_rx))
    }

    async fn dispatch(
        inner: &Arc<Inner>,
        handler: &Arc<dyn ClientHandler>,
        ev_tx: &mpsc::Sender<HostEvent>,
        sem: &Arc<Semaphore>,
        msg: Value,
    ) {
        if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            let _ = ev_tx.send(HostEvent::ProtocolNoise("missing jsonrpc 2.0".into())).await;
            return;
        }
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        let id = msg.get("id").cloned().filter(|v| !v.is_null());
        match (method, id) {
            // Response to one of our requests.
            (None, Some(id)) => {
                let Some(num) = id.as_u64() else {
                    let _ = ev_tx.send(HostEvent::ProtocolNoise("response with foreign id".into())).await;
                    return;
                };
                let tx = inner.pending.lock().unwrap().remove(&num);
                let Some(tx) = tx else {
                    // Unsolicited or duplicate reply: rejected.
                    let _ = ev_tx
                        .send(HostEvent::ProtocolNoise(format!("unsolicited response id {num}")))
                        .await;
                    return;
                };
                let result = if let Some(err) = msg.get("error") {
                    Err(HostError::Rpc {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(error_codes::INTERNAL_ERROR),
                        message: err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .chars()
                            .take(2000)
                            .collect(),
                        data: err.get("data").cloned(),
                    })
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(result);
            }
            // Notification from agent.
            (Some(method), None) => {
                if method == methods::SESSION_UPDATE {
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    match serde_json::from_value::<SessionNotification>(params) {
                        // Awaiting here applies backpressure to the agent's stdout.
                        Ok(n) => {
                            let _ = ev_tx.send(HostEvent::Session(n)).await;
                        }
                        Err(e) => {
                            let _ = ev_tx
                                .send(HostEvent::ProtocolNoise(format!("bad session/update: {e}")))
                                .await;
                        }
                    }
                }
                // Other notifications (e.g. extension methods) are ignored.
            }
            // Request from agent to client.
            (Some(method), Some(id)) => {
                let permit = match sem.clone().try_acquire_owned() {
                    Ok(p) => p,
                    Err(_) => {
                        Self::reply_error(inner, id, error_codes::INTERNAL_ERROR, "too many concurrent requests").await;
                        return;
                    }
                };
                let inner = inner.clone();
                let handler = handler.clone();
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                tokio::spawn(async move {
                    let _permit = permit;
                    let res = Self::handle_agent_request(&handler, &method, params).await;
                    match res {
                        Ok(v) => Self::reply_ok(&inner, id, v).await,
                        Err(e) => Self::reply_error(&inner, id, e.code, &e.message).await,
                    }
                });
            }
            (None, None) => {
                let _ = ev_tx.send(HostEvent::ProtocolNoise("invalid json-rpc message".into())).await;
            }
        }
    }

    async fn handle_agent_request(
        handler: &Arc<dyn ClientHandler>,
        method: &str,
        params: Value,
    ) -> Result<Value, ClientError> {
        fn parse<T: DeserializeOwned>(p: Value) -> Result<T, ClientError> {
            serde_json::from_value(p).map_err(|e| ClientError::new(error_codes::INVALID_PARAMS, e.to_string()))
        }
        match method {
            methods::SESSION_REQUEST_PERMISSION => {
                let raw_tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                let mut req: RequestPermissionRequest = parse(params)?;
                req.raw_tool_call = raw_tool_call;
                if req.options.is_empty() {
                    return Err(ClientError::new(error_codes::INVALID_PARAMS, "no permission options"));
                }
                let options = req.options.clone();
                let decision = handler.request_permission(req).await;
                // Never answer with an option id the agent did not offer.
                let decision = match decision {
                    PermissionDecision::Selected(id) if options.iter().any(|o| o.option_id == id) => {
                        PermissionDecision::Selected(id)
                    }
                    _ => PermissionDecision::Cancelled,
                };
                Ok(decision.to_json())
            }
            methods::FS_READ_TEXT_FILE => {
                let req: ReadTextFileRequest = parse(params)?;
                let content = handler.read_text_file(req).await?;
                Ok(json!({ "content": content }))
            }
            methods::FS_WRITE_TEXT_FILE => {
                let req: WriteTextFileRequest = parse(params)?;
                handler.write_text_file(req).await?;
                Ok(Value::Null)
            }
            // Terminal capability is not advertised; refuse anything else.
            _ => Err(ClientError::new(error_codes::METHOD_NOT_FOUND, format!("method not supported: {method}"))),
        }
    }

    async fn reply_ok(inner: &Arc<Inner>, id: Value, result: Value) {
        let msg = json!({"jsonrpc": "2.0", "id": id, "result": result});
        let _ = inner.out_tx.send(msg.to_string()).await;
    }

    async fn reply_error(inner: &Arc<Inner>, id: Value, code: i64, message: &str) {
        let msg = json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}});
        let _ = inner.out_tx.send(msg.to_string()).await;
    }

    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.inner.stderr.lock().unwrap().iter().cloned().collect()
    }

    /// Send a JSON-RPC request and await its response.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, HostError> {
        if !self.is_alive() {
            return Err(HostError::AgentExited);
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id, tx);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if self.inner.out_tx.send(msg.to_string()).await.is_err() {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(HostError::AgentExited);
        }
        let res = match timeout {
            Some(t) => match tokio::time::timeout(t, rx).await {
                Ok(r) => r,
                Err(_) => {
                    self.inner.pending.lock().unwrap().remove(&id);
                    return Err(HostError::Timeout);
                }
            },
            None => rx.await,
        };
        res.unwrap_or(Err(HostError::AgentExited))
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), HostError> {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        self.inner
            .out_tx
            .send(msg.to_string())
            .await
            .map_err(|_| HostError::AgentExited)
    }

    fn decode<T: DeserializeOwned>(v: Value) -> Result<T, HostError> {
        serde_json::from_value(v).map_err(|e| HostError::InvalidResponse(e.to_string()))
    }

    /// ACP `initialize` with version negotiation.
    pub async fn initialize(&self) -> Result<InitializeResponse, HostError> {
        let req = InitializeRequest {
            protocol_version: acp::ACP_PROTOCOL_VERSION,
            client_capabilities: ClientCapabilities {
                fs: FileSystemCapability {
                    read_text_file: true,
                    write_text_file: true,
                },
                terminal: false,
            },
            client_info: Some(client_info()),
        };
        let v = self
            .request(
                methods::INITIALIZE,
                serde_json::to_value(req).unwrap(),
                Some(self.inner.limits.request_timeout),
            )
            .await?;
        let resp: InitializeResponse = Self::decode(v)?;
        if resp.protocol_version != acp::ACP_PROTOCOL_VERSION {
            return Err(HostError::UnsupportedProtocol(resp.protocol_version));
        }
        Ok(resp)
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<(), HostError> {
        self.request(
            methods::AUTHENTICATE,
            json!({"methodId": method_id}),
            Some(Duration::from_secs(300)),
        )
        .await
        .map(|_| ())
    }

    pub async fn new_session(&self, cwd: &Path) -> Result<NewSessionResponse, HostError> {
        let v = self
            .request(
                methods::SESSION_NEW,
                json!({"cwd": cwd.to_string_lossy(), "mcpServers": []}),
                Some(self.inner.limits.request_timeout),
            )
            .await?;
        Self::decode(v)
    }

    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<(), HostError> {
        self.request(
            methods::SESSION_SET_MODE,
            json!({"sessionId": session_id, "modeId": mode_id}),
            Some(self.inner.limits.request_timeout),
        )
        .await
        .map(|_| ())
    }

    /// Run one prompt turn. Updates arrive on the event stream while this
    /// future is pending. Returns the ACP stop reason.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<String, HostError> {
        let v = self
            .request(
                methods::SESSION_PROMPT,
                json!({"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}),
                None,
            )
            .await?;
        let r: PromptResponse = Self::decode(v)?;
        Ok(r.stop_reason)
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), HostError> {
        self.notify(methods::SESSION_CANCEL, json!({"sessionId": session_id}))
            .await
    }

    /// Terminate the agent and its whole process tree.
    pub async fn shutdown(&self) {
        let mut guard = self.inner.child.lock().await;
        if let Some(child) = guard.as_mut() {
            #[cfg(unix)]
            if let Some(pid) = self.inner.pid {
                // SAFETY: plain syscall on a process group we created.
                unsafe {
                    libc::killpg(pid as i32, libc::SIGTERM);
                }
            }
            #[cfg(windows)]
            if let Some(pid) = self.inner.pid {
                let _ = std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                #[cfg(unix)]
                if let Some(pid) = self.inner.pid {
                    unsafe {
                        libc::killpg(pid as i32, libc::SIGKILL);
                    }
                }
                let _ = child.kill().await;
            }
        }
        *guard = None;
        self.inner.alive.store(false, Ordering::SeqCst);
    }
}
