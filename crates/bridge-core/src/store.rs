//! Local SQLite persistence. Holds only metadata: trusted services, grants,
//! task summaries, audit events and settings. Never provider tokens, prompts
//! or transcripts.

use std::path::Path;

use chrono::{DateTime, Utc};
use connection_policy::{AccessLevel, Grant, GrantStatus};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MIGRATIONS: &[&str] = &[
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE trusted_services (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, origin TEXT NOT NULL,
        domain TEXT NOT NULL, verified INTEGER NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
     CREATE TABLE grants (
        connection_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, external_user_id TEXT NOT NULL,
        provider_id TEXT NOT NULL, workspace_root TEXT NOT NULL, scopes TEXT NOT NULL,
        require_task_approval INTEGER NOT NULL, access TEXT NOT NULL, expires_at TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_active_at TEXT);
     CREATE TABLE tasks (
        id TEXT PRIMARY KEY, connection_id TEXT, source TEXT NOT NULL, provider_id TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, failure_code TEXT, stop_reason TEXT);
     CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT, task_id TEXT,
        event_type TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL);
     CREATE INDEX idx_audit_time ON audit_events(created_at);",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrustedService {
    pub id: String,
    pub display_name: String,
    pub origin: String,
    pub domain: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRecord {
    #[serde(flatten)]
    pub grant: Grant,
    pub created_at: DateTime<Utc>,
    pub last_active_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub connection_id: Option<String>,
    pub source: String,
    pub provider_id: String,
    pub state: String,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub failure_code: Option<String>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: i64,
    pub connection_id: Option<String>,
    pub task_id: Option<String>,
    pub event_type: String,
    pub created_at: DateTime<Utc>,
    pub metadata: Value,
}

pub struct Store {
    conn: Connection,
}

fn ts(s: String) -> DateTime<Utc> {
    s.parse().unwrap_or_else(|_| Utc::now())
}

fn status_str(s: GrantStatus) -> &'static str {
    match s {
        GrantStatus::Active => "active",
        GrantStatus::Paused => "paused",
        GrantStatus::Revoked => "revoked",
    }
}

