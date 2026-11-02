# Progress

_Last updated: 2026-11-02_

## Done (implemented and tested)
- **Protocol** (`bridge-protocol`): versioned envelope, sender allowlists, size/id validation, task state machine, contract fixtures shared with TS.
- **ACP host** (`agent-host`): ACP v1 over stdio, limits, backpressure, correlation, cancel, crash handling, process-group kill, controlled env; deterministic mock agent.
- **Policy** (`connection-policy`): workspace confinement (symlink/hardlink/denylist), grant authorization, access levels.
- **Relay**: service auth, pairing (ticket + code), connections in SQLite, task routing with idempotency and at-most-once dispatch, SSE with resume, rate limits, sweeper (offline grace, approval timeout, max duration), revocation both ways, well-known domain verification.
- **Desktop engine** (`bridge-core`): registration + keychain, WSS loop with heartbeat/backoff/resend, consent, per-task approval, permissions (local only), kill switch, pause/revoke, sessions with restricted modes, provider registry + policy, pinned/integrity-checked adapter install, Codex official login, Claude API-key mode, custom ACP agents (hash-pinned), audit log, diagnostics, redaction.
- **Desktop app** (Tauri 2): Overview, AI Providers, Connected Websites, Activity (live transcript, local test tasks), Settings, Diagnostics, Help, onboarding, consent sheet, decision tray, toasts, light/dark, `remoteacp://` deep links, single instance, tray menu, notifications, launch at login.
- **Web**: `@remote-acp/web-sdk` (auto-resuming SSE), `@remote-acp/browser-helper`, `@remote-acp/protocol-types`, demo website.

## Test results (2026-11-02, macOS arm64)
| Suite | Result |
|---|---|
| `cargo test --workspace` | 46 passed (protocol 9, framing 2, ACP host 11, policy 8, E2E 16), 1 ignored (real Codex) |
| real Codex (`--ignored`) | passed: verified adapter install, ChatGPT sign-in detected, session in `read-only` mode, streamed `BRIDGE_OK`, no account data leaked |
| TS packages | 66 passed (protocol-types 15, browser-helper 6, web-sdk 32, web-demo 5, node E2E 8 with real relay binary + headless desktop) |
| Desktop UI (vitest) | 7 passed |
| E2E stability | Rust E2E 3×, Node E2E 3× consecutive green |
| Manual | release `.app` (22 MB) and `.dmg` (7.3 MB) built; app starts, registers, connects to relay; `remoteacp://` link from macOS opens the consent sheet with relay-verified identity; demo website driven in real Brave (headless): sign-in → pairing → streaming → permission → cancel, light and dark; **GUI E2E on the release `.app` with real mouse/keyboard events** (`tests/gui-e2e`): website pairing link → macOS → consent sheet → typed folder → *Allow connection* → website sends task → *Allow task* in the app's tray → streamed reply on the website → *Allow once* on a permission prompt → file written in the chosen folder → *Disconnect* → relay reports `revoked` |

## Acceptance tests (PLAN §16)
| # | Status |
|---|---|
| 1 Install on clean macOS/Windows/Linux | macOS build verified; Windows/Linux via CI matrix (not run on real machines) |
| 2 Detect agent / guide install | ✅ |
| 3 Official provider auth + accurate status | ✅ Codex (real); Claude API-key path implemented, not exercised with a real key |
| 4 Pairing link from real browser → app | ✅ (macOS `open remoteacp://…`) |
| 5 Verified identity + scoped consent | ✅ |
| 6–8 Task from website, live events at website and desktop | ✅ (E2E + browser) |
| 9 Permission approve/deny locally | ✅ |
| 10 Cancel from website and desktop | ✅ |
| 11 Revoke → rejected immediately | ✅ |
| 12 Reconnect without duplicates | ✅ |
| 13 Signed-out provider → no false success | ✅ (auth_required mapping, mock test) |
| 14 Workspace confinement | ✅ |
| 15 No tokens to relay/website | ✅ by design + assertions |
| 16 Test suites | ✅ |
| 17 Light/dark, responsive | ✅ macOS |
| 18 Installable artifacts + docs | ✅ unsigned macOS artifacts |

## Not done yet / known limitations
- GUI E2E is a scripted manual-run procedure (macOS only), not part of CI.
- Two installed copies of the app (e.g. debug + release bundles) both register `remoteacp://`; macOS may hand the link to the non-running copy, whose single-instance hand-off drops the URL. Keep one installed copy (see troubleshooting).
- Signing/notarization: wired in `release.yml` (activates with `APPLE_*` secrets); not performed — no Developer ID on this machine. No auto-update.
- Windows: all Rust crates except the Tauri shell `cargo check` clean for `x86_64-pc-windows-gnu`; app not run on a real Windows machine. Linux: not run (no Linux host/containers here; CI matrix builds and tests it).
- No hosted relay is running yet: a deployable kit exists (`deploy/relay`: Docker + Caddy automatic TLS); it needs a server and a domain.
- No E2EE (TLS + no persistence on relay only).
- Claude adapter not tested with a real API key in this session.
- Next.js demo from the plan replaced by a framework-free Node demo.
