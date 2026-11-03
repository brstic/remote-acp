//! HTTP API for registered services and desktops.

use std::convert::Infallible;
use std::time::Duration as StdDuration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bridge_protocol::ids;
use bridge_protocol::{scopes, Body, Envelope, InputBlock, TaskMode, TaskStart, MAX_PROMPT_BYTES};
use chrono::{Duration, Utc};
use futures::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::config::ServiceConfig;
use crate::state::{AppState, Pairing, PairingStatus, RelayTaskState, Shared, StoredEvent, TaskRec};
use crate::store::ConnectionRow;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "Missing or invalid credentials")
    }
    fn not_found(what: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", format!("{what} not found"))
    }
    fn bad(code: &'static str, msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, msg)
    }
    fn rate() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many requests")
    }
    fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": {"code": self.code, "message": self.message}})),
        )
            .into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}

/// Service credential: `Bearer <serviceId>.<secret>`
pub fn auth_service<'a>(st: &'a AppState, headers: &HeaderMap) -> ApiResult<&'a ServiceConfig> {
    let token = bearer(headers).ok_or_else(ApiError::unauthorized)?;
    let (id, secret) = token.split_once('.').ok_or_else(ApiError::unauthorized)?;
    let svc = st.service(id).ok_or_else(ApiError::unauthorized)?;
    if !ids::verify_secret(secret, &svc.secret_sha256) {
        return Err(ApiError::unauthorized());
    }
    Ok(svc)
}

/// Desktop credential: `Bearer <desktopId>.<secret>`
pub fn auth_desktop(st: &AppState, headers: &HeaderMap) -> ApiResult<String> {
    let token = bearer(headers).ok_or_else(ApiError::unauthorized)?;
    let (id, secret) = token.split_once('.').ok_or_else(ApiError::unauthorized)?;
    if !id.starts_with("dsk_") {
        return Err(ApiError::unauthorized());
    }
    let hash = st
        .store
        .lock()
        .unwrap()
        .desktop_token_hash(id)
        .map_err(|_| ApiError::internal())?
        .ok_or_else(ApiError::unauthorized)?;
    if !ids::verify_secret(secret, &hash) {
        return Err(ApiError::unauthorized());
    }
    Ok(id.to_string())
}

pub fn router(st: Shared) -> Router {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"ok": true})) }))
        .route("/v1/desktops/register", post(register_desktop))
        .route("/v1/pairings", post(create_pairing))
        .route("/v1/pairings/redeem", post(redeem_pairing))
        .route("/v1/pairings/{id}", get(get_pairing))
        .route("/v1/pairings/{id}/accept", post(accept_pairing))
        .route("/v1/pairings/{id}/reject", post(reject_pairing))
        .route("/v1/connections", get(list_connections))
        .route("/v1/connections/{id}", get(get_connection))
        .route("/v1/connections/{id}/revoke", post(revoke_connection))
        .route("/v1/tasks", post(create_task))
        .route("/v1/tasks/{id}", get(get_task))
        .route("/v1/tasks/{id}/cancel", post(cancel_task))
        .route("/v1/tasks/{id}/events", get(task_events))
        .route("/v1/desktop", get(crate::ws::desktop_ws))
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .with_state(st)
}

// ---------- desktops ----------

async fn register_desktop(State(st): State<Shared>) -> ApiResult<Json<Value>> {
    if !st.rate_ok("register", st.cfg.limits.registrations_per_minute) {
        return Err(ApiError::rate());
    }
    let id = ids::new_id("dsk");
    let secret = ids::random_token(32);
    st.store
        .lock()
        .unwrap()
        .insert_desktop(&id, &ids::sha256_hex(&secret))
        .map_err(|_| ApiError::internal())?;
    Ok(Json(json!({"desktopId": id, "desktopToken": format!("{id}.{secret}")})))
}

// ---------- pairings ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePairing {
    external_user_id: String,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    expires_in_seconds: Option<i64>,
}

