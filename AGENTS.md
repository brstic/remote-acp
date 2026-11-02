# Remote ACP Bridge — agent notes

Read PLAN.md (product spec), DECISIONS.md, SECURITY.md, PROGRESS.md before changing code.

- Rust workspace at repo root (`cargo test --workspace`). Run `source ~/.cargo/env` if cargo is missing.
- Desktop UI: `apps/desktop` (installed standalone: `pnpm --dir apps/desktop install --ignore-workspace`; `pnpm --dir apps/desktop test`; `tauri build --debug --bundles app`).
- TS packages/demo: `pnpm install && pnpm -r --filter '!remote-acp-desktop' test`.
- All remote requests must go through `bridge-core` policy. Never add website-facing operations beyond the allowlist in `crates/bridge-protocol` without updating SECURITY.md and tests.
- Never read provider credential caches; never forward adapter account info.
- Mock agent keywords (prompt): permission, read <path>, slow, crash, noise, flood.
