# Acme Notes — DEMO web integration

A minimal, clearly-labelled **demo** SaaS showing how a website integrates Remote ACP Bridge:

- mock sign-in (pick any username — **demo only**, no passwords; server-side session in an
  `HttpOnly; SameSite=Lax` cookie),
- "Connect desktop agent" → one-time `remoteacp://` link (button) + code + expiry countdown,
  rendered with `@remote-acp/browser-helper`,
- honest pairing states: waiting / confirm on desktop / connected (provider, online, paused) /
  declined / expired / revoked,
- chat-like task UI: streaming text, plan checklist, tool-call chips, "waiting for approval on
  your desktop", "permission requested on your desktop" (the website can only **observe**
  permissions), Cancel, final status and friendly errors (`desktop_offline`,
  `connection_revoked`, `connection_paused`, `task_in_progress`, ...),
- Disconnect (revokes the connection on the relay).

The browser only talks to this server. The server holds the relay credentials, uses
`@remote-acp/web-sdk`, derives `externalUserId` (`acme-demo:<username>`) and the connection from
the session, only serves task status/cancel/events for tasks the signed-in user started, refuses
cross-origin mutations, and re-streams relay SSE to the browser (`EventSource` reconnects send
`Last-Event-ID`, which is forwarded to the relay). Plain Node `http`, no framework; the UI is
vanilla JS + CSS (light/dark).

## Configuration

| env | default | |
| --- | --- | --- |
| `RELAY_URL` | `http://127.0.0.1:8787` | https required unless localhost |
| `REMOTE_ACP_SERVICE_ID` | `svc_demo` | |
| `REMOTE_ACP_SERVICE_SECRET` | — (required; `pnpm dev` defaults it to the dev secret) | |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | |
| `COOKIE_SECURE` | unset | set `1` behind https |

`relay.dev.json` registers `svc_demo` ("Acme Notes (demo)", origin `http://localhost:3000`,
verification `operator`) with the SHA-256 of this **development-only** secret:

```
dev-only-acme-notes-secret-0123456789abcdef
```

(`remote-acp-relay hash-secret dev-only-acme-notes-secret-0123456789abcdef` →
`a46dd2a8…980c`). Never use it outside local development; create real ones with
`remote-acp-relay new-secret`.

## Run it

```sh
source ~/.cargo/env
pnpm install

# terminal 1 — relay on 127.0.0.1:8787 (SQLite file relay.dev.sqlite3 in this folder)
pnpm --filter @remote-acp/web-demo relay

# terminal 2 — demo on http://localhost:3000 (builds the SDK + helper first)
pnpm --filter @remote-acp/web-demo dev
```

Then open http://localhost:3000, sign in, click **Connect desktop agent** and approve in the
Remote ACP Bridge desktop app (configured with relay `http://127.0.0.1:8787`).

### Without the desktop app (headless test desktop)

The repo's test harness desktop runs the real bridge core with the deterministic mock agent and
auto-approves. **Test use only.**

```sh
cargo build -p e2e-tests
mkdir -p /tmp/acme-ws
RELAY_URL=http://127.0.0.1:8787 WORKSPACE=/tmp/acme-ws \
MOCK_AGENT=$PWD/target/debug/mock-acp-agent PERMISSION_CHOICE=allow_once \
  target/debug/e2e-desktop
# copy the link from the "Open Remote ACP Bridge" button (right-click → copy link),
# paste it into this terminal and press Enter.
```

Prompts the mock agent understands: anything (echo), `permission`, `slow` (cancellable).

## Tests

- `pnpm --filter @remote-acp/web-demo test` — session/isolation rules with a mocked relay.
- `tests/node-e2e` — drives this server end-to-end against the real relay + desktop.
