# Docs Generator — EXAMPLE

"Generate a README / CONTRIBUTING / CHANGELOG for my project." The website asks the user's own desktop
agent to **write one file** into the project folder they chose in Remote ACP Bridge. Writing a file
triggers a **local permission prompt** in the desktop app — this example is about that flow and about
handling every error the relay or desktop can return.

What it demonstrates:

- **Permission flow, observed only.** When the agent asks to write, the relay stream carries
  `task.event` `permission_pending` (`requestId`, `title`). The UI shows *"Waiting for your approval in
  Remote ACP Bridge"* and explains that the website cannot approve on the user's behalf — there is no
  API for it. `permission_resolved` reports the outcome (`allowed` / `denied` / `cancelled`), which the
  UI shows together with the final result ("check README.md in your project folder" vs "nothing was
  changed").
- **Friendly errors** ([`src/errors.ts`](src/errors.ts)), produced by the server so every client shows
  the same text: `desktop_offline`, `connection_revoked`, `connection_paused`, `connection_expired`,
  `task_in_progress` (relay errors on start), `declined`, `approval_timeout`, `bridge_paused`
  (`task.rejected` codes), `policy_blocked` (`task.failed`, the desktop's safety checks), and more. Error
  responses carry `{code, title, message, reconnect}`; failed/rejected SSE events get a `friendly` field.
  The server deliberately does not pre-check paused/offline: the relay is the source of truth.
- **Connection status** via `getConnection`: `online`, `offline`, `paused`, `revoked`, `expired` (shown
  with a Refresh button and polled), and **Disconnect** via `revokeConnection`.
- Per-user mock sign-in, server-side ownership of jobs, same-origin checks, strict CSP, SSE proxy with
  `Last-Event-ID`.

Connect with **Can edit** access in the desktop app (with *Read only* the agent runs in its read-only mode and may be unable to write).

## Relay registration (DEV ONLY)

`relay.dev.json` registers `svc_docs_generator` ("Docs Generator (example)", origin
`http://localhost:3103`, verification `operator`) with the SHA-256 of this **development-only** secret:

```
dev-only-docs-generator-secret-0123456789
```

(`remote-acp-relay hash-secret …` → `045780af…03fd`). Never use it outside local development.

## Run it

```sh
source ~/.cargo/env
pnpm install
pnpm --filter @remote-acp/example-docs-generator relay   # terminal 1: relay on 127.0.0.1:8787
pnpm --filter @remote-acp/example-docs-generator dev     # terminal 2: http://localhost:3103
```

Only one relay can listen on 8787; if another example's relay is running, stop it or copy the
`svc_docs_generator` entry into that relay's config.

Open http://localhost:3103, sign in, **Connect desktop agent**, approve in Remote ACP Bridge (project
folder + *Can edit*), pick a document and **Generate on my computer**. Approve the task, then answer
the write prompt in the desktop app — try both *Allow* and *Deny*. Pause or revoke the website in the
desktop app, or quit it, to see the error states.

| env | default |
| --- | --- |
| `RELAY_URL` | `http://127.0.0.1:8787` |
| `REMOTE_ACP_SERVICE_ID` | `svc_docs_generator` |
| `REMOTE_ACP_SERVICE_SECRET` | required (`pnpm dev` sets the dev secret) |
| `PORT` / `HOST` | `3103` / `127.0.0.1` |
| `COOKIE_SECURE` | set `1` behind https |

## Tests

```sh
pnpm --filter @remote-acp/example-docs-generator test
```

- `test/unit.test.ts` — friendly messages for every code (including `connection_paused` and `declined`,
  which the headless test desktop cannot produce), connection-state mapping, prompt rules.
- `test/e2e.test.ts` — real relay binary + **two** headless desktops (`PERMISSION_CHOICE=allow_once` and
  `deny`) + built server: `permission_pending` → `permission_resolved(allowed)` and the file really
  written in the workspace; `permission_resolved(denied)` and no file; user isolation;
  `task_in_progress` + cancel; `policy_blocked` with its friendly title; `connection_revoked` after a
  revocation elsewhere (status `revoked`); `desktop_offline` after the desktop process exits (status
  `offline`); Disconnect → `revoked`.

With the Test agent the prompt's mention of "permission" selects the mock's write scenario, which
writes `mock-output.txt` (not `README.md`) — real agents write the requested file.
