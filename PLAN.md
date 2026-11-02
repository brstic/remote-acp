# Remote ACP Bridge — Master Product & Engineering Plan

> **Status:** Implementation-ready specification and coding-agent brief  
> **Working name:** Remote ACP Bridge (renameable)  
> **Target platforms:** macOS (Apple Silicon + Intel), Windows 10/11, Linux  
> **Last researched:** 2026-11-02  
> **Primary purpose:** Connect an AI coding agent running on a user's own computer to an explicitly authorized remote web service through a secure, user-controlled bridge.

---

## 0. Instructions for Claude Code / Codex

You are the lead product engineer, desktop engineer, Rust networking engineer, UI designer, and security engineer building **Remote ACP Bridge** from scratch.

**Do not build a mockup. Build a usable, cross-platform product.** The desktop app is the primary product. A minimal relay and web integration SDK are necessary to prove the remote connection end-to-end.

Working principles:

1. Read this complete document before implementing.
2. Inspect the repository and existing code before modifying it. If the repository is empty, scaffold the architecture specified below.
3. Use **Agent Client Protocol (ACP)** as the local agent-facing protocol. Do not confuse it with similarly named "Agent Control Protocol" projects or with Model Context Protocol (MCP).
4. Use the current, documented ACP v1 protocol as the shipping baseline; negotiate supported versions and capabilities. Do not silently assume ACP v2 draft features.
5. Respect provider terms, especially the distinction between officially supported user-facing subscription use and API-key usage. Never implement token extraction, OAuth impersonation, credential sharing, or a proxy intended to bypass plan limits.
6. Build secure controls into the architecture from the beginning. No arbitrary remote shell, unchecked filesystem access, or anonymous public AI endpoint.
7. Keep the end-user UI extremely simple. Hide protocol terminology by default; expose diagnostics to advanced users.
8. Implement actual functionality, robust errors, tests, builds, and documentation; no fake "Connected" indicators or simulated success in production.
9. Work in independently testable vertical slices. Do not create dozens of empty abstractions or pretend an unimplemented feature is complete.
10. Maintain `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, and `SECURITY.md`. Update them as implementation progresses. Keep `README.md` accurate.
11. Use real provider-provided sign-in paths only. User credentials must never pass through our own UI/backend.
12. If provider licensing prevents a particular subscription scenario, disable that path and explain it in-product rather than inventing a technical workaround.

**First task:** create a minimal working vertical slice: Tauri desktop UI -> locally spawned ACP test agent -> secure outbound tunnel -> relay -> minimal web demo -> prompt -> streaming response -> cancel -> local permission flow. Then add production integrations and polish.

---

## 1. Product vision

### One sentence

**Use an AI agent on your computer from a trusted website, while keeping control of authentication, files, permissions, and execution on your machine.**

### The user problem

People already use Claude Code, Codex, or other agents locally. A separate web application may want to offer an AI-powered workflow, but setting up credentials, API billing, agents, WebSockets, and remote connectivity is difficult and often inappropriate for nontechnical users.

We want a desktop application that makes the relationship clear:

- The user owns and operates their local AI agent installation.
- The user authenticates directly with the relevant provider using that provider's supported mechanism.
- The user explicitly connects to a specific trusted website or service.
- The website can initiate **only the approved type of agent session**, within the user's chosen scope and provider rules.
- The user can inspect, approve, pause, disconnect, or revoke that access at any time.
- The website receives task output through the bridge; it never receives the provider's access tokens.

### Important business/legal distinction

The product **must not advertise that every AI subscription can be repurposed as a generic, unlimited API**. Provider terms and supported technical flows differ.

- Codex supports ChatGPT account sign-in for subscription-backed local use in its supported clients and ACP adapter; actual eligibility, permissions, and quotas depend on the user's account and current provider policies.
- Anthropic's current Claude Code legal documentation explicitly restricts third-party developers from routing requests through consumer Claude subscription credentials on behalf of their users. It also forbids collecting/intermediating Claude session tokens. Running an unmodified, user-authenticated Claude Code binary has different conditions from offering a third-party Claude.ai sign-in feature; **it is not blanket approval to expose Claude subscription use as a third-party SaaS inference backend**.
- Implement Claude integration initially with compliant user-owned API-key / supported cloud-provider methods, and support subscription-backed scenarios only if the intended distribution and usage are explicitly permitted or authorized by Anthropic.
- OpenAI/Codex subscription use also remains subject to applicable terms, end-user approvals, plan limits, and supported integration behavior; validate the intended third-party hosted workflow before marketing it as subscription-powered.
- Provide a **provider policy/compatibility registry** that can disable a risky auth or transport mode without breaking the whole product.

This is a product requirement, not a footnote.

### Non-goals

- A third-party AI model inference API that impersonates official provider APIs.
- Reselling Claude/ChatGPT subscriptions, pooling multiple users' plans, or hiding usage attribution.
- Automated extraction or reuse of OAuth cookies/session files.
- Evading usage limits, billing, agent safety permissions, or provider restrictions.
- Unlimited unattended service-side batch inference on consumer subscriptions.
- An arbitrary remote-terminal, RDP, or full-device-control product.
- Replacing the official Claude Code/Codex executables.

---

## 2. Primary UX: three steps

**Step 1 — Choose your AI**

Provider cards with recognizable **properly licensed or permitted** provider marks and clear names:

- **Codex** — Connected / Sign in with ChatGPT / Install
- **Claude Code** — Connected / Sign in using official CLI / Install; show compliance-based auth options
- **Other ACP agent** — Add an ACP-compatible agent (advanced)

Show the detected installation, supported authentication modes, and a single clear primary action. Distinguish installation, provider authentication, and bridge connectivity.

**Step 2 — Connect a website**

- Website shows **Connect desktop agent** and a short-lived pairing URL or QR code.
- Opening the URL launches the installed app via a registered custom protocol handler.
- App displays the website's **verified domain and service identity**, requested permissions, chosen AI agent, and access expiration.
- User clicks **Allow connection** (or Reject).
- A website connection is never silently approved based solely on a URL being opened.

**Step 3 — Start using it**

- Website starts an approved, interactive task; desktop shows the live session.
- Stream messages and agent events between website and desktop.
- Any sensitive tool access prompts for local user approval according to policy.
- Both web and desktop can cancel the task.
- User can disconnect the website instantly.

**North-star onboarding criterion:** A nontechnical person with a working local agent installation should connect a website and run a simple approved task without typing a shell command or configuring a port.

---

## 3. Key architecture decisions

### Why ACP

ACP standardizes **agent <-> client** interaction and provides session lifecycle, streaming updates, permissions, tool use, and cancellation. It is not MCP (which supplies tools/context to agents).

**ACP v1 standard transport is JSON-RPC over local stdio**, where the client launches a local agent subprocess. Remote ACP transport is still evolving. Therefore:

- Use standards-compliant ACP communication **locally**, between our desktop Rust agent host and an agent adapter subprocess.
- Use a **separate versioned application transport** to carry *authorized* control and streaming messages over the internet.
- Do not pretend that our custom relay wire protocol is a standardized ACP network transport.
- Implement ACP-compatible forwarding where relevant, preserving ACP message semantics, but enforce a permission boundary between remote service and local agent.

### High-level topology

```text
                     REMOTE WEBSITE / SAAS
                +---------------------------+
                | Website UI + Backend API  |
                | @remote-acp/web-sdk       |
                +-------------+-------------+
                              |
                        HTTPS / WSS
                              |
                +-------------v-------------+
                | OPTIONAL RELAY SERVICE    |
                | authenticated routing     |
                | temporary pairing         |
                | quotas + revocation       |
                | no provider credentials   |
                +-------------+-------------+
                              |
                     outbound WSS only
                              |
              USER'S MAC / WINDOWS / LINUX
       +----------------------+--------------------+
       | REMOTE ACP BRIDGE DESKTOP APPLICATION     |
       |                                            |
       | Tauri UI / session monitor / approvals    |
       | Rust daemon + policy engine + ACP client  |
       |                                            |
       | ACP v1 over local stdio (JSON-RPC NDJSON)  |
       |             |                  |           |
       |    codex-acp adapter    claude-agent-acp   |
       |             |                  |           |
       |           Codex          Claude Agent     |
       |             |                  |           |
       |   Official provider authentication only    |
       +------------------------------------------------+
