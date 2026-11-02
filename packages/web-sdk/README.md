# @remote-acp/web-sdk

Server-side TypeScript SDK for a **registered service backend** talking to a Remote ACP Bridge relay.
Node >= 20, uses global `fetch`, zero runtime dependencies (the `@remote-acp/protocol-types`
dependency is type-only and erased at runtime).

> Never ship this package or the service secret to a browser. The constructor throws if
> `window` is defined. Use `@remote-acp/browser-helper` in the browser and call your own backend.

```ts
import { RemoteAcp, RemoteAcpError } from "@remote-acp/web-sdk";

const bridge = new RemoteAcp({
  serviceId: process.env.REMOTE_ACP_SERVICE_ID!,
  serviceSecret: process.env.REMOTE_ACP_SERVICE_SECRET!,
  relayUrl: process.env.RELAY_URL!, // https required except localhost / 127.0.0.1
});

// Only ever for the user *your* backend has authenticated:
const pairing = await bridge.createPairing({ externalUserId: user.id, expiresInSeconds: 120 });
// show pairing.url (remoteacp:// deep link) and pairing.code in your UI
const final = await bridge.waitForPairing(pairing.pairingId); // accepted | rejected | expired

const task = await bridge.startTask({
  connectionId: final.connectionId!,
  externalUserId: user.id,
  prompt: "Summarize these changes.",
  idempotencyKey: crypto.randomUUID(),
});

for await (const ev of bridge.streamEvents(task.taskId)) {
  if (ev.kind === "task.event" && ev.payload.type === "text_delta") process.stdout.write(ev.payload.text);
}
```

## API

| Method | Relay route |
| --- | --- |
| `createPairing({externalUserId, scopes?, expiresInSeconds?})` | `POST /v1/pairings` |
| `getPairing(id)` | `GET /v1/pairings/{id}` |
| `waitForPairing(id, {signal, timeoutMs, intervalMs})` | polls `GET /v1/pairings/{id}` until `accepted`/`rejected`/`expired` |
| `listConnections(externalUserId)` | `GET /v1/connections?externalUserId=` |
| `getConnection(id)` / `revokeConnection(id)` | `GET /v1/connections/{id}`, `POST /v1/connections/{id}/revoke` |
| `startTask({connectionId, externalUserId, prompt, idempotencyKey?})` | `POST /v1/tasks` |
| `getTask(id)` / `cancelTask(id)` | `GET /v1/tasks/{id}`, `POST /v1/tasks/{id}/cancel` |
| `streamEvents(id, {lastEventId?, signal?, maxRetries?, retryDelayMs?, idleTimeoutMs?})` | `GET /v1/tasks/{id}/events` (SSE) |

### `streamEvents`

An `AsyncIterable` of `{seq, kind, payload}` (`task.accepted`, `task.event`, `task.completed`,
`task.failed`, `task.rejected`). It ends after the terminal event. On network drops, idle stalls
(no bytes for `idleTimeoutMs`, default 45s; the relay sends keep-alives every 15s), 5xx/429 or a
relay `lagged` notice it reconnects with `Last-Event-ID` and drops duplicate `seq`s. After
`maxRetries` (default 5) consecutive attempts without progress it throws
`RemoteAcpError("stream_interrupted")`. A relay `resume_unavailable` notice is yielded as
`{kind: "error", payload: {code, message}}`. Breaking out of the loop closes the HTTP stream.

The SSE parser (`SseParser`, `parseSseStream`) is exported and follows the WHATWG
event-stream rules (LF/CRLF/CR, multi-line data, comments, BOM, `id`/`retry`).

### Errors

Every failure is a `RemoteAcpError` with `code`, `status` (HTTP status, or `0` for client-side
failures) and `message`. Relay codes are passed through verbatim, e.g. `desktop_offline`,
`connection_revoked`, `connection_paused`, `connection_expired`, `task_in_progress`,
`idempotency_conflict`, `missing_scope`, `rate_limited`, `not_found`, `unauthorized`.
SDK codes: `network_error`, `timeout`, `aborted`, `invalid_response`, `stream_interrupted`,
`invalid_config`, `http_<status>` (non-JSON error bodies).

## Scripts

```sh
pnpm --filter @remote-acp/web-sdk build   # tsc -> dist (ESM + .d.ts)
pnpm --filter @remote-acp/web-sdk test    # vitest unit tests (mocked fetch)
```

The real end-to-end test against the Rust relay lives in `tests/node-e2e`.