fn parse_status(s: &str) -> GrantStatus {
    match s {
        "active" => GrantStatus::Active,
        "paused" => GrantStatus::Paused,
        _ => GrantStatus::Revoked,
    }
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(m)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(Self { conn })
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn upsert_service(&self, s: &TrustedService) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO trusted_services (id, display_name, origin, domain, verified, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, origin = excluded.origin,
               domain = excluded.domain, verified = excluded.verified, last_seen = excluded.last_seen",
            params![s.id, s.display_name, s.origin, s.domain, s.verified as i64, now],
        )?;
        Ok(())
    }

    pub fn services(&self) -> rusqlite::Result<Vec<TrustedService>> {
        let mut st = self
            .conn
            .prepare("SELECT id, display_name, origin, domain, verified FROM trusted_services")?;
        let rows = st.query_map([], |r| {
            Ok(TrustedService {
                id: r.get(0)?,
                display_name: r.get(1)?,
                origin: r.get(2)?,
                domain: r.get(3)?,
                verified: r.get::<_, i64>(4)? != 0,
            })
        })?;
        rows.collect()
    }

    pub fn insert_grant(&self, g: &Grant) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO grants (connection_id, service_id, external_user_id, provider_id, workspace_root, scopes,
               require_task_approval, access, expires_at, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                g.connection_id,
                g.service_id,
                g.external_user_id,
                g.provider_id,
                g.workspace_root.to_string_lossy(),
                serde_json::to_string(&g.scopes).unwrap(),
                g.require_task_approval as i64,
                serde_json::to_value(g.access).unwrap().as_str().unwrap_or("read_only"),
                g.expires_at.to_rfc3339(),
                status_str(g.status),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn grants(&self) -> rusqlite::Result<Vec<GrantRecord>> {
        let mut st = self.conn.prepare(
            "SELECT connection_id, service_id, external_user_id, provider_id, workspace_root, scopes,
                    require_task_approval, access, expires_at, status, created_at, last_active_at
             FROM grants ORDER BY created_at DESC",
        )?;
        let rows = st.query_map([], |r| {
            let scopes: String = r.get(5)?;
            let access: String = r.get(7)?;
            Ok(GrantRecord {
                grant: Grant {
                    connection_id: r.get(0)?,
                    service_id: r.get(1)?,
                    external_user_id: r.get(2)?,
                    provider_id: r.get(3)?,
                    workspace_root: r.get::<_, String>(4)?.into(),
                    scopes: serde_json::from_str(&scopes).unwrap_or_default(),
                    require_task_approval: r.get::<_, i64>(6)? != 0,
                    access: serde_json::from_value(Value::String(access)).unwrap_or(AccessLevel::ReadOnly),
                    expires_at: ts(r.get(8)?),
                    status: parse_status(&r.get::<_, String>(9)?),
                },
                created_at: ts(r.get(10)?),
                last_active_at: r.get::<_, Option<String>>(11)?.map(ts),
            })
        })?;
        rows.collect()
    }

    pub fn grant(&self, connection_id: &str) -> Option<GrantRecord> {
        self.grants().ok()?.into_iter().find(|g| g.grant.connection_id == connection_id)
    }

    pub fn set_grant_status(&self, connection_id: &str, status: GrantStatus) -> rusqlite::Result<bool> {
        let revoked_at = (status == GrantStatus::Revoked).then(|| Utc::now().to_rfc3339());
        let n = self.conn.execute(
            "UPDATE grants SET status = ?2, revoked_at = COALESCE(?3, revoked_at)
             WHERE connection_id = ?1 AND status != 'revoked'",
            params![connection_id, status_str(status), revoked_at],
        )?;
        Ok(n > 0)
    }

    pub fn update_grant_settings(
        &self,
        connection_id: &str,
        require_task_approval: bool,
        access: AccessLevel,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE grants SET require_task_approval = ?2, access = ?3 WHERE connection_id = ?1",
            params![
                connection_id,
                require_task_approval as i64,
                serde_json::to_value(access).unwrap().as_str().unwrap_or("read_only")
            ],
        )?;
        Ok(())
    }

    pub fn delete_grant(&self, connection_id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM grants WHERE connection_id = ?1", [connection_id])?;
        Ok(())
    }

    pub fn touch_grant(&self, connection_id: &str) {
        let _ = self.conn.execute(
            "UPDATE grants SET last_active_at = ?2 WHERE connection_id = ?1",
            params![connection_id, Utc::now().to_rfc3339()],
        );
    }

    pub fn insert_task(&self, t: &TaskRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO tasks (id, connection_id, source, provider_id, state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![t.id, t.connection_id, t.source, t.provider_id, t.state, t.created_at.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn task_exists(&self, id: &str) -> bool {
        self.conn
            .query_row("SELECT 1 FROM tasks WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn update_task(
        &self,
        id: &str,
        state: &str,
        finished: bool,
        failure_code: Option<&str>,
        stop_reason: Option<&str>,
    ) -> rusqlite::Result<()> {
        let fin = finished.then(|| Utc::now().to_rfc3339());
        self.conn.execute(
            "UPDATE tasks SET state = ?2, finished_at = COALESCE(?3, finished_at),
               failure_code = COALESCE(?4, failure_code), stop_reason = COALESCE(?5, stop_reason) WHERE id = ?1",
            params![id, state, fin, failure_code, stop_reason],
        )?;
        Ok(())
    }

    pub fn recent_tasks(&self, limit: usize) -> rusqlite::Result<Vec<TaskRow>> {
        let mut st = self.conn.prepare(
            "SELECT id, connection_id, source, provider_id, state, created_at, finished_at, failure_code, stop_reason
             FROM tasks ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok(TaskRow {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                source: r.get(2)?,
                provider_id: r.get(3)?,
                state: r.get(4)?,
                created_at: ts(r.get(5)?),
                finished_at: r.get::<_, Option<String>>(6)?.map(ts),
                failure_code: r.get(7)?,
                stop_reason: r.get(8)?,
            })
        })?;
        rows.collect()
    }

    /// Tasks left non-terminal by a crash or forced quit are marked failed.
    pub fn fail_interrupted_tasks(&self) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE tasks SET state = 'failed', failure_code = 'app_restarted', finished_at = ?1
             WHERE state NOT IN ('completed','cancelled','failed','rejected','expired')",
            [Utc::now().to_rfc3339()],
        )
    }

    pub fn audit(&self, connection_id: Option<&str>, task_id: Option<&str>, event_type: &str, metadata: Value) {
        let _ = self.conn.execute(
            "INSERT INTO audit_events (connection_id, task_id, event_type, created_at, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![connection_id, task_id, event_type, Utc::now().to_rfc3339(), metadata.to_string()],
        );
    }

    pub fn audit_events(&self, limit: usize) -> rusqlite::Result<Vec<AuditEvent>> {
        let mut st = self.conn.prepare(
            "SELECT id, connection_id, task_id, event_type, created_at, metadata FROM audit_events ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            let m: String = r.get(5)?;
            Ok(AuditEvent {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                task_id: r.get(2)?,
                event_type: r.get(3)?,
                created_at: ts(r.get(4)?),
                metadata: serde_json::from_str(&m).unwrap_or(Value::Null),
            })
        })?;
        rows.collect()
    }

    pub fn clear_audit(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM audit_events", [])?;
        Ok(())
    }
}