```

Clarification: a remote website is not automatically entitled to become the full local ACP client. **The desktop bridge owns the local ACP lifecycle and mediates any remote request.** Keep the website-facing API narrower than raw ACP initially.

### Connection models

**MVP: managed relay, outbound-only.**

- Desktop opens an outbound TLS WebSocket to a relay.
- Web service backend opens a separate authenticated relay connection.
- The relay connects only explicitly paired identities/sessions.
- No router setup, NAT port forwarding, public listener, or inbound firewall rule is required.
- A local `127.0.0.1` control endpoint may be added for diagnostics, with strict origin/CSRF controls; do **not** bind it to `0.0.0.0`.

**Later: self-hosted relay and verified direct connection.**

- A self-hostable relay is a first-class deployment mode.
- Direct peer-to-peer mode can be researched later, after security and reliability baselines exist.

### Strong default

One authorized website connection -> one user-selected agent -> one isolated workspace -> one user-visible task session. Expand to concurrent tasks only after implementing quotas and resource isolation.

---

## 4. Recommended technology stack

| Component | Choice | Reason |
|---|---|---|
| Desktop shell | **Tauri 2 + Rust** | macOS, Windows, Linux; small app; native OS integrations |
| Desktop frontend | **React + TypeScript + Vite** | maintainable, rich stateful UI |
| Styling | Tailwind CSS + carefully customized primitives | consistent, restrained macOS-inspired interface |
| Icons | Lucide for product UI; official provider marks only where usage is permitted | visual consistency + trademark safety |
| Desktop state | TanStack Query + Zustand or equivalent | clear division between server state and UI state |
| Rust runtime | Tokio | subprocess control, network I/O, cancellation |
| Local persistence | SQLite + migrations | connections, metadata, task summaries, durable settings |
| Secret storage | OS Keychain / Windows Credential Manager / Secret Service | no provider secrets in app DB |
| ACP client | maintained official/community Rust ACP implementation, verify current compatibility | structured protocol, no hand-rolled parser if avoidable |
| Codex | `@agentclientprotocol/codex-acp` | maintained ACP adapter backed by Codex App Server |
| Claude | `@agentclientprotocol/claude-agent-acp` | ACP bridge for Claude Agent SDK; subject to provider auth restrictions |
| Relay | Rust + Axum/Tokio or equivalent | async WebSocket routing, simple shared code |
| Website SDK | TypeScript (`@remote-acp/web-sdk`) | minimal server-side integration for SaaS products |
| Protocol contracts | versioned JSON schemas or Rust/TS generated types | compatible clients and server |
| Testing | Vitest, Rust test suite, Playwright, cross-platform CI | regression protection |

Keep the relay **stateless for message contents** whenever possible. Redis may hold ephemeral presence/session routing for a horizontally scaled deployment; PostgreSQL is optional for accounts/audit metadata. Avoid deploying either for the first local single-node proof of concept unless genuinely necessary.

### Build targets

- macOS: `aarch64-apple-darwin`, `x86_64-apple-darwin`
- Windows: `x86_64-pc-windows-msvc`; consider ARM64 after first release
- Linux: `x86_64-unknown-linux-gnu`; investigate AppImage/deb/rpm and ARM64 later
- Code signing and notarization for production macOS releases.
- Signed installer and code signing strategy for Windows; Linux packaging with clear dependency checks.

---

## 5. UI / visual design specification

**Design direction:** a premium native macOS utility, minimal and calm, not a developer dashboard crammed with logs.

### Global design requirements

- Mac-native appearance on macOS; honor Windows/Linux system conventions while retaining the same design language.
- Native-feeling titlebar, traffic-light placement on macOS, window dragging, keyboard shortcuts, and OS menus.
- System fonts (`-apple-system`, BlinkMacSystemFont, Segoe UI, appropriate Linux fallback).
- Spacious but compact layout, restrained neutral colors, subtle accent color, fine 1px borders, meaningful whitespace, soft corner radii.
- Light and dark themes following OS preference; optional manual override.
- Prefer clarity and contrast over excessive glassmorphism; avoid blur that reduces legibility.
- Smooth, subtle animations (120–220ms) respecting reduced-motion preferences.
- Proper focus rings, text scaling, VoiceOver/Narrator-friendly labels, full keyboard access.
- Responsive to smaller desktop window sizes; never require a huge monitor.
- No raw stack traces or protocol identifiers in standard user-facing screens.
- Provider marks may appear on provider selection cards if trademark rules allow; include plain-text fallback logos rather than shipping unauthorized assets.

### Information architecture

Sidebar:

```text
Remote ACP Bridge

