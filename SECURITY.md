# Security

Report vulnerabilities privately to the maintainers (do not open public issues).

## Model (summary — full version in docs/threat-model.md)
Untrusted: the website and its prompts, the relay/network, agent and tool output, deep links, custom adapters.

Implemented controls:
- **Outbound-only desktop.** No listening sockets. `http://` only for localhost relays.
- **Service authentication.** `Bearer <serviceId>.<secret>`; secrets stored as SHA-256, compared in constant time.
- **Desktop authentication.** Per-desktop random token in the OS keychain.
- **Pairing.** 256-bit single-use tickets (or 50-bit codes, rate limited to 5 failures/min/desktop), 30–600 s TTL, bound to the first desktop that redeems them. Service identity on the consent screen comes from the relay registry, never from the link. Unverified services get a red warning.
- **Consent.** Explicit approval per connection with folder, access level, duration. Per-task approval on by default. Sensitive tool actions prompt locally; the website can only observe. "Allow for this task" is only offered for read/edit/search/fetch kinds.
- **Tenant isolation.** A service can only see its own pairings, connections and tasks; tasks must name the same external user the desktop consented to (404 otherwise).
- **Workspace confinement** for ACP fs methods: absolute paths only, canonicalization, symlink and hard-link escape checks, credential folder denylist (`.ssh`, `.aws`, `.gnupg`, `.claude`, `.codex`, …), size caps. Home folder and `/` cannot be chosen as a workspace.
- **Agent sandbox.** Remote sessions are switched to a restricted adapter mode or refused. Terminal capability is not advertised.
- **Process control.** Agents run with a cleared, allowlisted environment, in their own process group; cancel → `session/cancel` → kill tree after 10 s.
- **Kill switches.** Pause bridge, pause/revoke a website, revoke all — effective immediately on both desktop and relay.
- **No credential handling.** Provider OAuth caches are never read. Codex sign-in is the official `codex login`; API keys go to the OS keychain (Claude) or to `codex login --with-api-key` via stdin.
- **Redaction.** Workspace/home paths and token-like strings are scrubbed from titles sent to websites and from diagnostics. Account identity notifications from adapters are never forwarded.
- **Limits.** 1 MiB frames, 64 KiB prompts, bounded queues/buffers, rate limits per service, max task duration, approval timeout, desktop-offline grace.
- **Audit log** of pairing, grants, tasks, permission outcomes, fs denials.

Known gaps are tracked in PROGRESS.md (“Not done yet”).
