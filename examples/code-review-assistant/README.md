# Code Review Assistant — EXAMPLE

A "review my project" product built on Remote ACP Bridge. The user picks a review type — **Security
review**, **Bug hunt**, **Explain architecture** or **Test plan** — optionally adds focus notes, and the
review runs on **their own desktop agent** (Codex, Claude Code or the Test agent) in the project folder
they chose. The website only receives the streamed report.

What it demonstrates:

- **Server-built structured prompts** ([`src/reviews.ts`](src/reviews.ts)). The browser only sends a
  review type id and free-text notes; notes are cleaned, capped at 2000 characters and fenced as data.
  Prompts ask for a read-only review with a fixed Markdown report format.
- **Server-side collector + fan-out** ([`src/app.ts`](src/app.ts)). The server consumes each task's
  relay event stream once (`streamEvents`), keeps the events in memory (bounded), and serves them to any
  number of browser tabs over SSE with `Last-Event-ID` replay — so finished reviews stay viewable and a
  reload never loses the report.
- **Report page**: live streaming Markdown rendered safely ([`public/render.js`](public/render.js) builds
  DOM nodes with `textContent` only — no `innerHTML`, no links), the agent plan as a checklist, tool
  calls and status changes as a timeline, final status, **Copy report** (Markdown), **Cancel**, and the
  exact prompt that was sent.
- **History** of this session's reviews (server memory, 20 per user).
- Mock sign-in (any username) with an `HttpOnly; SameSite=Lax` session cookie; `externalUserId` and the
  connection are derived server-side; every review route checks ownership (other users get 404);
  same-origin check on writes; strict CSP (`script-src 'self'`, no inline code).

Use **Read only** access when you connect in the desktop app — the review never needs to write.

## Relay registration (DEV ONLY)

`relay.dev.json` registers `svc_code_review` ("Code Review Assistant (example)", origin
`http://localhost:3102`, verification `operator`) with the SHA-256 of this **development-only** secret:

```
dev-only-code-review-assistant-secret-0123456789
```

(`remote-acp-relay hash-secret …` → `5051dae8…60ca`). Never use it outside local development.

## Run it

```sh
source ~/.cargo/env
pnpm install
pnpm --filter @remote-acp/example-code-review-assistant relay   # terminal 1: relay on 127.0.0.1:8787
pnpm --filter @remote-acp/example-code-review-assistant dev     # terminal 2: http://localhost:3102
```

Only one relay can listen on 8787; if another example's relay is running, stop it or copy the
`svc_code_review` entry into that relay's config (one relay can register many websites).

Open http://localhost:3102, sign in with any name, **Connect desktop agent**, approve in Remote ACP
Bridge (project folder + *Read only*), pick a review type and **Run review on my computer**. Approve the
task in the desktop app when it asks.

| env | default |
| --- | --- |
| `RELAY_URL` | `http://127.0.0.1:8787` |
| `REMOTE_ACP_SERVICE_ID` | `svc_code_review` |
| `REMOTE_ACP_SERVICE_SECRET` | required (`pnpm dev` sets the dev secret) |
| `PORT` / `HOST` | `3102` / `127.0.0.1` |
| `COOKIE_SECURE` | set `1` behind https |

## Tests

```sh
pnpm --filter @remote-acp/example-code-review-assistant test
```

- `test/reviews.test.ts` — prompt structure, note cleaning, type allowlist, and that the templates avoid
  the Test agent's scenario keywords so the E2E echo is deterministic.
- `test/e2e.test.ts` — real relay binary + headless desktop (mock agent) + built server on free ports,
  driven through the server's API: sign-in, pairing, streamed security review (the mock echoes the
  server-built prompt, so the test checks the prompt and focus notes arrive), plan + approval status,
  server-side replay and `Last-Event-ID` resume, history, user isolation, `task_in_progress` for a
  second concurrent review, cancel, `policy_blocked` from the desktop's output firewall, Disconnect.

## Website instructions

Every review is started with `instructions` (see `REVIEWER_INSTRUCTIONS` in `src/app.ts`). The
bridge appends them to the agent's system prompt, and the desktop shows them on the task under
*Customized by Code Review Assistant*. See the integration guide's "Your own system instructions
and tools" section for tools (MCP servers).