Overview
AI Providers
Connected Websites
Activity

Settings
Help
```

### Screen A — Onboarding

Welcome screen with one sentence: **"Connect your AI agent to websites securely."**

1. Detect Codex / Claude Code / other supported adapters.
2. Show easy installation options with links to official instructions and optional trusted install automation.
3. Run native provider sign-in flow.
4. Offer "Connect a website" with a pairing code or a browser-return deep link.
5. Explain that the app must remain running for remote use.

### Screen B — Overview (main screen)

Top status: **Bridge is on / Bridge is paused / Offline**.

Center: two large restrained provider cards. Each card shows:

- Provider name, logo if permitted, installed/authenticated state.
- Current active agent and model when known.
- `Connect`, `Sign in`, `Manage` based on actual status.

Under providers:

- Connected website cards (domain, permissions, last active, connection indicator).
- Activity indicator: idle / waiting for approval / working.
- One visible action: **Connect a website**.

Footer: "Everything runs on your computer. Approve what websites can access."

### Screen C — AI Providers

Each provider's detail page:

- Install / Update / Recheck installation.
- Sign in / Sign out via official provider tool.
- Authentication mode (subscription / API key / unsupported / policy-restricted).
- Supported capabilities discovered from `initialize`.
- Diagnostic button and redacted errors.
- Optional locally selected model and effort if adapter advertises those options.

Do not promise subscription support based solely on a successful login. Provider eligibility and usage rules must be checked separately.

### Screen D — Websites

- Verified website identity and HTTPS origin.
- Granted scopes, local workspace, default agent, expiry.
- Pause / revoke / disconnect / reconnect.
- Optional explicit consent for every new task (default: on).
- Timestamp and status of last request; basic usage info if available.
- Strong warning if the site has requested filesystem or command access.

### Screen E — Live activity

- Conversation transcript (user prompt, agent response, streamed text).
- Current task, plan/checklist, progress steps, tool calls with expandable details.
- Permission request tray: `Deny`, `Allow once`, `Allow for this task` only where safe.
- Cancel/stop immediately.
- Display workspace and website identity at all times.
- Separate advanced raw event log, never the default view.

### Screen F — Settings

- Launch on startup (opt-in, user-visible).
- Keep running in tray/menu bar (opt-in).
- Show notifications for permission requests.
- Default provider, allowed workspace roots, session timeouts.
- Relay mode: hosted / custom relay endpoint.
- Security: require approval per task; revoke all; lock bridge; clear diagnostics.
- Updates, theme, language, about, privacy information.

### Screen G — Diagnostics (advanced)

- ACP agent binary detection and version.
- Relay TLS/connection health and round-trip latency measured locally.
- Local auth status without exposing tokens.
- Protocol version, negotiated capabilities, recent redacted errors.
- Export sanitized diagnostics on demand.

---

## 6. Native agent integration

### 6.1 ACP host implementation

Build a Rust `AgentHost` service with these responsibilities:

1. Resolve and validate the configured adapter executable and its version.
2. Launch only an allowlisted, verified executable and fixed supported arguments.
3. Set the working directory to the user-approved workspace.
4. Create dedicated `stdin`, `stdout`, and `stderr` pipes.
5. Parse **newline-delimited JSON-RPC 2.0** ACP messages from stdout; never merge logs from stderr into the JSON-RPC stream.
6. Implement ACP initialization/capability negotiation and chosen authentication method.
7. Handle session creation and lifecycle; stream updates; forward cancellations and supported tool-permission requests.
8. Enforce message size limits, timeouts, subprocess shutdown, and backpressure.
9. Restart crashed adapters only with explicit logic; never replay a write/command request automatically after an unknown completion state.
10. Provide a stable, testable Rust interface for both real agents and a deterministic mock ACP agent.

The host must manage ACP request/response IDs separately from bridge task IDs. Build correlation maps and reject unsolicited/invalid replies.

### 6.2 Codex provider

Use maintained project:

- https://github.com/agentclientprotocol/codex-acp

Implementation:

- Detect an already installed Codex CLI / adapter.
- Support verified adapter installation or update when dependency prerequisites exist; pin/test adapter versions and verify build artifacts before executing.
- Do not rely on the archived `@zed-industries/codex-acp` package.
- Provide **"Sign in with ChatGPT"** using the official supported adapter/`codex login` browser flow, not an embedded OAuth imitation.
- For browserless cases, show documented device-auth option if supported by the installed CLI.
- Use documented `codex login status` or adapter auth state to report login health.
- Surface official ACP auth-methods from adapter `initialize`, rather than guessing based on files.
- Support API-key sign-in separately (API billing applies).
- Distinguish a locally signed-in Codex user from a website being authorized to issue tasks.
- Honor Codex sandbox/approval modes; do not globally grant dangerous permissions.

### 6.3 Claude provider

Use maintained project:

- https://github.com/agentclientprotocol/claude-agent-acp

Implementation:

- Detect official unmodified Claude Code installation and adapter, where applicable.
- Offer **"Open official Claude Code sign-in"** only as a launch of the vendor-owned login UI for the user's own permitted local use; this is **not** a third-party Claude OAuth login feature.
- For a remotely controlled third-party SaaS integration, default to an explicitly permitted API-key or supported cloud-provider mode, or mark the subscription path unavailable until usage rights are confirmed.
- Never read, collect, forward, or store `~/.claude` authentication data or provider session tokens.
- Never build Claude subscription-to-API request conversion as a workaround.
- Respect upstream permissions and immutable official binaries; do not patch Claude Code to change authentication or restrictions.
- Display a clear policy restriction where a requested third-party web-service scenario is not supported.

### 6.4 Additional agents

Implement a provider plugin model supporting ACP-compatible agents that the user installs, subject to:

- Explicit opt-in and trusted executable path verification.
- Controlled environment variables, working directory, and capabilities.
- A warning when a custom adapter is not officially verified.
- Provider-specific terms, auth and launch semantics.

Do not auto-run an arbitrary command received from a pairing link or web service.

---

## 7. Website pairing and identity

### Connection initiation

The web service creates a **one-time, short-lived pairing challenge** through the relay after authenticating as a registered service.

Example display in the website:

```text
Connect your local AI
1. Install Remote ACP Bridge
2. Click "Connect" below
3. Confirm permissions in the desktop application

