# Integrating Remote ACP Bridge into an existing website

This guide shows how to add **"Use your own AI agent"** to a website you already run. Your users keep
Codex or Claude Code on their own computer. Your site sends them tasks and shows the results live. The
agent runs locally, under the user's own sign-in, inside a project folder they choose.

> Working examples to copy from:
> - `examples/minimal-integration`: the smallest complete integration, written to be read top to bottom
> - `examples/code-review-assistant`: a real product flow (structured prompts, streamed report, plan, tool timeline)
> - `examples/docs-generator`: tasks that write files, local permission prompts, error handling and disconnecting
> - `examples/web-demo`: a chat-style demo with multiple users

---

## 1. How it fits together

```
 Browser ──(your own API)──▶ Your backend ──HTTPS + SSE──▶ Relay ◀──WSS (outbound)── Remote ACP Bridge app
                              @remote-acp/web-sdk                                       │ ACP over stdio
                                                                                        ▼
                                                                           Codex / Claude Code on the user's computer
```

- **Your backend** is the only component that talks to the relay. It holds the service secret.
- **The browser** only talks to your backend. Never give it the service secret, and never let it call the relay directly.
- **The relay** routes messages between your backend and paired desktops. It stores no prompts and no results.
- **The desktop app** decides everything that happens locally: which agent runs, which folder it can use, and what needs approval.

What your site **can** do: start interactive tasks for a user who connected, stream progress (text,
plan, tool calls, permission status), cancel tasks, check and revoke the connection.

What your site **cannot** do: run shell commands, read files outside the folder the user chose,
answer permission prompts, choose the agent, or see the user's AI sign-in. These limits are enforced
on the desktop. Design your UX around them (see §7).

---

## 2. Prerequisites

| You need | Notes |
|---|---|
| Node.js 20+ backend | Any framework. The SDK is plain `fetch` with zero dependencies. Other languages can call the REST API directly (§9). |
| A relay | Run your own (`docs/deployment.md`) or use one you trust. It must be served over `https` in production. |
| A service registration on the relay | A service id, a secret, and your site's origin (§3). |
| Users with the desktop app | They install Remote ACP Bridge, then set up Codex and/or Claude Code in *AI Providers*. |

Install the packages (from this repo, or your registry once published):

```sh
pnpm add @remote-acp/web-sdk          # backend
pnpm add @remote-acp/browser-helper   # optional, browser UI for pairing
```

---

## 3. Register your site on the relay

1. Generate a secret:
   ```sh
   remote-acp-relay new-secret
   # secret:       3J0t…            -> goes into your backend's environment
   # secretSha256: 9f2c…            -> goes into relay.json
   ```
2. Add your service to the relay's `relay.json` and restart the relay:
   ```json
   {
     "id": "svc_yourapp",
     "displayName": "Your App",
     "origin": "https://app.example.com",
     "secretSha256": "9f2c…",
     "verification": "well_known"
   }
   ```
3. Prove you own the domain (`verification: "well_known"`). Serve this file:
   ```
   GET https://app.example.com/.well-known/remote-acp.json
   {"serviceId": "svc_yourapp"}
   ```
   Desktops show **Verified domain** for verified services. Unverified services get a red warning.
   During local development, use `"verification": "operator"` or `"unverified"`.
4. Configure your backend:
   ```sh
   REMOTE_ACP_RELAY_URL=https://relay.example.com
   REMOTE_ACP_SERVICE_ID=svc_yourapp
   REMOTE_ACP_SERVICE_SECRET=3J0t…
   ```

---

## 4. Create the client (backend)

```ts
// server/remote-acp.ts
import { RemoteAcp } from "@remote-acp/web-sdk";

export const bridge = new RemoteAcp({
  serviceId: process.env.REMOTE_ACP_SERVICE_ID!,
  serviceSecret: process.env.REMOTE_ACP_SERVICE_SECRET!,
  relayUrl: process.env.REMOTE_ACP_RELAY_URL!,
});
```

**Identify users with your own user id.** Every call takes an `externalUserId`. Use your stable,
internal user id (not an email address, not anything typed in the browser). The relay binds each
connection to that id. A connection made by user A can never be used with user B's id.

---

## 5. Pairing: "Connect desktop agent"

Pairing happens once per user (until the user disconnects or the connection expires).

### Backend

