//! Local security policy: workspace confinement and grant authorization.
//!
//! Everything here is UI-framework independent and fully unit tested.

use std::path::{Component, Path, PathBuf};

use bridge_protocol::{scopes, TaskStart};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024;

/// Directory names that are never readable or writable through the bridge,
/// even inside an approved workspace.
const DENIED_COMPONENTS: &[&str] = &[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".claude", ".codex"];

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PathDenied {
    #[error("path must be absolute")]
    NotAbsolute,
    #[error("path is outside the approved workspace")]
    OutsideWorkspace,
    #[error("path does not exist")]
    NotFound,
    #[error("access to this location is blocked by policy")]
    Sensitive,
    #[error("hard-linked files cannot be accessed through the bridge")]
    HardLink,
    #[error("not a regular file")]
    NotAFile,
    #[error("file is too large")]
    TooLarge,
    #[error("invalid path")]
    Invalid,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum WorkspaceError {
    #[error("folder does not exist")]
    NotFound,
    #[error("choose a folder, not a file")]
    NotADirectory,
    #[error("this folder is too broad to share (system root or your whole home folder)")]
    TooBroad,
    #[error("this folder contains credentials and cannot be shared")]
    Sensitive,
}

/// A canonicalized, validated workspace root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    root: PathBuf,
}

fn has_denied_component(p: &Path) -> bool {
    p.components().any(|c| match c {
        Component::Normal(s) => {
            let s = s.to_string_lossy().to_lowercase();
            DENIED_COMPONENTS.contains(&s.as_str())
        }
        _ => false,
    })
}

#[cfg(unix)]
fn link_count(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.nlink()
}

#[cfg(not(unix))]
fn link_count(_meta: &std::fs::Metadata) -> u64 {
    1
}

impl Workspace {
    /// Validate a user-chosen workspace folder.
    pub fn new(path: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let path = path.as_ref();
        let meta = std::fs::metadata(path).map_err(|_| WorkspaceError::NotFound)?;
        if !meta.is_dir() {
            return Err(WorkspaceError::NotADirectory);
        }
        let root = dunce_canonicalize(path).map_err(|_| WorkspaceError::NotFound)?;
        if root.parent().is_none() {
            return Err(WorkspaceError::TooBroad);
        }
        if let Some(home) = dirs::home_dir().and_then(|h| dunce_canonicalize(&h).ok()) {
            // Refuse the home folder itself or any of its ancestors.
            if home.starts_with(&root) {
                return Err(WorkspaceError::TooBroad);
            }
        }
        if has_denied_component(&root) {
            return Err(WorkspaceError::Sensitive);
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn check_inside(&self, canonical: &Path) -> Result<(), PathDenied> {
        if !canonical.starts_with(&self.root) {
            return Err(PathDenied::OutsideWorkspace);
        }
        let rel = canonical.strip_prefix(&self.root).map_err(|_| PathDenied::Invalid)?;
        if has_denied_component(rel) {
            return Err(PathDenied::Sensitive);
        }
        Ok(())
    }

    fn lexical_checks(path: &Path) -> Result<(), PathDenied> {
        if !path.is_absolute() {
            return Err(PathDenied::NotAbsolute);
        }
        if path.as_os_str().to_string_lossy().contains('\0') {
            return Err(PathDenied::Invalid);
        }
        Ok(())
    }

    /// Resolve a path the agent wants to read. Follows symlinks and requires
    /// the final target to be a regular file inside the workspace.
    pub fn resolve_read(&self, path: impl AsRef<Path>) -> Result<PathBuf, PathDenied> {
        let path = path.as_ref();
        Self::lexical_checks(path)?;
        let canonical = dunce_canonicalize(path).map_err(|_| PathDenied::NotFound)?;
        self.check_inside(&canonical)?;
        let meta = std::fs::metadata(&canonical).map_err(|_| PathDenied::NotFound)?;
        if !meta.is_file() {
            return Err(PathDenied::NotAFile);
        }
        if link_count(&meta) > 1 {
            return Err(PathDenied::HardLink);
        }
        if meta.len() > MAX_READ_BYTES {
            return Err(PathDenied::TooLarge);
        }
        Ok(canonical)
    }

    /// Resolve a path the agent wants to write. The parent directory must
    /// exist inside the workspace; an existing target must not be a symlink
    /// pointing outside, nor a hard link.
    pub fn resolve_write(&self, path: impl AsRef<Path>, len: usize) -> Result<PathBuf, PathDenied> {
        let path = path.as_ref();
        Self::lexical_checks(path)?;
        if len > MAX_WRITE_BYTES {
            return Err(PathDenied::TooLarge);
        }
        let file_name = path.file_name().ok_or(PathDenied::Invalid)?;
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(PathDenied::Invalid);
        }
        let parent = path.parent().ok_or(PathDenied::Invalid)?;
        let parent = dunce_canonicalize(parent).map_err(|_| PathDenied::NotFound)?;
        self.check_inside(&parent)?;
        let target = parent.join(file_name);
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                let resolved = dunce_canonicalize(&target).map_err(|_| PathDenied::OutsideWorkspace)?;
                self.check_inside(&resolved)?;
                let rmeta = std::fs::metadata(&resolved).map_err(|_| PathDenied::NotFound)?;
                if !rmeta.is_file() || link_count(&rmeta) > 1 {
                    return Err(PathDenied::HardLink);
                }
                return Ok(resolved);
            }
            if !meta.is_file() {
                return Err(PathDenied::NotAFile);
            }
            if link_count(&meta) > 1 {
                return Err(PathDenied::HardLink);
            }
        }
        self.check_inside(&target)?;
        Ok(target)
    }
}

