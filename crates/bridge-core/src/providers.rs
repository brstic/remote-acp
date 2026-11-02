//! Provider registry: detection, verified adapter installation, official
//! sign-in launch, policy gating and launch commands.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use agent_host::AgentCommand;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::secrets::SecretStore;

/// Pinned, tested adapter versions and their npm registry integrity.
pub struct AdapterPin {
    pub package: &'static str,
    pub version: &'static str,
    pub integrity: &'static str,
    pub entry: &'static str,
}

pub const CODEX_ADAPTER: AdapterPin = AdapterPin {
    package: "@agentclientprotocol/codex-acp",
    version: "2.5.0",
    integrity: "sha512-7e/4OhJwpvSTqsjiokoVYRV7O1XGem1CAsQgO1opmGYbRD5LvmydwDlJrldzQYO5TcPWueGzQ2Jdvyvp6l3qDw==",
    entry: "dist/index.js",
};

pub const CLAUDE_ADAPTER: AdapterPin = AdapterPin {
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.100.0",
    integrity: "sha512-X+f2M5RiehzSzWRJjDSf0Sbzoc8JK66l85YnYW5TAdHJX53CLQV00v2M72bfCKJ4IZ11qt+WQ/Yg9NVKcuDAhQ==",
    entry: "dist/index.js",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderState {
    NotInstalled,
    Installed,
    SignedOut,
    Ready,
    Broken,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    None,
    Subscription,
    ApiKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemotePolicy {
    Allowed,
    /// Allowed, but the user must acknowledge provider terms/plan limits.
    AllowedWithNotice,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub remote: RemotePolicy,
    pub note: String,
}

/// Provider policy / compatibility registry. A mode can be disabled here
/// without touching the rest of the product.
pub fn policy_for(provider: &str, mode: AuthMode) -> PolicyDecision {
    use RemotePolicy::*;
    let (remote, note) = match (provider, mode) {
        ("mock", _) => (Allowed, "Built-in test agent. No AI provider is used."),
        ("codex", AuthMode::ApiKey) => (Allowed, "Uses your OpenAI API key. API usage is billed to your OpenAI account."),
        ("codex", AuthMode::Subscription) => (
            Allowed,
            "Uses your ChatGPT plan's Codex usage limits. Website tasks count toward your plan. Make sure your use complies with OpenAI's terms for your plan.",
        ),
        ("claude", _) => (
            Allowed,
            "Uses your own Claude Code sign-in through the official Claude Code ACP adapter. Tasks count toward your Claude plan's usage limits. Make sure your use follows Anthropic's terms for your plan.",
        ),
        (p, _) if p.starts_with("custom:") => (
            AllowedWithNotice,
            "Custom ACP agent. It is not verified by Remote ACP Bridge; check its provider's terms before using it with websites.",
        ),
        _ => (Blocked, "Unknown provider configuration."),
    };
    PolicyDecision {
        remote,
        note: note.into(),
    }
}

/// Custom agents that wrap a known provider inherit that provider's notice.
pub fn custom_policy(c: &CustomAgent) -> PolicyDecision {
    let sig = format!("{} {}", c.program.display(), c.args.join(" ")).to_lowercase();
    if sig.contains("claude") || sig.contains("anthropic") {
        return policy_for("claude", AuthMode::Subscription);
    }
    if sig.contains("codex") {
        return policy_for("codex", AuthMode::Subscription);
    }
    policy_for(&c.id, AuthMode::None)
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    #[test]
    fn provider_policies() {
        let mk = |p: &str, a: &str| CustomAgent { id: "custom:x".into(), name: "x".into(), program: p.into(), args: vec![a.into()], sha256: String::new() };
        assert_eq!(custom_policy(&mk("/usr/local/bin/node", "/x/claude-agent-acp/dist/index.js")).note, policy_for("claude", AuthMode::Subscription).note);
        assert_eq!(custom_policy(&mk("/opt/bin/my-agent", "--acp")).remote, RemotePolicy::AllowedWithNotice);
        assert_eq!(policy_for("claude", AuthMode::Subscription).remote, RemotePolicy::Allowed);
        assert_eq!(policy_for("codex", AuthMode::Subscription).remote, RemotePolicy::Allowed);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub state: ProviderState,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    pub adapter_version: Option<String>,
    pub adapter_pinned: Option<String>,
    pub auth_mode: AuthMode,
    pub auth_label: Option<String>,
    pub policy: PolicyDecision,
    pub status_message: String,
    pub actions: Vec<String>,
    pub verified: bool,
}

/// The PATH a login shell would see. GUI apps on macOS start with a minimal
/// PATH, so agents installed via Homebrew/npm would not be found otherwise.
pub fn user_path() -> String {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
        let mut parts: Vec<String> = Vec::new();
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            if let Ok(out) = std::process::Command::new(&shell)
                .args(["-ilc", "printf '__P__%s__P__' \"$PATH\""])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Some(p) = s.split("__P__").nth(1) {
                    parts.extend(p.split(':').map(str::to_string));
                }
            }
        }
        if let Ok(p) = std::env::var("PATH") {
            parts.extend(std::env::split_paths(&p).map(|x| x.to_string_lossy().to_string()));
        }
        if let Some(home) = dirs::home_dir() {
            for d in [".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".cargo/bin"] {
                parts.push(home.join(d).to_string_lossy().to_string());
            }
        }
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            parts.push(d.into());
        }
        let mut seen = std::collections::HashSet::new();
        parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
        std::env::join_paths(parts).map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
    })
    .clone()
}