```ts
// POST /api/remote-acp/pairings   (requires a signed-in user)
app.post("/api/remote-acp/pairings", requireUser, async (req, res) => {
  const p = await bridge.createPairing({ externalUserId: req.user.id, expiresInSeconds: 120 });
  // Remember which pairing belongs to which user.
  await db.pairings.put({ userId: req.user.id, pairingId: p.pairingId });
  res.json({ url: p.url, code: p.code, expiresAt: p.expiresAt });   // safe for the browser
});

// GET /api/remote-acp/pairings/current
app.get("/api/remote-acp/pairings/current", requireUser, async (req, res) => {
  const row = await db.pairings.latestFor(req.user.id);
  const p = await bridge.getPairing(row.pairingId);
  if (p.status === "accepted") await db.users.setConnection(req.user.id, p.connectionId!);
  res.json({ status: p.status });   // pending | claimed | accepted | rejected | expired
});
```

You can also use `await bridge.waitForPairing(pairingId, { timeoutMs: 120_000 })` in a background
job instead of polling from the browser.

### Browser

```ts
import { renderPairing } from "@remote-acp/browser-helper";

const pairing = await (await fetch("/api/remote-acp/pairings", { method: "POST" })).json();
renderPairing(document.querySelector("#connect")!, pairing, {
  onExpire: () => showButton("The link expired. Try again."),
  onNotOpened: () => showHint("Install Remote ACP Bridge, then click the button again, or enter the code in the app."),
});
// Poll /api/remote-acp/pairings/current every ~2 s until accepted / rejected / expired.
```

`renderPairing` shows an **Open desktop app** button (a one-time `remoteacp://pair?ticket=…` link),
the 10-character code for manual entry, and a countdown. When the user clicks the button, the app
opens and shows your verified name and domain. The user then picks an agent, a project folder and
an access level, and clicks *Allow connection*.

Pairing statuses: `pending` (shown, not opened) → `claimed` (opened in the app, user is deciding) →
`accepted` (you now have a `connectionId`), `rejected`, or `expired`. Tickets are single use.

---

## 6. Running a task and streaming the result

### Start

```ts
// POST /api/remote-acp/tasks   { prompt }
app.post("/api/remote-acp/tasks", requireUser, async (req, res) => {
  const connectionId = await db.users.connectionOf(req.user.id);
  const task = await bridge.startTask({
    connectionId,
    externalUserId: req.user.id,
    prompt: buildPrompt(req.body),          // see §8
    idempotencyKey: req.get("Idempotency-Key") ?? crypto.randomUUID(),
  });
  await db.tasks.put({ taskId: task.taskId, userId: req.user.id });   // ownership for later checks
  res.status(201).json({ taskId: task.taskId });
});
```

- **Idempotency.** If the HTTP request is retried with the same `idempotencyKey`, you get the same
  task back. The relay never starts a task twice.
- **One task at a time per connection.** A second `startTask` while one is running fails with
  `task_in_progress`.

### Stream to the browser (SSE proxy)

Re-stream the relay's events to your own page. Check ownership first.

