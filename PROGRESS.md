# Progress

_Last updated: 2026-11-02_

## Done (implemented and tested)
- **Protocol** (`bridge-protocol`): versioned envelope, sender allowlists, size/id validation, task state machine, contract fixtures shared with TS.
- **ACP host** (`agent-host`): ACP v1 over stdio, limits, backpressure, correlation, cancel, crash handling, process-group kill, controlled env; deterministic mock agent.
- **Policy** (`connection-policy`): workspace confinement (symlink/hardlink/denylist), grant authorization, access levels.
- **Relay**: service auth, pairing (ticket + code), connections in SQLite, task routing with idempotency and at-most-once dispatch, SSE with resume, rate limits, sweeper (offline grace, approval timeout, max duration), revocation both ways, well-known domain verification.
- **Desktop engine** (`bridge-core`): registration + keychain, WSS loop with heartbeat/backoff/resend, consent, per-task approval, permissions (local only), kill switch, pause/revoke, sessions with restricted modes, provider registry + policy, pinned/integrity-checked adapter install, Codex and Claude Code official logins (ACP only), custom ACP agents (hash-pinned), audit log, diagnostics, redaction.
- **Desktop app** (Tauri 2): Overview, AI Providers, Connected Websites, Activity (live transcript, local test tasks), Settings, Diagnostics, Help, onboarding, consent sheet, decision tray, toasts, light/dark, `remoteacp://` deep links, single instance, tray menu, notifications, launch at login.
- **Web**: `@remote-acp/web-sdk` (auto-resuming SSE), `@remote-acp/browser-helper`, `@remote-acp/protocol-types`, demo website.

## Test results (2026-11-02, macOS arm64)
| Suite | Result |
|---|---|
| `cargo test --workspace` | 52 passed (protocol 9, framing 2, ACP host 11, policy 9, bridge-core 4, E2E 17), 1 ignored (real Codex) |
| real agents (`real_agents.rs`, `--ignored`) | 6 passed with codex-acp 2.5.0 (ChatGPT login) and claude-agent-acp 0.100.0 (local Claude Code login, compatibility test only): initialize, restricted mode, reply, in-workspace read, real permission prompt denied → no file, allowed → file written, cancel (< 15 ms), website permission through the bridge, output firewall blocks outside-workspace reads for both agents |
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
| 3 Official provider auth + accurate status | ✅ Codex (ChatGPT) and Claude Code (Claude Max) through the full product path |
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

## 2026-11-03 additions
- Website **instructions** (ACP `systemPrompt`) and **tools** (MCP over HTTP on the site's verified domain, `agent.tools` scope): Rust E2E, SDK E2E and real-agent tests (`site_tools_codex`, `site_tools_claude`) pass; both agents call the site's MCP tool and follow its instructions.
- Secret-scanner hold-back: no partial credential prefix reaches the website.
- Redesigned Activity chat (Markdown answers, grouped tool steps, plan progress, site customization card, typing indicator).
- Three example apps (`minimal-integration`, `code-review-assistant`, `docs-generator`) with real end-to-end tests; integration guide.
- Suites: Rust 59 passed (+10 real-agent, all passing), TypeScript 100 passed, desktop UI 25 passed. `site_tools_claude` failed intermittently (2 of ~18 runs, empty reply, not reproduced since; diagnostics added to the test).

- CI green on macOS, Windows and Linux (Rust workspace tests incl. E2E) and the web job (all TS packages, examples, Node E2E). CI found and we fixed a Windows-only firewall gap (verbatim `\\?\` / UNC paths) and Windows-specific test assumptions.

- Example apps with REAL agents (`tests/node-e2e/test/examples-real.test.ts`, `REAL_AGENTS=codex,claude`): all three examples pass with Codex and with Claude Code: minimal answer, architecture review with website instructions, and README written after a real local permission prompt. This found a firewall false positive (agents reading their own skill folders), now fixed.
- Shipped release `.app` verified headlessly (launched in the background, no window focus): website tasks through the real relay produce the answer, apply website instructions, block an outside-folder read (`policy_blocked`), and reconnect automatically after a relay restart.
- Real-agent instructions tests: `instructions_only_{claude,codex}`, `instructions_after_plain_task_claude` pass. `site_tools_claude`: 20 consecutive passes after diagnostics were added (2 unexplained early failures).
- Relay rejects unknown `POST /v1/tasks` fields (422), so new options are never silently dropped by an older relay.

## Not done yet / known limitations
- GUI E2E is a scripted manual-run procedure (macOS only), not part of CI.
- Two installed copies of the app (e.g. debug + release bundles) both register `remoteacp://`; macOS may hand the link to the non-running copy, whose single-instance hand-off drops the URL. Keep one installed copy (see troubleshooting).
- Signing/notarization: wired in `release.yml` (activates with `APPLE_*` secrets); not performed — no Developer ID on this machine. No auto-update.
- Windows/Linux: all Rust and TS test suites pass in CI; the desktop app itself was not launched on a real Windows or Linux machine.
- No hosted relay is running yet: a deployable kit exists (`deploy/relay`: Docker + Caddy automatic TLS); it needs a server and a domain.
- No E2EE (TLS + no persistence on relay only).
- Next.js demo from the plan replaced by a framework-free Node demo.