pub fn which(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        vec![".exe".into(), ".cmd".into(), ".bat".into(), "".into()]
    } else {
        vec!["".into()]
    };
    for dir in std::env::split_paths(&user_path()) {
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Minimal, controlled environment for agent subprocesses.
pub fn base_env() -> Vec<(String, String)> {
    let mut env = vec![("PATH".to_string(), user_path())];
    for k in [
        "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SystemRoot", "SYSTEMROOT",
        "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ProgramData", "ProgramFiles", "TEMP", "TMP",
        "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
        "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    ] {
        if let Ok(v) = std::env::var(k) {
            env.push((k.to_string(), v));
        }
    }
    if !env.iter().any(|(k, _)| k == "HOME") {
        if let Some(h) = dirs::home_dir() {
            env.push(("HOME".into(), h.to_string_lossy().to_string()));
        }
    }
    env
}

async fn run_capture(program: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(base_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(timeout, cmd.output()).await.ok()?.ok()?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), s.trim().to_string()))
}

pub fn sha256_file(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    Some(hex::encode(Sha256::digest(&bytes)))
}

pub struct ProviderEnv<'a> {
    pub adapters_dir: PathBuf,
    pub mock_command: Option<(PathBuf, Vec<String>)>,
    pub secrets: &'a dyn SecretStore,
    pub custom_agents: Vec<CustomAgent>,
    pub codex_mode: AuthMode,
}

fn adapter_dir(base: &Path, pin: &AdapterPin) -> PathBuf {
    base.join(pin.package.replace(['@', '/'], "_"))
}

fn adapter_entry(base: &Path, pin: &AdapterPin) -> PathBuf {
    adapter_dir(base, pin).join("node_modules").join(pin.package).join(pin.entry)
}