[Connect desktop app]
```

Link format (illustrative, not final wire specification):

```text
remoteacp://pair?ticket=<opaque-short-lived-ticket>
```

The `ticket` is **single use**, has short expiration, and cannot alone authorize access. It must not embed provider credentials, raw filesystem paths, or reusable service secrets.

### Desktop confirmation

Display:

```text
example-service.com wants to connect

Verified domain: example-service.com
AI provider: Codex
Requested: Start an interactive AI task
Workspace: /Users/alex/Projects/SiteExample
Expires: In 24 hours

[Decline]                     [Allow connection]
```

The desktop must independently fetch a signed/verified service identity and bind consent to its service ID, verified domain, and public key. Do not trust a `name`, `domain`, or requested scope supplied by a browser deep link alone. Bind the pairing to the signed-in website user where possible.

### Security properties

- One-time, expiration-limited pairing challenges.
- Desktop must show explicit consent and scope approval.
- Service identity binding via a domain verification mechanism and authenticated service credentials.
- Web backend may access only grants for its corresponding user/tenant.
- Fine-grained connection revocation and event audit.
- Optional default consent per task for first release; no permanent wildcard consent.
- A compromised or untrusted website must never gain implicit access to the user's entire machine.

---

## 8. Remote transport and protocol design

### Layering

```text
Website SDK
   |
   | App-level requests (startTask / cancelTask / subscribeEvents)
   v
Authenticated, versioned Remote ACP Bridge envelope
   |
   | WSS over TLS; optional E2EE of task payloads
   v
Routing relay
   |
   v
Desktop policy and session broker
   |
   | ACP v1 JSON-RPC over local stdio
   v