async fn create_pairing(
    State(st): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<CreatePairing>,
) -> ApiResult<Json<Value>> {
    let svc = auth_service(&st, &headers)?;
    if !st.rate_ok(&format!("pair:{}", svc.id), st.cfg.limits.pairings_per_minute_per_service) {
        return Err(ApiError::rate());
    }
    if req.external_user_id.is_empty() || req.external_user_id.len() > 256 {
        return Err(ApiError::bad("invalid_user", "externalUserId is required"));
    }
    let scopes = if req.scopes.is_empty() {
        vec![scopes::TASK_INTERACTIVE.to_string()]
    } else {
        req.scopes
    };
    if let Some(bad) = scopes.iter().find(|s| !scopes::is_known(s)) {
        return Err(ApiError::bad("invalid_scope", format!("unknown scope {bad}")));
    }
    let max = st.cfg.limits.pairing_ttl_max_secs.max(1);
    let ttl = req.expires_in_seconds.unwrap_or(120).clamp(30.min(max), max);
    let ticket = ids::random_token(32);
    let code = ids::pairing_code();
    let pairing = Pairing {
        id: ids::new_id("pair"),
        service_id: svc.id.clone(),
        external_user_id: req.external_user_id,
        scopes,
        ticket_sha256: ids::sha256_hex(&ticket),
        code: code.clone(),
        expires_at: Utc::now() + Duration::seconds(ttl),
        status: PairingStatus::Pending,
        claimed_by: None,
        connection_id: None,
    };
    let mut url = url::Url::parse("remoteacp://pair").unwrap();
    url.query_pairs_mut()
        .append_pair("ticket", &ticket)
        .append_pair("relay", &st.cfg.public_url);
    let resp = json!({
        "pairingId": pairing.id,
        "url": url.to_string(),
        "code": code,
        "expiresAt": pairing.expires_at,
    });
    let mut rt = st.rt.lock().unwrap();
    rt.tickets.insert(pairing.ticket_sha256.clone(), pairing.id.clone());
    rt.codes.insert(code, pairing.id.clone());
    rt.pairings.insert(pairing.id.clone(), pairing);
    Ok(Json(resp))
}

