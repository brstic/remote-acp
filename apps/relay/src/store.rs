//! Minimal durable relay state: desktops (token hashes) and connection grants.
//! No prompts, results, or provider credentials are ever persisted.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRow {
    pub id: String,
    pub service_id: String,
    pub desktop_id: String,
    pub external_user_id: String,
    pub scopes: Vec<String>,
    pub provider_label: String,
    /// active | paused | revoked
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl ConnectionRow {
    pub fn effective_status(&self, now: DateTime<Utc>) -> &str {
        if self.status == "revoked" {
            "revoked"
        } else if now >= self.expires_at {
            "expired"
        } else {
            &self.status
        }
    }
}

pub struct Store {
    conn: Connection,
}

const MIGRATIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS desktops (
        id TEXT PRIMARY KEY,
        token_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        desktop_id TEXT NOT NULL REFERENCES desktops(id),
        external_user_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        provider_label TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conn_service_user ON connections(service_id, external_user_id);
    CREATE INDEX IF NOT EXISTS idx_conn_desktop ON connections(desktop_id);",
];

fn row_to_conn(r: &rusqlite::Row) -> rusqlite::Result<ConnectionRow> {
    let scopes: String = r.get(4)?;
    let exp: String = r.get(7)?;
    let created: String = r.get(8)?;
    Ok(ConnectionRow {
        id: r.get(0)?,
        service_id: r.get(1)?,
        desktop_id: r.get(2)?,
        external_user_id: r.get(3)?,
        scopes: serde_json::from_str(&scopes).unwrap_or_default(),
        provider_label: r.get(5)?,
        status: r.get(6)?,
        expires_at: exp.parse().unwrap_or_else(|_| Utc::now()),
        created_at: created.parse().unwrap_or_else(|_| Utc::now()),
    })
}

const CONN_COLS: &str =
    "id, service_id, desktop_id, external_user_id, scopes, provider_label, status, expires_at, created_at";

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory()?
        } else {
            Connection::open(path)?
        };
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(m)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(Self { conn })
    }

    pub fn insert_desktop(&self, id: &str, token_sha256: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO desktops (id, token_sha256, created_at) VALUES (?1, ?2, ?3)",
            params![id, token_sha256, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn desktop_token_hash(&self, id: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT token_sha256 FROM desktops WHERE id = ?1", [id], |r| r.get(0))
            .optional()
    }

    pub fn insert_connection(&self, c: &ConnectionRow) -> rusqlite::Result<()> {
        self.conn.execute(
            &format!("INSERT INTO connections ({CONN_COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"),
            params![
                c.id,
                c.service_id,
                c.desktop_id,
                c.external_user_id,
                serde_json::to_string(&c.scopes).unwrap(),
                c.provider_label,
                c.status,
                c.expires_at.to_rfc3339(),
                c.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn connection(&self, id: &str) -> rusqlite::Result<Option<ConnectionRow>> {
        self.conn
            .query_row(
                &format!("SELECT {CONN_COLS} FROM connections WHERE id = ?1"),
                [id],
                row_to_conn,
            )
            .optional()
    }

    pub fn connections_for_user(&self, service_id: &str, external_user_id: &str) -> rusqlite::Result<Vec<ConnectionRow>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {CONN_COLS} FROM connections WHERE service_id = ?1 AND external_user_id = ?2 ORDER BY created_at DESC"
        ))?;
        let rows = st.query_map(params![service_id, external_user_id], row_to_conn)?;
        rows.collect()
    }

    pub fn connections_for_desktop(&self, desktop_id: &str) -> rusqlite::Result<Vec<ConnectionRow>> {
        let mut st = self
            .conn
            .prepare(&format!("SELECT {CONN_COLS} FROM connections WHERE desktop_id = ?1"))?;
        let rows = st.query_map([desktop_id], row_to_conn)?;
        rows.collect()
    }

    pub fn set_connection_status(&self, id: &str, status: &str) -> rusqlite::Result<bool> {
        // Revocation is terminal.
        let n = self.conn.execute(
            "UPDATE connections SET status = ?2 WHERE id = ?1 AND status != 'revoked'",
            params![id, status],
        )?;
        Ok(n > 0)
    }
}
