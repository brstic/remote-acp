# @remote-acp/protocol-types

Hand-written TypeScript types that mirror the Rust crate `crates/bridge-protocol`
(protocol version 1) and the relay REST/SSE contract (`apps/relay/src/http.rs`).

- `Envelope`, `EnvelopeKind`, `TaskEvent`, `TaskState`, `PlanEntry`, ...
- Relay REST types: `CreatePairingResponse`, `PairingStatusResponse`, `ConnectionInfo`,
  `TaskSummary`, `RelayErrorBody`, ...
- SSE types: `TaskStreamEvent` (`{seq, kind, payload}`), `StreamErrorEvent`.
- Small runtime guards: `validateEnvelope(value, sender)`, `isTaskEvent`, `isTaskStreamEvent`.
  They mirror `Envelope::validate` (version, id format, per-sender kind allowlist, task scoping,
  payload shape and size limits).

The Rust crate is the source of truth. `pnpm test` loads every `tests/contract/*.json` fixture
and checks the guards agree with the fixture's `valid` flag.

```sh
pnpm --filter @remote-acp/protocol-types build
pnpm --filter @remote-acp/protocol-types test
```
