# Remote ACP Bridge — agent notes

Read PLAN.md (product spec), DECISIONS.md, SECURITY.md, PROGRESS.md before changing code.

- Rust workspace at repo root (`cargo test --workspace`). Run `source ~/.cargo/env` if cargo is missing.
- Desktop UI: `apps/desktop` (installed standalone: `pnpm --dir apps/desktop install --ignore-workspace`; `pnpm --dir apps/desktop test`; `tauri build --debug --bundles app`).
- TS packages/demo: `pnpm install && pnpm -r --filter '!remote-acp-desktop' test`.
- All remote requests must go through `bridge-core` policy. Never add website-facing operations beyond the allowlist in `crates/bridge-protocol` without updating SECURITY.md and tests.
- Never read provider credential caches; never forward adapter account info.
- Mock agent keywords (prompt): permission, read <path>, leak <path>, secret, slow, crash, noise, flood.
- Providers are ACP-only with official sign-in (`codex login`, `claude auth login`); there is no API-key mode. Never select permissive modes (auto, agent, bypassPermissions, *full-access*) for website tasks.
- The website must never be able to answer permission prompts; the output firewall (`crates/bridge-core/src/guard.rs`) must stay on for website tasks.
- Website integration docs: docs/integration-guide.md; examples in examples/.
- Real-agent tests (use the developer's own sign-in): `cargo test -p e2e-tests --test real_agents --test real_codex -- --ignored --test-threads=1`.