ACP adapter subprocess -> provider runtime
```

### Recommended application-level envelope

Do not expose an unauthenticated raw stdio proxy. Start with a small allowlisted message family:

```json
{
  "version": 1,
  "id": "msg_01",
  "connectionId": "conn_123",
  "taskId": "task_456",
  "sequence": 18,
  "kind": "task.start",
  "createdAt": "2026-11-02T19:00:00Z",
  "payload": {
    "provider": "codex",
    "input": [{ "type": "text", "text": "Review the authorized project." }],
    "mode": "interactive"
  }
}
```

Document and schema-validate message variants (names illustrative):

- `connection.hello`, `connection.ready`, `connection.revoke`
- `task.start`, `task.accepted`, `task.rejected`, `task.cancel`
- `task.event` (text delta, plan, tool-call status, permission request, terminal status)
- `task.completed`, `task.failed`
- `permission.request`, `permission.response`
- `heartbeat`, `error`, `resume.request`, `resume.ack`

### Wire-level requirements

- Use authenticated WSS (TLS 1.2+; TLS 1.3 where available).
- Design for **authenticated end-to-end encryption** between desktop and registered service when the relay must not see prompts/results. Use audited crypto libraries, documented key exchange and rotation, AEAD authenticated encryption, and replay protection. Never invent cryptographic primitives. First complete a threat model and prove the handshake with interoperability tests before claiming E2EE in marketing.
- Use bounded channels and per-connection/per-task size limits to prevent unbounded memory growth.
- Add heartbeat, exponential backoff with jitter, reconnect grace period, short task TTL, and per-session idle timeout.
- Use increasing sequence numbers and unique IDs for stream ordering and deduplication.
- Explicitly define at-most-once or recoverable semantics for **task creation**. A reconnect must not accidentally start the same destructive task twice.
- Support resumable streamed event delivery only from a bounded, nonsecret buffer with correct acknowledgement semantics; otherwise fail clearly and let the user restart.
- Map ACP errors to actionable categories while retaining a redacted diagnostic code.
- Do not log raw prompts, file contents, provider tokens, or arbitrary tool arguments on the relay by default.
- Do not use `Access-Control-Allow-Origin: *` for privileged browser endpoints; authenticate and authorize all SDK operations.
- Use schema versioning, explicit capability discovery, and forward-compatible parsing.

### What should go through the bridge?

**Allowed first-release operations:**

- Start a user-visible, interactive agent task after authorization.
- Send text and supported content to a selected local ACP agent session.
- Stream agent messages, progress, plans, and tool-call metadata.
- Prompt for permissions locally; allow/deny per policy.
- Cancel and end a running task.
- Query sanitized connection and task status.

**Not allowed in MVP:**

- Remote arbitrary `exec` commands.
- Remote write/read of arbitrary local paths.
- Automatic install/execute of binaries supplied by a web service.
- Arbitrary forwarding of ACP filesystem/terminal operations without local policy enforcement.
- Access to provider credentials, browser cookies, or unrelated user data.
- Broad unattended background task scheduling or bulk inference pipelines.

### ACP scope mapping

The desktop's ACP host translates authorized web task requests into ACP `initialize`/session operations using the adapter's negotiated capabilities. Maintain provider-native streaming semantics and local permission requests. The remote service never directly controls the ACP host's privileged local APIs.

---

## 9. Security model (release-blocking)

### Trust boundaries

Treat as independently untrusted:

1. Remote service and its user-generated prompt content.
2. Network/relay infrastructure.
3. Local agent output and tool output, which may contain adversarial instructions.
4. Deep links and website metadata.
5. Custom ACP adapter binaries.

### Required controls

- **Local consent:** initial pairing, per-task approval by default, and sensitive tool actions always requiring appropriate local consent.
- **Least privilege:** each connection is bound to a user-selected workspace and explicit tool policy; directory traversal and symlink escape checks must be handled with OS-aware canonicalization and sandboxing.
- **Isolation:** restrict execution via provider sandbox when supported; additionally use OS filesystem/process permissions where feasible. Never claim a sandbox exists where it does not.
- **Strong service authentication:** registered service credentials, domain ownership verification, service public key, and per-user binding.
- **Easy kill switch:** globally pause bridge, revoke connection, terminate active tasks, and prevent new ones.
- **Process control:** bounded concurrent agents, CPU/memory/time thresholds where enforceable, clean subprocess-tree termination.
- **No password or token collection:** all provider credentials remain under official provider ownership.
- **Network restrictions:** outbound relay only, TLS verification enabled, no insecure `ws://` in production except bounded localhost dev tests.
- **No prompt injection elevation:** text returned from a web app or file is input, not permission to ignore desktop rules or alter the sandbox.
- **Redaction:** diagnostics and logs must never leak bearer tokens, paths outside allowed scope, or secret environment values.
- **Auditability:** who paired, which origin, when task began, which permissions were granted, task state and error category.
- **DoS controls:** rate limiting, quotas, max task duration, max concurrent tasks, data caps, per-tenant resource budgets.
- **Protect local secrets:** use system credential store only for *our own* relay credentials; no direct access to Claude/Codex auth caches.
- **Updates:** signed releases; integrity validation for downloaded adapters; no silent remote code execution during update.
- **Account removal:** delete local grants and secrets and invalidate relay sessions.

### Security review test cases

- Malicious site sends pairing URL claiming to be another brand.
- Reused or expired pairing ticket.
- Session request by the wrong service/tenant/user.
- Relay replay/reorder/duplicate messages.
- Prompt attempts to access `~/.ssh`, credential stores, browser profiles, or unauthorized parent directories.
- Symlink/hardlink escape from the configured workspace.
- Website tries to run `curl | sh`, mutate system files, or approve its own permission prompt.
- Large payload, fast event flood, unexpected binary content.
- Network loss during an operation with side effects.
- User revokes connection mid-task.
- Adapter crashes, agent crashes, OS suspends, machine sleeps.
- Rogue plugin/adapter executable changed on disk.
- Cross-tenant IDOR, CSRF, SSRF, token leakage in logs.

A release is blocked if any critical case bypasses policy.

---

## 10. Authentication UX and provider policy matrix

| Provider | Install / adapter | Local sign-in | Third-party SaaS with subscription | Default product behavior |
|---|---|---|---|---|
| Codex | `@agentclientprotocol/codex-acp` | Official ChatGPT/Codex sign-in or API key | Requires provider-policy validation for intended use and supported client flow | Expose only validated modes; show plan/usage limits |
| Claude | `@agentclientprotocol/claude-agent-acp` | Official unmodified vendor flow or API key | **Do not assume permitted**; Anthropic restricts third-party subscription routing | API/compliant mode for remote service; subscription gated pending written authorization or a documented allowed scenario |
| Generic ACP | User-installed adapter | As advertised by adapter | Provider-specific | Explicit configuration, no assumption |

