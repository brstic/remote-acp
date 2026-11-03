# Minimal integration — EXAMPLE

The smallest useful Remote ACP Bridge website integration, written to be **read top to bottom as a
tutorial**:

- [`src/server.ts`](src/server.ts) (~180 lines, mostly comments) — plain `node:http` backend using
  `@remote-acp/web-sdk`: create the client → create a pairing → wait for the user to accept →
  start a task → re-stream its events as Server-Sent Events → cancel.
- [`public/index.html`](public/index.html) + [`public/app.js`](public/app.js) — zero-build vanilla JS:
  **Connect** → link + code (rendered with `@remote-acp/browser-helper`) → wait for approval →
  textbox → streamed answer → **Cancel**.

To stay tiny it has **one fixed demo user and no sign-in**: anyone who can open the page acts as that
user. A real website must derive `externalUserId` from its own authenticated session (see
`examples/code-review-assistant` or `examples/docs-generator` for per-user sessions and isolation).
What it does keep: the service secret stays on the server, a strict CSP, a same-origin check on POSTs,
and only tasks this server started can be streamed or cancelled.

## Relay registration (DEV ONLY)

`relay.dev.json` registers service `svc_minimal` ("Minimal Integration (example)", origin
`http://localhost:3101`, verification `operator`) with the SHA-256 of this **development-only** secret:

```
dev-only-minimal-integration-secret-0123456789
```

(`remote-acp-relay hash-secret dev-only-minimal-integration-secret-0123456789` → `b62f9bfc…689e`).
Never use it anywhere else; create real secrets with `remote-acp-relay new-secret`.

## Run it

```sh
source ~/.cargo/env
pnpm install

# terminal 1 — relay on 127.0.0.1:8787 with svc_minimal (SQLite file in this folder)
pnpm --filter @remote-acp/example-minimal-integration relay

# terminal 2 — the example on http://localhost:3101 (builds the SDK + helper first)
pnpm --filter @remote-acp/example-minimal-integration dev
```

Only one process can listen on 8787. If another example's relay already runs there, stop it, or add the
`svc_minimal` entry from `relay.dev.json` to that relay's config — one relay can register many websites.

Then open http://localhost:3101, click **Connect** and approve in the **Remote ACP Bridge** desktop app
(relay set to `http://127.0.0.1:8787`; pick a project folder and an agent — the *Test agent* needs no AI
account). Ask a question; with Codex or Claude Code the default prompt gives a real project overview.

| env | default |
| --- | --- |
| `RELAY_URL` | `http://127.0.0.1:8787` |
| `REMOTE_ACP_SERVICE_ID` | `svc_minimal` |
| `REMOTE_ACP_SERVICE_SECRET` | required (`pnpm dev` sets the dev secret) |
| `PORT` / `HOST` | `3101` / `127.0.0.1` |

Without the desktop app you can use the headless test desktop (test harness only, auto-approves):

```sh
cargo build -p e2e-tests && mkdir -p /tmp/minimal-ws
RELAY_URL=http://127.0.0.1:8787 WORKSPACE=/tmp/minimal-ws MOCK_AGENT=$PWD/target/debug/mock-acp-agent \
  target/debug/e2e-desktop     # paste the pairing link (right-click the button → copy link) and press Enter
```

## Test

`pnpm --filter @remote-acp/example-minimal-integration test` (after building) starts the real relay
binary, the headless desktop with the mock agent and the built server on free ports, then drives the
server's HTTP API: CSP + cross-origin refusal, connect → pairing link fed to the desktop → accepted,
streamed answer (exact echo text) + `Last-Event-ID` resume, cancel of a `slow` task, and 404 for tasks
it did not start. It reuses the harness in `tests/node-e2e/test`.