async fn get_pairing(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let svc = auth_service(&st, &headers)?;
    let rt = st.rt.lock().unwrap();
    let p = rt
        .pairings
        .get(&id)
        .filter(|p| p.service_id == svc.id)
        .ok_or_else(|| ApiError::not_found("pairing"))?;
    Ok(Json(json!({
        "pairingId": p.id,
        "status": p.effective_status(Utc::now()),
        "connectionId": p.connection_id,
        "expiresAt": p.expires_at,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Redeem {
    #[serde(default)]
    ticket: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

async fn redeem_pairing(State(st): State<Shared>, headers: HeaderMap, Json(req): Json<Redeem>) -> ApiResult<Json<Value>> {
    let desktop_id = auth_desktop(&st, &headers)?;
    let now = Utc::now();
    let mut rt = st.rt.lock().unwrap();
    // Brute-force protection for short codes.
    if let Some((n, since)) = rt.redeem_failures.get(&desktop_id) {
        if *n >= 5 && since.elapsed() < StdDuration::from_secs(60) {
            return Err(ApiError::rate());
        }
    }
    let pid = match (&req.ticket, &req.code) {
        (Some(t), _) => rt.tickets.get(&ids::sha256_hex(t)).cloned(),
        (None, Some(c)) => rt.codes.get(&ids::normalize_code(c)).cloned(),
        _ => None,
    };
    let Some(pid) = pid else {
        let e = rt.redeem_failures.entry(desktop_id.clone()).or_insert((0, std::time::Instant::now()));
        if e.1.elapsed() > StdDuration::from_secs(60) {
            *e = (0, std::time::Instant::now());
        }
        e.0 += 1;
        return Err(ApiError::new(StatusCode::NOT_FOUND, "invalid_ticket", "This pairing link is invalid"));
    };
    let p = rt.pairings.get_mut(&pid).ok_or_else(|| ApiError::not_found("pairing"))?;
    match p.effective_status(now) {
        PairingStatus::Expired => {
            return Err(ApiError::new(StatusCode::GONE, "ticket_expired", "This pairing link has expired. Ask the website for a new one."))
        }
        PairingStatus::Pending => {}
        PairingStatus::Claimed if p.claimed_by.as_deref() == Some(&desktop_id) => {}
        _ => return Err(ApiError::new(StatusCode::GONE, "ticket_used", "This pairing link was already used")),
    }
    p.status = PairingStatus::Claimed;
    p.claimed_by = Some(desktop_id);
    let p = p.clone();
    drop(rt);
    let svc = st.service(&p.service_id).ok_or_else(ApiError::internal)?;
    let origin = url::Url::parse(&svc.origin).map_err(|_| ApiError::internal())?;
    Ok(Json(json!({
        "pairingId": p.id,
        "service": {
            "id": svc.id,
            "displayName": svc.display_name,
            "origin": svc.origin,
            "domain": origin.host_str(),
            "verified": st.is_verified(&svc.id),
            "verification": svc.verification,
        },
        "externalUserId": p.external_user_id,
        "scopes": p.scopes,
        "expiresAt": p.expires_at,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Accept {
    grant_expires_in_seconds: i64,
    provider_label: String,
}

async fn accept_pairing(
    State(st): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<Accept>,
) -> ApiResult<Json<Value>> {
    let desktop_id = auth_desktop(&st, &headers)?;
    let now = Utc::now();
    let gmax = st.cfg.limits.grant_ttl_max_secs.max(60);
    let ttl = req.grant_expires_in_seconds.clamp(60, gmax);
    let mut rt = st.rt.lock().unwrap();
    let p = rt
        .pairings
        .get_mut(&id)
        .filter(|p| p.claimed_by.as_deref() == Some(&desktop_id))
        .ok_or_else(|| ApiError::not_found("pairing"))?;
    if p.effective_status(now) != PairingStatus::Claimed {
        return Err(ApiError::new(StatusCode::GONE, "ticket_expired", "This pairing request is no longer valid"));
    }
    let row = ConnectionRow {
        id: ids::new_id("conn"),
        service_id: p.service_id.clone(),
        desktop_id: desktop_id.clone(),
        external_user_id: p.external_user_id.clone(),
        scopes: p.scopes.clone(),
        provider_label: req.provider_label.chars().take(64).collect(),
        status: "active".into(),
        expires_at: now + Duration::seconds(ttl),
        created_at: now,
    };
    st.store.lock().unwrap().insert_connection(&row).map_err(|_| ApiError::internal())?;
    p.status = PairingStatus::Accepted;
    p.connection_id = Some(row.id.clone());
    Ok(Json(json!({"connectionId": row.id, "expiresAt": row.expires_at})))
}

async fn reject_pairing(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let desktop_id = auth_desktop(&st, &headers)?;
    let mut rt = st.rt.lock().unwrap();
    let p = rt
        .pairings
        .get_mut(&id)
        .filter(|p| p.claimed_by.as_deref() == Some(&desktop_id))
        .ok_or_else(|| ApiError::not_found("pairing"))?;
    if p.status == PairingStatus::Claimed {
        p.status = PairingStatus::Rejected;
    }
    Ok(Json(json!({"ok": true})))
}

// ---------- connections ----------

fn connection_json(st: &AppState, c: &ConnectionRow) -> Value {
    json!({
        "connectionId": c.id,
        "externalUserId": c.external_user_id,
        "status": c.effective_status(Utc::now()),
        "online": st.is_online(&c.desktop_id),
        "provider": c.provider_label,
        "scopes": c.scopes,
        "expiresAt": c.expires_at,
        "createdAt": c.created_at,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListConnections {
    external_user_id: String,
}

async fn list_connections(
    State(st): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<ListConnections>,
) -> ApiResult<Json<Value>> {
    let svc = auth_service(&st, &headers)?;
    let rows = st
        .store
        .lock()
        .unwrap()
        .connections_for_user(&svc.id, &q.external_user_id)
        .map_err(|_| ApiError::internal())?;
    let list: Vec<Value> = rows.iter().map(|c| connection_json(&st, c)).collect();
    Ok(Json(json!({"connections": list})))
}

fn load_service_connection(st: &AppState, svc: &ServiceConfig, id: &str) -> ApiResult<ConnectionRow> {
    st.store
        .lock()
        .unwrap()
        .connection(id)
        .map_err(|_| ApiError::internal())?
        .filter(|c| c.service_id == svc.id)
        .ok_or_else(|| ApiError::not_found("connection"))
}

async fn get_connection(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let svc = auth_service(&st, &headers)?;
    let c = load_service_connection(&st, svc, &id)?;
    Ok(Json(connection_json(&st, &c)))
}

/// Either the owning service or the owning desktop may revoke.
async fn revoke_connection(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let conn = if let Ok(svc) = auth_service(&st, &headers) {
        load_service_connection(&st, svc, &id)?
    } else {
        let desktop_id = auth_desktop(&st, &headers)?;
        st.store
            .lock()
            .unwrap()
            .connection(&id)
            .map_err(|_| ApiError::internal())?
            .filter(|c| c.desktop_id == desktop_id)
            .ok_or_else(|| ApiError::not_found("connection"))?
    };
    st.store.lock().unwrap().set_connection_status(&id, "revoked").map_err(|_| ApiError::internal())?;
    {
        let limits = st.cfg.limits.clone();
        let mut rt = st.rt.lock().unwrap();
        let ids: Vec<String> = rt
            .tasks
            .values()
            .filter(|t| t.connection_id == id && !t.state.is_terminal())
            .map(|t| t.id.clone())
            .collect();
        for tid in ids {
            AppState::finish_task(
                &mut rt,
                &tid,
                RelayTaskState::Cancelled,
                Some("cancelled".into()),
                Some(("connection_revoked".into(), "The connection was revoked".into())),
                &limits,
            );
        }
    }
    let mut env = Envelope::new(Body::Revoke(bridge_protocol::Revoke {
        reason: "revoked".into(),
    }));
    env.connection_id = Some(id.clone());
    st.send_to_desktop(&conn.desktop_id, &env);
    Ok(Json(json!({"ok": true})))
}

// ---------- tasks ----------

/// Unknown fields are rejected so a client never silently loses semantics
/// (e.g. `instructions`/`tools` sent to a relay that doesn't support them).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTask {
    connection_id: String,
    external_user_id: String,
    prompt: String,
    idempotency_key: String,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    tools: Vec<bridge_protocol::McpServer>,
}

async fn create_task(State(st): State<Shared>, headers: HeaderMap, Json(req): Json<CreateTask>) -> ApiResult<(StatusCode, Json<Value>)> {
    let svc = auth_service(&st, &headers)?;
    if req.idempotency_key.is_empty() || req.idempotency_key.len() > 128 {
        return Err(ApiError::bad("invalid_idempotency_key", "idempotencyKey is required"));
    }
    if req.prompt.trim().is_empty() {
        return Err(ApiError::bad("empty_prompt", "prompt is required"));
    }
    if req.prompt.len() > MAX_PROMPT_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "prompt_too_large", "Prompt is too large"));
    }
    if req.instructions.as_ref().map(|i| i.len() > bridge_protocol::MAX_INSTRUCTIONS_BYTES).unwrap_or(false) {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "instructions_too_large", "Instructions are too large"));
    }
    if req.tools.len() > bridge_protocol::MAX_TOOL_SERVERS {
        return Err(ApiError::bad("invalid_tools", "Too many tool servers"));
    }
    for t in &req.tools {
        if let Err(e) = t.validate() {
            return Err(ApiError::bad("invalid_tools", e));
        }
    }
    let request_hash = ids::sha256_hex(&format!(
        "{}\n{}\n{}\n{}\n{}",
        req.connection_id,
        req.external_user_id,
        req.prompt,
        req.instructions.as_deref().unwrap_or(""),
        serde_json::to_string(&req.tools).unwrap_or_default()
    ));
    // Idempotency: same key returns the original task; a different body conflicts.
    {
        let rt = st.rt.lock().unwrap();
        if let Some(tid) = rt.idempotency.get(&(svc.id.clone(), req.idempotency_key.clone())) {
            if let Some(t) = rt.tasks.get(tid) {
                if t.request_hash != request_hash {
                    return Err(ApiError::new(StatusCode::CONFLICT, "idempotency_conflict", "idempotencyKey reused with a different request"));
                }
                return Ok((StatusCode::OK, Json(t.summary())));
            }
        }
    }
    if !st.rate_ok(&format!("task:{}", svc.id), st.cfg.limits.tasks_per_minute_per_service) {
        return Err(ApiError::rate());
    }
    let conn = load_service_connection(&st, svc, &req.connection_id)?;
    // Cross-user protection: the service must assert the same end user the
    // desktop consented to.
    if conn.external_user_id != req.external_user_id {
        return Err(ApiError::not_found("connection"));
    }
    match conn.effective_status(Utc::now()) {
        "active" => {}
        "paused" => return Err(ApiError::new(StatusCode::CONFLICT, "connection_paused", "The user paused this connection")),
        "expired" => return Err(ApiError::new(StatusCode::GONE, "connection_expired", "The connection has expired")),
        _ => return Err(ApiError::new(StatusCode::GONE, "connection_revoked", "The connection was revoked")),
    }
    if !conn.scopes.iter().any(|s| s == scopes::TASK_INTERACTIVE) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "missing_scope", "Connection lacks task.interactive"));
    }
    if !req.tools.is_empty() && !conn.scopes.iter().any(|s| s == scopes::AGENT_TOOLS) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "missing_scope", "The user did not allow this site to add tools (scope agent.tools)"));
    }
    if !st.is_online(&conn.desktop_id) {
        return Err(ApiError::new(StatusCode::CONFLICT, "desktop_offline", "The desktop app is not connected"));
    }
    let task_id = ids::new_id("task");
    let env = Envelope::for_task(
        Body::TaskStart(TaskStart {
            external_user_id: req.external_user_id.clone(),
            input: vec![InputBlock::Text { text: req.prompt.clone() }],
            mode: TaskMode::Interactive,
            service_id: svc.id.clone(),
            instructions: req.instructions.clone().filter(|i| !i.trim().is_empty()),
            tools: req.tools.clone(),
        }),
        &conn.id,
        &task_id,
        0,
    );
    let summary = {
        let mut rt = st.rt.lock().unwrap();
        // One active task per connection (strong default).
        if rt
            .tasks
            .values()
            .any(|t| t.connection_id == conn.id && !t.state.is_terminal())
        {
            return Err(ApiError::new(StatusCode::CONFLICT, "task_in_progress", "A task is already running on this connection"));
        }
        let (tx, _) = broadcast::channel(1024);
        let rec = TaskRec {
            id: task_id.clone(),
            service_id: svc.id.clone(),
            connection_id: conn.id.clone(),
            desktop_id: conn.desktop_id.clone(),
            external_user_id: req.external_user_id.clone(),
            idempotency_key: req.idempotency_key.clone(),
            request_hash,
            state: RelayTaskState::Pending,
            stop_reason: None,
            error: None,
            events: vec![],
            buffered_bytes: 0,
            buffer_truncated: false,
            last_desktop_seq: 0,
            next_seq: 1,
            notify: tx,
            created_at: Utc::now(),
            finished_at: None,
            cancel_requested: false,
        };
        let s = rec.summary();
        rt.tasks.insert(task_id.clone(), rec);
        rt.idempotency.insert((svc.id.clone(), req.idempotency_key), task_id.clone());
        s
    };
    // At-most-once dispatch: task.start is never re-sent.
    if !st.send_to_desktop(&conn.desktop_id, &env) {
        let limits = st.cfg.limits.clone();
        let mut rt = st.rt.lock().unwrap();
        AppState::finish_task(
            &mut rt,
            &task_id,
            RelayTaskState::Failed,
            None,
            Some(("desktop_offline".into(), "The desktop app is not connected".into())),
            &limits,
        );
        let s = rt.tasks.get(&task_id).map(|t| t.summary()).unwrap_or(summary);
        return Ok((StatusCode::CREATED, Json(s)));
    }
    Ok((StatusCode::CREATED, Json(summary)))
}

fn with_service_task<T>(st: &AppState, svc: &ServiceConfig, id: &str, f: impl FnOnce(&mut TaskRec) -> T) -> ApiResult<T> {
    let mut rt = st.rt.lock().unwrap();
    let t = rt
        .tasks
        .get_mut(id)
        .filter(|t| t.service_id == svc.id)
        .ok_or_else(|| ApiError::not_found("task"))?;
    Ok(f(t))
}

async fn get_task(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let svc = auth_service(&st, &headers)?;
    Ok(Json(with_service_task(&st, svc, &id, |t| t.summary())?))
}

async fn cancel_task(State(st): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let svc = auth_service(&st, &headers)?;
    let (desktop, conn, terminal) = with_service_task(&st, svc, &id, |t| {
        t.cancel_requested = true;
        (t.desktop_id.clone(), t.connection_id.clone(), t.state.is_terminal())
    })?;
    if !terminal {
        let env = Envelope::for_task(Body::TaskCancel(Default::default()), &conn, &id, 0);
        if !st.send_to_desktop(&desktop, &env) {
            let limits = st.cfg.limits.clone();
            let mut rt = st.rt.lock().unwrap();
            AppState::finish_task(&mut rt, &id, RelayTaskState::Cancelled, Some("cancelled".into()), None, &limits);
        }
    }
    Ok(Json(json!({"ok": true, "alreadyFinished": terminal})))
}

fn sse_event(e: &StoredEvent) -> Event {
    Event::default()
        .id(e.seq.to_string())
        .event(e.kind.clone())
        .data(json!({"seq": e.seq, "kind": e.kind, "payload": e.payload}).to_string())
}

async fn task_events(
    State(st): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let svc = auth_service(&st, &headers)?;
    let after: u64 = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let (backlog, mut rx, terminal, truncated_gap) = with_service_task(&st, svc, &id, |t| {
        let first = t.events.first().map(|e| e.seq).unwrap_or(t.next_seq);
        let gap = t.buffer_truncated && after + 1 < first;
        let backlog: Vec<StoredEvent> = t.events.iter().filter(|e| e.seq > after).cloned().collect();
        (backlog, t.notify.subscribe(), t.state.is_terminal(), gap)
    })?;
    let stream = async_stream::stream! {
        if truncated_gap {
            yield Ok(Event::default().event("error").data(json!({"code":"resume_unavailable","message":"Some earlier events are no longer available"}).to_string()));
        }
        let mut last = after;
        let mut done = false;
        for e in backlog {
            last = e.seq;
            let fin = matches!(e.kind.as_str(), "task.completed" | "task.failed" | "task.rejected");
            yield Ok(sse_event(&e));
            if fin { done = true; }
        }
        if !done && !terminal {
            loop {
                match rx.recv().await {
                    Ok(e) => {
                        if e.seq <= last { continue; }
                        last = e.seq;
                        let fin = matches!(e.kind.as_str(), "task.completed" | "task.failed" | "task.rejected");
                        yield Ok(sse_event(&e));
                        if fin { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        yield Ok(Event::default().event("error").data(json!({"code":"lagged","message":"Reconnect with Last-Event-ID to resume"}).to_string()));
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(StdDuration::from_secs(15))))
}