/// Canonicalize without Windows `\\?\` verbatim prefixes.
fn dunce_canonicalize(p: &Path) -> std::io::Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    #[cfg(windows)]
    {
        let s = c.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            if !stripped.starts_with("UNC\\") {
                return Ok(PathBuf::from(stripped));
            }
        }
    }
    Ok(c)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantStatus {
    Active,
    Paused,
    Revoked,
}

/// What the agent may do inside the workspace for website-initiated tasks.
/// Full machine access is intentionally not representable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AccessLevel {
    /// Agent must ask before editing files or using the network.
    #[default]
    ReadOnly,
    /// Agent may edit files inside the workspace; asks for anything else.
    WorkspaceWrite,
}

impl AccessLevel {
    /// ACP session mode ids to try, most preferred first (known adapters).
    pub fn mode_candidates(self) -> &'static [&'static str] {
        match self {
            AccessLevel::ReadOnly => &["read-only", "ask", "default", "plan"],
            AccessLevel::WorkspaceWrite => &["workspace-write", "auto", "acceptEdits", "accept-edits"],
        }
    }
}

/// A local connection grant as consented by the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub connection_id: String,
    pub service_id: String,
    pub external_user_id: String,
    pub provider_id: String,
    pub workspace_root: PathBuf,
    pub scopes: Vec<String>,
    pub require_task_approval: bool,
    #[serde(default)]
    pub access: AccessLevel,
    pub expires_at: DateTime<Utc>,
    pub status: GrantStatus,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TaskDenied {
    #[error("connection was revoked")]
    Revoked,
    #[error("connection is paused")]
    Paused,
    #[error("connection has expired")]
    Expired,
    #[error("task was issued by a different service")]
    WrongService,
    #[error("task was issued for a different website user")]
    WrongUser,
    #[error("connection does not allow interactive tasks")]
    MissingScope,
    #[error("bridge is paused on this computer")]
    BridgePaused,
}

impl TaskDenied {
    pub fn code(&self) -> &'static str {
        match self {
            TaskDenied::Revoked => "connection_revoked",
            TaskDenied::Paused => "connection_paused",
            TaskDenied::Expired => "connection_expired",
            TaskDenied::WrongService => "wrong_service",
            TaskDenied::WrongUser => "wrong_user",
            TaskDenied::MissingScope => "missing_scope",
            TaskDenied::BridgePaused => "bridge_paused",
        }
    }
}