```ts
// GET /api/remote-acp/tasks/:id/events
app.get("/api/remote-acp/tasks/:id/events", requireUser, async (req, res) => {
  if (!(await db.tasks.ownedBy(req.params.id, req.user.id))) return res.sendStatus(404);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const abort = new AbortController();
  req.on("close", () => abort.abort());
  const lastEventId = Number(req.get("Last-Event-ID")) || undefined;   // EventSource reconnects send this
  try {
    for await (const ev of bridge.streamEvents(req.params.id, { lastEventId, signal: abort.signal })) {
      res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    }
  } catch (e) {
    if (!abort.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify({ code: e.code ?? "stream_error" })}\n\n`);
  }
  res.end();
});
```

`streamEvents` reconnects on its own after network drops and stalls, and never delivers an event twice.

### Events you will receive

| `kind` | `payload` | Show in your UI |
|---|---|---|
| `task.accepted` | `{}` | The task started on the user's computer |
| `task.event` `status` | `{state}` | `awaiting_approval` → "Waiting for you to approve in Remote ACP Bridge"; `running`; `cancelling` |
| `task.event` `text_delta` | `{text}` | Append to the answer |
| `task.event` `thought_delta` | `{text}` | Optional "thinking" text |
| `task.event` `plan` | `{entries:[{content,status,priority}]}` | Checklist (replace the previous plan) |
| `task.event` `tool_call` / `tool_call_update` | `{toolCallId,title,kind,status}` | Activity timeline ("Read README.md ✓") |
| `task.event` `permission_pending` | `{requestId,title}` | "Approve in Remote ACP Bridge: *Write README.md*" |
| `task.event` `permission_resolved` | `{requestId,outcome}` | `allowed` / `denied` / `cancelled` |
| `task.completed` | `{stopReason}` | Done. `end_turn` is normal, `cancelled` means it was stopped |
| `task.failed` | `{code,message}` | Error (§10) |
| `task.rejected` | `{code,message}` | The user declined, or policy refused (§10) |

Tool titles are already sanitized: local absolute paths are replaced with `./` and `~`. Render all
agent output as **untrusted text**: use `textContent` (or a sanitizing Markdown renderer), never raw `innerHTML`.

### Cancel

```ts
app.post("/api/remote-acp/tasks/:id/cancel", requireUser, async (req, res) => {
  if (!(await db.tasks.ownedBy(req.params.id, req.user.id))) return res.sendStatus(404);
  await bridge.cancelTask(req.params.id);
  res.json({ ok: true });   // the stream ends with task.completed { stopReason: "cancelled" }
});
```

### Multi-turn conversations

Tasks on the same connection reuse the same agent session while the user is active, so follow-up
prompts keep their context. The session closes after the user's idle timeout (15 minutes by default).

---

## 7. UX guidelines

- **Show desktop-side waits clearly.** Users approve tasks (if they chose "Ask before each task") and
  sensitive actions in the desktop app, not on your page. When you see `status: awaiting_approval` or
  `permission_pending`, say so, and say where.
- **Never imply your site approved something.** There is no API for answering permission prompts.
- **Connection state.** `bridge.getConnection(id)` returns `status` (`active`, `paused`, `revoked`,
  `expired`) and `online` (the desktop app is running and connected). Show "Open Remote ACP Bridge on
  your computer" when `online` is false.
- **Disconnect button.** Offer `bridge.revokeConnection(id)`. Users can also disconnect from the app;
  after that, `startTask` fails with `connection_revoked`.
- **Keep prompts self-contained.** The agent only sees the user's chosen folder. Don't reference URLs
  or files on your servers. Put the needed context in the prompt.

---

## 8. Writing good prompts

The agent is a coding agent working in the user's project folder. Build prompts on the server from
structured input instead of forwarding raw user text when you can:

```ts
function buildPrompt({ kind, focus }: { kind: "security" | "tests"; focus?: string }) {
  const goals = {
    security: "Review this project for security issues. Report each issue with file, line, severity and a fix.",
    tests: "Propose a test plan for this project. Group by module, list concrete test cases.",
  };
  return [goals[kind], focus ? `Focus on: ${focus.slice(0, 2000)}` : "", "Do not modify any files."].filter(Boolean).join("\n\n");
}
```

- Say explicitly whether files may be changed. In *Read only* access the agent must ask before any
  edit anyway, but a clear prompt avoids useless permission prompts.
- Prompts are limited to 64 KiB.

---

## 9. Calling the REST API without the SDK

Authenticate with `Authorization: Bearer <serviceId>.<secret>`.

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /v1/pairings` | `{externalUserId, scopes?, expiresInSeconds? (30–600)}` | `{pairingId, url, code, expiresAt}` |
| `GET /v1/pairings/{id}` | | `{status, connectionId?}` |
| `GET /v1/connections?externalUserId=` | | `{connections:[…]}` |
| `GET /v1/connections/{id}` | | `{status, online, provider, expiresAt, …}` |
| `POST /v1/connections/{id}/revoke` | | `{ok}` |
| `POST /v1/tasks` | `{connectionId, externalUserId, prompt, idempotencyKey}` | `201 {taskId, state}` (`200` on idempotent replay) |
| `GET /v1/tasks/{id}` | | `{state, stopReason?, error?}` |
| `POST /v1/tasks/{id}/cancel` | | `{ok}` |
| `GET /v1/tasks/{id}/events` | header `Last-Event-ID` | SSE: `id` = seq, `event` = kind, `data` = `{seq, kind, payload}` |

Errors always look like `{"error": {"code": "…", "message": "…"}}`.

---

## 10. Error codes and what to show