fn installed_adapter_version(base: &Path, pin: &AdapterPin) -> Option<String> {
    let pkg = adapter_dir(base, pin).join("node_modules").join(pin.package).join("package.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(pkg).ok()?).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

/// Verify an installed adapter against the pin and the entry hash recorded
/// at install time. Returns an error message when it must not be launched.
fn verify_adapter(base: &Path, pin: &AdapterPin) -> Result<PathBuf, String> {
    let entry = adapter_entry(base, pin);
    if !entry.is_file() {
        return Err("Adapter is not installed".into());
    }
    if installed_adapter_version(base, pin).as_deref() != Some(pin.version) {
        return Err(format!("Adapter version differs from the tested {}; reinstall it", pin.version));
    }
    let recorded = std::fs::read_to_string(adapter_dir(base, pin).join(".entry.sha256")).unwrap_or_default();
    if sha256_file(&entry).as_deref() != Some(recorded.trim()) {
        return Err("Adapter files changed on disk since installation; reinstall it".into());
    }
    Ok(entry)
}

async fn node_ok() -> Result<PathBuf, String> {
    let node = which("node").ok_or("Node.js 22 or newer is required to run this adapter")?;
    let (ok, v) = run_capture(&node, &["--version"], Duration::from_secs(10))
        .await
        .ok_or("Could not run Node.js")?;
    let major: u32 = v.trim_start_matches('v').split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
    if !ok || major < 22 {
        return Err(format!("Node.js 22 or newer is required (found {v})"));
    }
    Ok(node)
}

/// Install a pinned adapter with npm and verify the registry integrity
/// recorded in the lockfile matches our pin before it can ever be launched.
pub async fn install_adapter(adapters_dir: &Path, provider: &str) -> Result<String, String> {
    let pin = match provider {
        "codex" => &CODEX_ADAPTER,
        "claude" => &CLAUDE_ADAPTER,
        _ => return Err("This provider has no installable adapter".into()),
    };
    node_ok().await?;
    let npm = which("npm").ok_or("npm was not found. Install Node.js from nodejs.org first.")?;
    let dir = adapter_dir(adapters_dir, pin);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // npm resolves symlinks (e.g. macOS /var -> /private/var); give it the canonical path.
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    std::fs::write(dir.join("package.json"), r#"{"name":"remote-acp-adapter","private":true}"#).map_err(|e| e.to_string())?;
    let spec = format!("{}@{}", pin.package, pin.version);
    let dir_s = dir.to_string_lossy().to_string();
    let (ok, out) = run_capture(
        &npm,
        &["install", "--prefix", &dir_s, "--no-audit", "--no-fund", "--save-exact", &spec],
        Duration::from_secs(600),
    )
    .await
    .ok_or("npm install timed out")?;
    if !ok {
        let tail: String = out.lines().rev().take(6).collect::<Vec<_>>().join("\n");
        return Err(format!("npm install failed:\n{tail}"));
    }
    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("package-lock.json")).map_err(|_| "lockfile missing".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let key = format!("node_modules/{}", pin.package);
    let integrity = lock["packages"]
        .as_object()
        .and_then(|m| m.iter().find(|(k, _)| *k == &key || k.ends_with(&format!("/{key}"))))
        .and_then(|(_, v)| v["integrity"].as_str());
    if integrity != Some(pin.integrity) {
        let _ = std::fs::remove_dir_all(&dir);
        tracing::warn!(?integrity, lockfile_version = ?lock.get("lockfileVersion"), "adapter integrity mismatch");
        return Err(format!(
            "Downloaded adapter does not match the verified package; installation aborted (got {})",
            integrity.unwrap_or("nothing")
        ));
    }
    let entry = adapter_entry(adapters_dir, pin);
    let hash = sha256_file(&entry).ok_or("adapter entry missing after install")?;
    std::fs::write(dir.join(".entry.sha256"), hash).map_err(|e| e.to_string())?;
    Ok(pin.version.to_string())
}

async fn codex_status() -> (Option<PathBuf>, Option<String>, Option<(bool, String)>) {
    let Some(cli) = which("codex") else { return (None, None, None) };
    let version = run_capture(&cli, &["--version"], Duration::from_secs(10)).await.map(|(_, v)| v);
    let login = run_capture(&cli, &["login", "status"], Duration::from_secs(15)).await;
    (Some(cli), version, login)
}

pub async fn detect(env: &ProviderEnv<'_>) -> Vec<ProviderView> {
    let mut out = Vec::new();

    if env.mock_command.is_some() {
        out.push(ProviderView {
            id: "mock".into(),
            name: "Test agent".into(),
            description: "Built-in agent for trying the bridge. Does not use AI.".into(),
            state: ProviderState::Ready,
            cli_path: None,
            cli_version: None,
            adapter_version: Some("built-in".into()),
            adapter_pinned: None,
            auth_mode: AuthMode::None,
            auth_label: None,
            policy: policy_for("mock", AuthMode::None),
            status_message: "Ready".into(),
            actions: vec![],
            verified: true,
        });
    }

    // Codex
    {
        let (cli, version, login) = codex_status().await;
        let adapter = verify_adapter(&env.adapters_dir, &CODEX_ADAPTER);
        let adapter_version = installed_adapter_version(&env.adapters_dir, &CODEX_ADAPTER);
        let node = node_ok().await;
        let (signed_in, label) = match &login {
            Some((true, s)) if s.to_lowercase().contains("logged in") => {
                let label = if s.contains("ChatGPT") { "ChatGPT" } else { "API key" };
                (true, Some(label.to_string()))
            }
            _ => (false, None),
        };
        let mode = if label.as_deref() == Some("API key") {
            AuthMode::ApiKey
        } else {
            env.codex_mode
        };
        let mut actions = vec!["recheck".to_string()];
        let (state, msg) = if let Err(e) = &node {
            actions.push("open_node_download".into());
            (ProviderState::NotInstalled, e.clone())
        } else if cli.is_none() {
            actions.push("open_codex_install".into());
            (ProviderState::NotInstalled, "Codex is not installed. Install the Codex CLI, then recheck.".to_string())
        } else if let Err(e) = &adapter {
            actions.push("install_adapter".into());
            let st = if adapter_version.is_some() { ProviderState::Broken } else { ProviderState::Installed };
            (st, format!("{e}. Click Install to add the verified Codex connector."))
        } else if !signed_in {
            actions.push("sign_in".into());
            (ProviderState::SignedOut, "Sign in to Codex (ChatGPT) to use it.".to_string())
        } else {
            actions.push("sign_out".into());
            actions.push("install_adapter".into());
            (ProviderState::Ready, format!("Signed in ({})", label.clone().unwrap_or_default()))
        };
        out.push(ProviderView {
            id: "codex".into(),
            name: "Codex".into(),
            description: "OpenAI's coding agent, via the official ACP adapter.".into(),
            state,
            cli_path: cli.map(|p| p.to_string_lossy().to_string()),
            cli_version: version,
            adapter_version,
            adapter_pinned: Some(CODEX_ADAPTER.version.into()),
            auth_mode: if signed_in { mode } else { AuthMode::None },
            auth_label: label,
            policy: policy_for("codex", if signed_in { mode } else { AuthMode::Subscription }),
            status_message: msg,
            actions,
            verified: true,
        });
    }

    // Claude Code: official sign-in (`claude auth login`) via the official ACP adapter.
    {
        let cli = which("claude");
        let version = match &cli {
            Some(c) => run_capture(c, &["--version"], Duration::from_secs(10)).await.map(|(_, v)| v),
            None => None,
        };
        let auth = match &cli {
            Some(c) => claude_auth_status(c).await,
            None => None,
        };
        let adapter = verify_adapter(&env.adapters_dir, &CLAUDE_ADAPTER);
        let adapter_version = installed_adapter_version(&env.adapters_dir, &CLAUDE_ADAPTER);
        let node = node_ok().await;
        let signed_in = auth.as_ref().map(|a| a.0).unwrap_or(false);
        let label = auth.and_then(|a| a.1);
        let mut actions = vec!["recheck".to_string()];
        let (state, msg) = if let Err(e) = &node {
            actions.push("open_node_download".into());
            (ProviderState::NotInstalled, e.clone())
        } else if cli.is_none() {
            actions.push("open_claude_install".into());
            (ProviderState::NotInstalled, "Claude Code is not installed. Install it, then recheck.".to_string())
        } else if let Err(e) = &adapter {
            actions.push("install_adapter".into());
            let st = if adapter_version.is_some() { ProviderState::Broken } else { ProviderState::Installed };
            (st, format!("{e}. Click Install to add the verified Claude connector."))
        } else if !signed_in {
            actions.push("sign_in".into());
            (ProviderState::SignedOut, "Sign in to Claude Code to use it.".to_string())
        } else {
            actions.push("sign_out".into());
            actions.push("install_adapter".into());
            (ProviderState::Ready, format!("Signed in ({})", label.clone().unwrap_or_else(|| "Claude".into())))
        };
        out.push(ProviderView {
            id: "claude".into(),
            name: "Claude Code".into(),
            description: "Anthropic's Claude Code agent, via the official ACP adapter.".into(),
            state,
            cli_path: cli.map(|p| p.to_string_lossy().to_string()),
            cli_version: version,
            adapter_version,
            adapter_pinned: Some(CLAUDE_ADAPTER.version.into()),
            auth_mode: if signed_in { AuthMode::Subscription } else { AuthMode::None },
            auth_label: if signed_in { label } else { None },
            policy: policy_for("claude", AuthMode::Subscription),
            status_message: msg,
            actions,
            verified: true,
        });
    }

    for c in &env.custom_agents {
        let current = sha256_file(&c.program);
        let (state, msg) = match current {
            None => (ProviderState::Broken, "Executable not found".to_string()),
            Some(h) if h != c.sha256 => (
                ProviderState::Broken,
                "Executable changed on disk since you added it. Remove and add it again if you trust the new version.".to_string(),
            ),
            Some(_) => (ProviderState::Ready, "Ready (not verified by Remote ACP Bridge)".to_string()),
        };
        out.push(ProviderView {
            id: c.id.clone(),
            name: c.name.clone(),
            description: format!("Custom ACP agent: {}", c.program.display()),
            state,
            cli_path: Some(c.program.to_string_lossy().to_string()),
            cli_version: None,
            adapter_version: None,
            adapter_pinned: None,
            auth_mode: AuthMode::None,
            auth_label: None,
            policy: custom_policy(c),
            status_message: msg,
            actions: vec!["remove_custom".into()],
            verified: false,
        });
    }
    out
}

/// Build the launch command for a provider, re-verifying everything.
pub async fn launch_command(env: &ProviderEnv<'_>, provider: &str, cwd: &Path) -> Result<AgentCommand, String> {
    let base = base_env();
    match provider {
        "mock" => {
            let (program, args) = env.mock_command.clone().ok_or("Test agent is not available")?;
            Ok(AgentCommand { program, args, env: base, cwd: cwd.into() })
        }
        "codex" => {
            let node = node_ok().await?;
            let entry = verify_adapter(&env.adapters_dir, &CODEX_ADAPTER)?;
            Ok(AgentCommand {
                program: node,
                args: vec![entry.to_string_lossy().to_string()],
                env: base,
                cwd: cwd.into(),
            })
        }
        "claude" => {
            let node = node_ok().await?;
            let entry = verify_adapter(&env.adapters_dir, &CLAUDE_ADAPTER)?;
            Ok(AgentCommand {
                program: node,
                args: vec![entry.to_string_lossy().to_string()],
                env: base,
                cwd: cwd.into(),
            })
        }
        id if id.starts_with("custom:") => {
            let c = env.custom_agents.iter().find(|c| c.id == id).ok_or("Unknown custom agent")?;
            if sha256_file(&c.program).as_deref() != Some(c.sha256.as_str()) {
                return Err("Custom agent executable changed on disk; refusing to launch".into());
            }
            Ok(AgentCommand {
                program: c.program.clone(),
                args: c.args.clone(),
                env: base,
                cwd: cwd.into(),
            })
        }
        _ => Err("Unknown provider".into()),
    }
}

/// Launch the official Codex browser sign-in (`codex login`).
pub async fn codex_sign_in() -> Result<(), String> {
    let cli = which("codex").ok_or("Codex is not installed")?;
    let mut cmd = Command::new(cli);
    cmd.arg("login")
        .env_clear()
        .envs(base_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // The CLI opens the browser and waits for the OAuth callback; let it run
    // in the background for up to 10 minutes.
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(600), child.wait()).await;
        let _ = child.kill().await;
    });
    Ok(())
}

/// Official status from the Claude Code CLI. Only `loggedIn` and the plan
/// name are used; account identity fields are ignored and never stored.
async fn claude_auth_status(cli: &Path) -> Option<(bool, Option<String>)> {
    let (_, out) = run_capture(cli, &["auth", "status", "--json"], Duration::from_secs(15)).await?;
    let start = out.find('{')?;
    let v: serde_json::Value = serde_json::from_str(&out[start..out.rfind('}')? + 1]).ok()?;
    let logged_in = v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false);
    let label = v.get("subscriptionType").and_then(|x| x.as_str()).map(|t| match t {
        "max" => "Claude Max".to_string(),
        "pro" => "Claude Pro".to_string(),
        "team" => "Claude Team".to_string(),
        "enterprise" => "Claude Enterprise".to_string(),
        other => format!("Claude {other}"),
    });
    Some((logged_in, label))
}

/// Launch the official Claude Code browser sign-in (`claude auth login`).
pub async fn claude_sign_in() -> Result<(), String> {
    let cli = which("claude").ok_or("Claude Code is not installed")?;
    let mut child = Command::new(cli)
        .args(["auth", "login", "--claudeai"])
        .env_clear()
        .envs(base_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(600), child.wait()).await;
        let _ = child.kill().await;
    });
    Ok(())
}

pub async fn claude_sign_out() -> Result<(), String> {
    let cli = which("claude").ok_or("Claude Code is not installed")?;
    match run_capture(&cli, &["auth", "logout"], Duration::from_secs(15)).await {
        Some((true, _)) => Ok(()),
        _ => Err("Claude Code sign-out failed".into()),
    }
}

pub async fn codex_sign_out() -> Result<(), String> {
    let cli = which("codex").ok_or("Codex is not installed")?;
    match run_capture(&cli, &["logout"], Duration::from_secs(15)).await {
        Some((true, _)) => Ok(()),
        _ => Err("Codex sign-out failed".into()),
    }
}