**Important implementation distinction:**

A `Connect` button for the *agent provider* initiates provider-owned authentication. A `Connect website` button initiates consent to a website. These are two different trust relationships and must never be conflated.

If a provider doesn't officially support a subscription-backed workflow, display:

> "This connection type isn't available for this provider. You can use a supported API-key or enterprise configuration instead."

Never secretly switch from subscription to billable API mode. Require explicit user selection and explain billing.

---

## 11. Web SDK and SaaS integration

Implement a small, typed TypeScript SDK for the **service backend**, not an unrestricted in-browser gateway.

### SDK interface sketch

```ts
import { RemoteAcp } from '@remote-acp/web-sdk';

const bridge = new RemoteAcp({
  serviceId: process.env.REMOTE_ACP_SERVICE_ID!,
  serviceSecret: process.env.REMOTE_ACP_SERVICE_SECRET!,
  relayUrl: process.env.REMOTE_ACP_RELAY_URL!,
});

// Must be authenticated as the website's own signed-in user.
const pairing = await bridge.createPairing({
  externalUserId: currentUser.id,
  scopes: ['task.interactive'],
  expiresInSeconds: 120,
});

// Show pairing.url or pairing.code in the website UI.

// After the desktop user explicitly accepts the pairing:
const task = await bridge.startTask({
  connectionId: verifiedConnectionId,
  externalUserId: currentUser.id,
  agent: 'codex',
  prompt: 'Summarize these changes.',
  idempotencyKey: crypto.randomUUID(),
});

for await (const event of bridge.streamEvents(task.id)) {
  // Forward sanitized progress to the signed-in website user.
}
```

**This sketch is a product-facing contract to implement, not a claim that this package already exists.** No secrets may be placed in a browser bundle. Provide a separate browser helper for deep links, QR display, and browser-to-own-backend communication.

### Minimal relay / backend APIs (draft)

- `POST /v1/pairings` — registered service creates a short-lived challenge
- `GET /v1/pairings/{id}` — authenticated challenge state
- `POST /v1/pairings/{id}/accept` — authenticated desktop acceptance with verified service identity
- `POST /v1/connections/{id}/revoke` — desktop/user revocation
- `POST /v1/tasks` — create an authorized user-visible task
- `POST /v1/tasks/{id}/cancel` — request cancellation
- `GET /v1/tasks/{id}` — status, scoped to authorized principal
- `GET /v1/tasks/{id}/events` — SSE or supported stream interface
- `GET /healthz` — liveness only; no sensitive state
- `WSS /v1/desktop` — authenticated outbound desktop connection
- `WSS /v1/service` — authenticated service-side connection

Service backend must prove the signed-in end user's identity before selecting any connection, preventing cross-account access.

### Integration demo

Build `examples/nextjs-saas-demo` with:

1. Mock site-user sign-in (clearly labeled demo-only).
2. Connect desktop agent button.
3. One-time QR/deep-link pairing.
4. Approval status display.
5. Chat-like task UI with streaming output.
6. Cancel task button.
7. Permission-handling status and clear errors.

Show both connected and disconnected/revoked states honestly.

---

## 12. Data model

Keep the minimum necessary persistent data locally:

```text
ProviderInstallation
  id, providerType, adapterPath, adapterVersion, availability, checkedAt

ProviderConfiguration
  id, providerId, authMode, selectedModel, status, lastValidatedAt

TrustedService
  id, verifiedOrigin, displayName, servicePublicKey, verificationStatus

ConnectionGrant
  id, serviceId, externalUserBinding, providerId,
  workspaceRoot, scopes, permissionPolicy, expiresAt,
  createdAt, revokedAt

AgentSession
  id, grantId, localSessionReference, providerType,
  currentState, createdAt, lastActivityAt, closedAt

Task
  id, sessionId, serviceRequestId, idempotencyKey,
  state, createdAt, startedAt, finishedAt, failureCode

AuditEvent
  id, connectionId, taskId?, eventType, createdAt, safeMetadata
```

- Use locally generated opaque identifiers; UUID/ULID are suitable.
- Never persist raw provider OAuth access tokens in any of these tables.
- Store workspace paths only where necessary and only on the desktop.
- Persist message transcripts **off by default**; offer local-only encrypted transcript retention as opt-in future work.
- Relay persistence must be a minimal subset with retention policy.

---

## 13. State machines

### Provider

```text
NotInstalled -> Installed -> SignedOut -> Authenticating -> Ready
                   |          |             |          |
                   +----> Broken/Unsupported <----------+
```

`Ready` means a real adapter health/auth check passed; do not infer readiness from existence of a binary alone.

### Connection

```text
PendingPair -> AwaitingLocalApproval -> Active -> Paused -> Revoked
                   |                     |
                   +--> Rejected         +--> Expired/Offline
```

### Task

```text
Created -> AwaitingApproval -> Queued -> Running -> Completed
                |                 |         |
                +--> Rejected     |         +--> Cancelling -> Cancelled
                                  |         +--> Failed
                                  +--> Expired
```

Terminal states must be monotonic; retrying a previously completed request must not silently create duplicate work.

---

## 14. Repository layout