| Code | Where | Meaning | Suggested message |
|---|---|---|---|
| `desktop_offline` | `startTask` (409), `task.failed` | App not running or not connected | "Open Remote ACP Bridge on your computer and try again." |
| `connection_paused` | `startTask` (409), `task.rejected` | User paused your site in the app | "You paused this site in Remote ACP Bridge. Resume it there." |
| `connection_revoked` / `connection_expired` | `startTask` (410) | Connection ended | "Connect your desktop agent again." (start pairing) |
| `task_in_progress` | `startTask` (409) | One task at a time | "Wait for the current task to finish or cancel it." |
| `declined` | `task.rejected` | User declined the task in the app | "The task was declined on your computer." |
| `approval_timeout` | `task.rejected`/`task.failed` | Nobody approved within 10 minutes | "No one approved the task in time." |
| `bridge_paused` | `task.rejected` | User paused the whole app | "Remote ACP Bridge is paused on your computer." |
| `provider_unavailable` / `provider_signed_out` | `task.rejected`/`task.failed` | The chosen agent isn't ready | "Open Remote ACP Bridge and check AI Providers." |
| `policy_blocked` | `task.failed` | The desktop's safety checks stopped the task (e.g. the agent touched files outside the project folder) | "The task was stopped by your computer's safety checks." |
| `agent_crashed` / `agent_error` / `agent_timeout` | `task.failed` | The local agent failed | "The agent stopped unexpectedly. Try again." |
| `idempotency_conflict` | `startTask` (409) | Same key, different body | Bug in your code. Generate a new key per new task. |
| `rate_limited` | any (429) | Too many requests | Back off and retry. |
| `unauthorized` / `not_found` | any | Wrong secret, or an object that doesn't belong to your service or user | Check configuration and ownership. |

---

## 11. Security checklist

- [ ] The service secret is only in backend environment variables. The SDK throws if loaded in a browser.
- [ ] `externalUserId` comes from your authenticated session, never from the request body.
- [ ] Every task, event stream and cancel route checks that the task belongs to the signed-in user.
- [ ] State-changing routes require same-origin requests (CSRF), e.g. by checking `Origin`.
- [ ] Agent output is rendered as text or sanitized.
- [ ] A Content-Security-Policy without `unsafe-inline` scripts is set.
- [ ] Your domain is verified on the relay (`well_known`).
- [ ] The relay is reached over `https`.

---

## 12. Framework recipes

The SDK is framework-agnostic. Only the HTTP wiring changes.

**Express**: as shown above.

**Next.js (App Router) route handler, streaming SSE:**

```ts
// app/api/remote-acp/tasks/[id]/events/route.ts
import { bridge } from "@/server/remote-acp";
import { getUser, ownsTask } from "@/server/auth";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await getUser(req);
  if (!user || !(await ownsTask(user.id, params.id))) return new Response("Not found", { status: 404 });
  const lastEventId = Number(req.headers.get("last-event-id")) || undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for await (const ev of bridge.streamEvents(params.id, { lastEventId, signal: req.signal })) {
        controller.enqueue(encoder.encode(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
```

**Plain `node:http`**: see `examples/minimal-integration` and `examples/web-demo`.

---

## 13. Testing your integration

- **Without any AI account:** in the desktop app, choose **Test agent** when connecting. It's a
  deterministic built-in agent. It echoes prompts, and the prompts `permission` and `slow` exercise
  permission prompts and cancellation.
- **Automated end-to-end tests:** start the relay and the headless test desktop
  (`target/debug/e2e-desktop`) like `tests/node-e2e` and the examples' tests do. Write the pairing
  URL to its stdin, and it approves tasks and permissions according to `PERMISSION_CHOICE`.
- **Real agents:** connect with Codex or Claude Code in the app and run your real prompts.

---

## 14. FAQ

**Does my backend ever see the user's Codex/Claude credentials?** No. Sign-in happens in the official
CLIs on the user's computer. The relay and your backend only see task events.

**Can I pick Codex vs. Claude for the user?** No, the user chooses when connecting. `getConnection`
tells you which provider is in use (`provider`).

**Can tasks run when the user isn't at their computer?** Only if they turned off "Ask before each
task" and the app is running (closing the window keeps it running in the background). Permission
prompts for sensitive actions still need the user.

**Do you store prompts or results?** The relay keeps a bounded in-memory event buffer per task, for
resuming streams, and drops it an hour after the task ends. Nothing is written to disk. The desktop
doesn't persist transcripts.