impl Grant {
    /// Authorize an inbound `task.start`. The relay already authenticated the
    /// service; this is the desktop's independent check.
    pub fn authorize_task(&self, req: &TaskStart, now: DateTime<Utc>, bridge_paused: bool) -> Result<(), TaskDenied> {
        if bridge_paused {
            return Err(TaskDenied::BridgePaused);
        }
        match self.status {
            GrantStatus::Revoked => return Err(TaskDenied::Revoked),
            GrantStatus::Paused => return Err(TaskDenied::Paused),
            GrantStatus::Active => {}
        }
        if now >= self.expires_at {
            return Err(TaskDenied::Expired);
        }
        if req.service_id != self.service_id {
            return Err(TaskDenied::WrongService);
        }
        if req.external_user_id != self.external_user_id {
            return Err(TaskDenied::WrongUser);
        }
        if !self.scopes.iter().any(|s| s == scopes::TASK_INTERACTIVE) {
            return Err(TaskDenied::MissingScope);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_protocol::{InputBlock, TaskMode};

    fn ws() -> (tempfile::TempDir, Workspace) {
        let d = tempfile::tempdir().unwrap();
        let w = Workspace::new(d.path()).unwrap();
        (d, w)
    }

    #[test]
    fn rejects_broad_workspaces() {
        assert_eq!(Workspace::new("/"), Err(WorkspaceError::TooBroad));
        let home = dirs::home_dir().unwrap();
        assert_eq!(Workspace::new(&home), Err(WorkspaceError::TooBroad));
        assert_eq!(Workspace::new("/definitely/missing/dir"), Err(WorkspaceError::NotFound));
    }

    #[test]
    fn rejects_sensitive_workspace() {
        let d = tempfile::tempdir().unwrap();
        let ssh = d.path().join(".ssh");
        std::fs::create_dir(&ssh).unwrap();
        assert_eq!(Workspace::new(&ssh), Err(WorkspaceError::Sensitive));
    }

    #[test]
    fn read_inside_ok_outside_denied() {
        let (d, w) = ws();
        let f = d.path().join("a.txt");
        std::fs::write(&f, "hi").unwrap();
        assert!(w.resolve_read(&f).is_ok());
        assert_eq!(w.resolve_read("relative.txt"), Err(PathDenied::NotAbsolute));
        assert_eq!(w.resolve_read("/etc/hosts"), Err(PathDenied::OutsideWorkspace));
        let traversal = d.path().join("..").join("..").join("etc").join("hosts");
        assert!(w.resolve_read(&traversal).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_denied() {
        let (d, w) = ws();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "secret").unwrap();
        let link = d.path().join("link.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert_eq!(w.resolve_read(&link), Err(PathDenied::OutsideWorkspace));
        assert_eq!(w.resolve_write(&link, 3), Err(PathDenied::OutsideWorkspace));
        // Directory symlink escape for writes.
        let dirlink = d.path().join("outdir");
        std::os::unix::fs::symlink(outside.path(), &dirlink).unwrap();
        assert_eq!(w.resolve_write(dirlink.join("new.txt"), 3), Err(PathDenied::OutsideWorkspace));
    }

    #[cfg(unix)]
    #[test]
    fn hardlink_denied() {
        let (d, w) = ws();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "secret").unwrap();
        let hl = d.path().join("hl.txt");
        if std::fs::hard_link(&secret, &hl).is_ok() {
            assert_eq!(w.resolve_read(&hl), Err(PathDenied::HardLink));
            assert_eq!(w.resolve_write(&hl, 1), Err(PathDenied::HardLink));
        }
    }

    #[test]
    fn sensitive_component_inside_workspace_denied() {
        let (d, w) = ws();
        let dir = d.path().join(".aws");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("credentials"), "x").unwrap();
        assert_eq!(w.resolve_read(dir.join("credentials")), Err(PathDenied::Sensitive));
        assert_eq!(w.resolve_write(dir.join("credentials"), 1), Err(PathDenied::Sensitive));
    }

    #[test]
    fn write_rules() {
        let (d, w) = ws();
        assert!(w.resolve_write(d.path().join("new.txt"), 10).is_ok());
        assert_eq!(w.resolve_write(d.path().join("missing/new.txt"), 10), Err(PathDenied::NotFound));
        assert_eq!(w.resolve_write(d.path().join("x/../new.txt"), 1), Err(PathDenied::Invalid));
        assert_eq!(w.resolve_write(d.path().join("big.txt"), MAX_WRITE_BYTES + 1), Err(PathDenied::TooLarge));
        assert_eq!(w.resolve_write(d.path(), 1), Err(PathDenied::OutsideWorkspace));
        std::fs::create_dir(d.path().join("sub")).unwrap();
        assert_eq!(w.resolve_write(d.path().join("sub"), 1), Err(PathDenied::NotAFile));
    }

    fn grant() -> Grant {
        Grant {
            connection_id: "conn_1".into(),
            service_id: "svc_a".into(),
            external_user_id: "u1".into(),
            provider_id: "mock".into(),
            workspace_root: "/tmp".into(),
            scopes: vec!["task.interactive".into()],
            require_task_approval: true,
            access: AccessLevel::ReadOnly,
            expires_at: Utc::now() + chrono::Duration::hours(1),
            status: GrantStatus::Active,
        }
    }

    fn req(svc: &str, user: &str) -> TaskStart {
        TaskStart {
            external_user_id: user.into(),
            input: vec![InputBlock::Text { text: "x".into() }],
            mode: TaskMode::Interactive,
            service_id: svc.into(),
        }
    }

    #[test]
    fn grant_authorization() {
        let g = grant();
        let now = Utc::now();
        assert!(g.authorize_task(&req("svc_a", "u1"), now, false).is_ok());
        assert_eq!(g.authorize_task(&req("svc_b", "u1"), now, false), Err(TaskDenied::WrongService));
        assert_eq!(g.authorize_task(&req("svc_a", "u2"), now, false), Err(TaskDenied::WrongUser));
        assert_eq!(g.authorize_task(&req("svc_a", "u1"), now, true), Err(TaskDenied::BridgePaused));
        let mut r = g.clone();
        r.status = GrantStatus::Revoked;
        assert_eq!(r.authorize_task(&req("svc_a", "u1"), now, false), Err(TaskDenied::Revoked));
        let mut p = g.clone();
        p.status = GrantStatus::Paused;
        assert_eq!(p.authorize_task(&req("svc_a", "u1"), now, false), Err(TaskDenied::Paused));
        assert_eq!(
            g.authorize_task(&req("svc_a", "u1"), g.expires_at, false),
            Err(TaskDenied::Expired)
        );
        let mut s = g.clone();
        s.scopes.clear();
        assert_eq!(s.authorize_task(&req("svc_a", "u1"), now, false), Err(TaskDenied::MissingScope));
    }
}
