# Bridge protocol v1

Not an ACP network transport. JSON envelopes over WSS between relay and desktop:

```json
{"version":1,"id":"msg_…","connectionId":"conn_…","taskId":"task_…","sequence":3,
 "createdAt":"2026-11-02T19:00:00Z","kind":"task.event","payload":{"type":"text_delta","text":"Hi"}}
```

Relay → desktop: `connection.ready`, `connection.revoke`, `task.start`, `task.cancel`, `heartbeat`, `error`.
Desktop → relay: `connection.hello`, `connection.revoke`, `connection.state`, `task.accepted`, `task.rejected`, `task.event`, `task.completed`, `task.failed`, `heartbeat`, `error`.
Anything else is rejected. Task events: `status`, `text_delta`, `thought_delta`, `plan`, `tool_call`, `tool_call_update`, `permission_pending`, `permission_resolved`.

Limits: frame 1 MiB, prompt 64 KiB, text delta 256 KiB, ids `[A-Za-z0-9_.:-]{1,128}`. Contract fixtures: `tests/contract/*.json` (checked by Rust and TS tests).

## Service REST API (auth `Bearer <serviceId>.<secret>`)
| Method | Path | Notes |
|---|---|---|
| POST | /v1/pairings | `{externalUserId, scopes?, expiresInSeconds?}` → `{pairingId, url, code, expiresAt}` |
| GET | /v1/pairings/{id} | `status`: pending, claimed, accepted, rejected, expired; `connectionId` |
| GET | /v1/connections?externalUserId= | own connections for that user |
| GET | /v1/connections/{id} | status active/paused/revoked/expired, `online` |
| POST | /v1/connections/{id}/revoke | |
| POST | /v1/tasks | `{connectionId, externalUserId, prompt, idempotencyKey}` → 201 (200 on idempotent replay) |
| GET | /v1/tasks/{id} | summary |
| POST | /v1/tasks/{id}/cancel | |
| GET | /v1/tasks/{id}/events | SSE, `id` = seq, supports `Last-Event-ID`; ends after terminal event |

Errors: `{"error":{"code","message"}}` — e.g. `desktop_offline`, `connection_revoked`, `connection_paused`, `connection_expired`, `task_in_progress`, `idempotency_conflict`, `rate_limited`.

Desktop endpoints: `POST /v1/desktops/register`, `POST /v1/pairings/redeem`, `POST /v1/pairings/{id}/accept|reject`, `POST /v1/connections/{id}/revoke`, `GET /v1/desktop` (WebSocket).