```text
remote-acp-bridge/
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── PLAN.md
├── PROGRESS.md
├── DECISIONS.md
├── SECURITY.md
├── LICENSE
├── apps/
│   ├── desktop/
│   │   ├── src/                     # React/TypeScript UI
│   │   └── src-tauri/               # Rust runtime and native integration
│   └── relay/                       # Rust relay application
├── crates/
│   ├── agent-host/                  # ACP client + subprocess lifecycle
│   ├── connection-policy/           # grants, scopes, approvals
│   ├── bridge-protocol/             # typed envelopes and validation
│   ├── relay-client/                # reconnection and streaming
│   └── secure-store/                # secret-storage interface
├── packages/
│   ├── web-sdk/                     # TypeScript service-backend SDK
│   ├── browser-helper/              # deep links / pairing UI only
│   └── protocol-types/              # generated TS protocol types
├── examples/
│   └── nextjs-saas-demo/
├── tests/
│   ├── fixtures/
│   ├── contract/
│   ├── integration/
│   └── e2e/
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── protocol.md
│   ├── provider-compliance.md
│   ├── deployment.md
│   └── troubleshooting.md
└── .github/workflows/
```

Avoid circular crate dependencies. Keep Rust protocol and security code UI-framework-independent.

---

## 15. Detailed implementation roadmap

### Phase 0 — Research, feasibility, constraints

Deliverables:

- Verify latest ACP v1 SDK, handshake and adapter compatibility against primary documentation.
- Confirm maintained Codex and Claude ACP adapter behavior and supported authentication options.
- Produce provider policy/terms matrix covering subscription, API-key, local vs remote, and commercial use.
- Confirm architecture/threat model, explicitly separating desktop ACP host from remote service.
- Decide exact package/version pinning and platform prerequisites.

**Gate:** no assumptions that consumer subscriptions are generic backend API credits.

### Phase 1 — Desktop foundation

Deliverables:

- Working Tauri 2 app with React/TypeScript UI.
- Native window chrome, menu, tray, dark/light theme, polished sidebar.
- Dashboard, provider detail, connections, activity, settings and onboarding screens.
- Rust command/event bridge and SQLite migrations.
- macOS/Windows/Linux build checks in CI.

**Gate:** polished desktop app starts on all three platform families.

### Phase 2 — Local ACP lifecycle

Deliverables:

- Rust ACP client with a deterministic mock ACP agent subprocess.
- `initialize`, version/capability negotiation, sessions, prompt, updates, permissions, cancellation.
- Binary detection and process lifecycle.
- Interactive task UI driven by *actual streamed agent events*.
- Unit/integration tests for parser, timeouts, malformed frames, request matching, crash cleanup.

**Gate:** full local task works with real stream and cancel, without relay.

### Phase 3 — Provider integrations

Deliverables:

- Codex ACP adapter integration.
- Official Codex login flow and real auth status.
- Claude adapter integration with only permitted auth configurations.
- Provider installation diagnostics and dependency checks.
- Provider-specific capability handling.

**Gate:** end-to-end supported provider scenario works with official authentication; restrictions clearly identified.

### Phase 4 — Relay and secure pairing

Deliverables:

- Hosted/local relay proof of concept with authenticated WSS connections.
- Registered service identity, one-use pairing, local user consent, scoped grants.
- Simple service-backend SDK and a browser deep-link helper.
- Reconnection, heartbeats, idempotency, revocation, quotas.
- Security tests for wrong identity, replay, expired link and tenant isolation.

**Gate:** website can reach **only its paired user** and only within granted task scope.

### Phase 5 — Real website demo

Deliverables:

- Next.js example website with pairing, streaming task output and cancellation.
- Local permission approval UI shown when required.
- Clear disconnected, paused, failed and expired states.
- One-click reconnect with fresh authorization where necessary.

**Gate:** novice can perform the 3-step flow without terminal usage after official agent setup.

### Phase 6 — Hardening

Deliverables:

- Formal threat-model review and remote request allowlist.
- Workspace/sandbox enforcement and symlink escape testing.
- Cryptographic transport design and tests before any E2EE claims.
- Sanitized logs, audit events, resource limits, error recovery.
- Code signing, installer security, update strategy.

**Gate:** all critical security scenarios pass; no exposed open proxy or auth-token harvesting.

### Phase 7 — Launch quality

Deliverables:

- Consistent native UI polish and accessibility passes.
- macOS notarized build; Windows signed installer when available; Linux packages.
- User documentation, support diagnostics, clean uninstaller.
- Privacy policy and provider compatibility disclosure.
- Release automation, artifact checksums and reproducible version tags.

**Gate:** real-world signed/release builds tested on clean devices.

---

## 16. Acceptance tests / Definition of Done

The product is not complete until all of these are demonstrated:

1. Install desktop app on a clean macOS, Windows, and Linux environment.
2. Detect a supported real local agent or guide its official installation.
3. Authenticate by **official provider flows**; show accurate auth and compatibility status.
4. Open a pairing link from a real browser into the desktop app.
5. Verify website identity and explicitly consent to a scoped connection.
6. Start an interactive task from the paired website backend.
7. Create actual local ACP session and receive live response events at the website.
8. Display task activity and agent/tool progress in the desktop app.
9. Trigger a permission request and approve/deny it locally (with correct remote result).
10. Cancel from the website and from the desktop; both stop execution correctly.
11. Revoke a website; subsequent requests are rejected immediately.
12. Lose connection; reconnect without duplicate destructive tasks.
13. Handle signed-out/expired provider auth without reporting a false success.
14. Prevent access outside the selected workspace and other forbidden tool actions.
15. Prove no provider tokens are transmitted to the relay or third-party website.
16. Pass protocol, security, integration and UI test suites.
17. Show usable light/dark mode and responsive UI on all three desktop OS families.
18. Produce installable artifacts with clear release documentation and limitations.

