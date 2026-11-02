# Architecture

```
Website backend ──HTTPS (REST + SSE)──▶ Relay ◀──WSS (outbound)── Desktop app
 (@remote-acp/web-sdk)                (apps/relay)              (apps/desktop: Tauri + bridge-core)
                                                                    │ ACP v1, JSON-RPC over stdio
                                                                    ▼
                                                        codex-acp / claude-agent-acp / test agent
```

| Crate / package | Role |
|---|---|
| `crates/bridge-protocol` | Versioned envelope (`task.start`, `task.event`, …), validation, sender allowlists, id/secret helpers |
| `crates/agent-host` | ACP v1 client: subprocess lifecycle, NDJSON framing with limits, request correlation, backpressure, permission/fs callbacks; deterministic mock agent |
| `crates/connection-policy` | Workspace confinement, grants, task authorization |
| `crates/bridge-core` | Desktop engine: relay client (register, WSS loop, reconnect), task broker and state machine, sessions, permissions, providers registry + policy, SQLite store, keychain |
| `apps/relay` | Axum relay: service registry, pairing, connections (SQLite), task routing, SSE buffer, sweeper |
| `apps/desktop` | Tauri 2 shell + React UI; deep links (`remoteacp://`), tray, notifications |
| `packages/web-sdk` | Server-side TypeScript SDK for websites |
| `packages/browser-helper` | Browser helpers for the pairing link/code |
| `examples/web-demo` | Demo website |
| `tests/e2e` | In-process relay + headless bridge E2E suite; `e2e-desktop` harness for the Node SDK test |

## Task flow
1. Service `POST /v1/tasks` → relay checks auth, ownership, user binding, status, online, single active task, idempotency → sends `task.start` once.
2. Desktop re-checks the grant (`authorize_task`), provider readiness and policy, then asks the user (if enabled).
3. Desktop sends `task.accepted`, gets/creates the ACP session in the restricted mode, runs `session/prompt`.
4. `session/update`s are mapped to sanitized `task.event`s with per-task sequence numbers; permission prompts are shown locally and only their status is forwarded.
5. `task.completed` / `task.failed` / `task.rejected` closes the SSE stream.

State machines are in `bridge_protocol::TaskState::can_transition_to` (terminal states monotonic).
