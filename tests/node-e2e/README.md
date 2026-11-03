# Node end-to-end test (real relay + desktop)

`test/e2e.test.ts` runs, with nothing mocked:

1. `cargo build -p remote-acp-relay -p e2e-tests` (incremental; skipped with
   `REMOTE_ACP_E2E_SKIP_CARGO=1` if binaries exist; cargo is found on `PATH`, `$CARGO` or
   `~/.cargo/bin`),
2. the real `target/debug/remote-acp-relay` on a free port with a temp config + SQLite db,
3. `target/debug/e2e-desktop` (real bridge-core + `mock-acp-agent`, `PERMISSION_CHOICE=allow_once`),
4. `@remote-acp/web-sdk` against it: pairing (+ single-use ticket), streamed `hello sdk` with
   exact text, idempotent retry, explicit `Last-Event-ID` replay, `permission` →
   `permission_pending` + `permission_resolved(allowed)` + `PERMISSION_GRANTED`, `slow` cancelled
   via `cancelTask` (`stopReason: cancelled`), **automatic resume after a real TCP drop**
   mid-stream (a local proxy cuts the SSE response), cross-service / cross-user isolation,
   `revokeConnection` → `startTask` fails with `connection_revoked`,
5. the built web demo server (`examples/web-demo/dist/main.js`) via its own HTTP API: sign-in,
   pairing, accepted state with provider, task streaming through its SSE proxy (+ resume),
   another user's isolation, Disconnect.

Run (after building the TS packages):

```sh
source ~/.cargo/env
pnpm -r --filter '!remote-acp-desktop' build
pnpm --filter @remote-acp/node-e2e test     # or: pnpm -r --filter '!remote-acp-desktop' test
```

`E2E_VERBOSE=1` prints child process output. All child processes are killed and temp dirs removed
after the run.

## Reused by the example apps

`test/harness.ts` (relay with a custom service list via `startRelay({services})`, desktops with
`startDesktop(url, {permissionChoice})`, `pairDesktop`, `startNodeServer`) and `test/app-client.ts`
(cookie-keeping API client + SSE reader) are imported by the E2E tests in `examples/minimal-integration`,
`examples/code-review-assistant` and `examples/docs-generator`.