### Performance goals (targets, not assertions)

- Desktop cold-start to usable UI: aim for < 2 s on a modern machine, excluding installer/first-run dependencies.
- Idle memory: aim for < 150 MB app overhead where feasible; measure separately from running agent subprocesses.
- UI interaction responsiveness: < 100 ms perceived response to typical user actions.
- Forward the first available agent event to the paired website promptly; measure event relay latency separately from model inference time.
- Relay must use bounded memory per connection, backpressure, and realistic concurrent-connection testing before production SLA claims.

---

## 17. Explicit edge cases

- Browser opens pairing link but application is not installed.
- CLI exists but ACP adapter is not installed.
- Adapter exists but is on an unsupported version.
- CLI is installed under a custom path or multiple installations exist.
- Windows path quoting, Unicode working directories, WSL installation confusion.
- Mac app sandbox or system permissions prevent subprocess execution.
- Linux keyring unavailable; no insecure secret fallback without explicit warning.
- Agent is signed in but subscription quotas have been reached.
- Provider supports one auth mode but not another.
- Local desktop goes to sleep; user closes lid or changes networks.
- Relay restarts; stale session route; duplicate frames; dead service process.
- Website logs out or switches tenant during an active task.
- Multiple web tabs try to control the same session.
- User launches multiple desktop app instances.
- User switches default provider mid-task.
- File paths differ across platforms; remote site must not assume local path syntax.
- A task asks for a permission while desktop window is hidden.
- User denies a sensitive permission request.
- Agent tries a subprocess action unsupported by current sandbox policy.
- Unexpected agent-auth challenge or adapter version changes.
- Large agent output or attachments exceed transport limits.
- User revokes a website while messages are already in flight.

Each case must produce a correct state transition and actionable error.

---

## 18. Monetization / deployment principles

The bridge is a user-facing desktop product, not a seller of third-party AI usage.

Reasonable later business models:

- Free local app + self-hosted relay option.
- Paid hosted relay for routing, availability, administration, and secure team features.
- Paid enterprise features: device policy, organizational service approvals, audit tools, SSO.
- SDK/hosted integration plans charged for *bridge infrastructure*, not hidden Claude/Codex token consumption.

Don't charge users for a provider subscription they already own or misrepresent a provider's permitted usage rights. Billing for relay features does not grant permission to route an AI provider's consumer subscription.

---

## 19. What not to overengineer

- Do not build a complete custom ACP agent implementation; use existing adapters.
- Do not start with peer-to-peer NAT traversal or a distributed message broker.
- Do not require a user account for a purely local demo if a local dev relay and controlled test identity suffice.
- Do not ship a generic, open-access `POST /chat/completions` endpoint backed by consumer subscriptions.
- Do not include a full IDE/editor inside the desktop app.
- Do not store complete transcripts on the relay to make reconnect easier.
- Do not auto-grant unrestricted local files, terminals, networks, or MCP servers.
- Do not introduce large infra dependencies before benchmarking a single relay node.

Prioritize: **secure useful connection > reliable agent execution > easy UX > polish > scalability**. Maintain excellent UI quality throughout, not only at the end.

---

## 20. Required output from the coding agent

After reading this document, start implementation. In your first reply, provide a concise execution summary covering:

1. The chosen workspace layout and major components.
2. Any confirmed incompatibility between the requested subscription use case and provider terms.
3. The first vertical slice to implement.
4. Concrete tests that will prove that slice is working.

Then **write the code and tests**, not just an explanation. Update `PROGRESS.md` at meaningful checkpoints and include the actual build/test results. If a third-party integration needs credentials you cannot access, implement the integration with fixtures and precise configuration steps; do not fake authenticated end-to-end success.

### Development sequence for the first coding pass

```text
1. Scaffold Tauri 2 desktop and Rust workspace.
2. Establish UI design system and basic screens.
3. Implement typed ACP mock agent + Rust ACP process manager.
4. Demonstrate local streaming and cancel in UI.
5. Implement relay with registered service and paired desktop.
6. Implement Next.js demo with real task streaming.
7. Add local approvals, revocation, diagnostics, reconnection.
8. Integrate maintained Codex ACP adapter and official login.
9. Integrate Claude adapter with provider-compliant auth modes only.
10. Harden, test, package, document.
```

**Do not claim the app is finished until the acceptance tests above actually pass.**

---

## 21. Primary references (verify versions before coding)

- ACP official introduction: https://agentclientprotocol.com/get-started/introduction
- ACP v1 transport: https://agentclientprotocol.com/protocol/v1/transports
- ACP official specification and libraries: https://github.com/agentclientprotocol/agent-client-protocol
- ACP Codex adapter (maintained): https://github.com/agentclientprotocol/codex-acp
- ACP Claude Agent adapter (maintained): https://github.com/agentclientprotocol/claude-agent-acp
- Codex sign-in and plan documentation: https://learn.chatgpt.com/docs/auth
- Codex in ChatGPT plans: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- Claude Code legal/auth restrictions: https://code.claude.com/docs/en/legal-and-compliance
- Tauri 2 docs: https://v2.tauri.app/

**Terminology warning:** There are unrelated open-source specifications also abbreviated "ACP" (including "Agent Control Protocol"). This project means only **Agent Client Protocol**, maintained at `agentclientprotocol.com`.

**Provider availability, pricing, eligibility, legal terms, and branding requirements may change. Recheck them before commercial distribution.**
