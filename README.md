# Remote ACP Bridge

**Use an AI agent on your computer from a trusted website, while keeping control of authentication, files, permissions and execution on your machine.**

- **Desktop app** (Tauri 2 + React, macOS/Windows/Linux): detects Codex / Claude Code, installs their verified ACP connectors, runs them locally over ACP v1, and mediates every website request through your consent.
- **Relay** (Rust/Axum): outbound-only routing between paired desktops and registered websites. Never sees provider credentials, stores no prompts.
- **Web SDK** (`@remote-acp/web-sdk`): server-side TypeScript client for websites, plus a browser helper and a demo site.

See `PLAN.md` for the product spec, `docs/` for architecture, protocol, threat model, compliance and deployment.

## Quick start (local, all on one machine)

Prerequisites: Rust (stable), Node.js 22+, pnpm 9. macOS: Xcode CLT. Linux: WebKitGTK 4.1 dev packages.

```sh
pnpm install
pnpm -r --filter '!remote-acp-desktop' build
pnpm --dir apps/desktop install --ignore-workspace

# 1. relay on 127.0.0.1:8787 (registers the demo website "svc_demo")
pnpm --filter @remote-acp/web-demo relay

# 2. demo website on http://127.0.0.1:3000 (PORT=… to change)
pnpm --filter @remote-acp/web-demo dev

# 3. desktop app (dev) — or build: pnpm --dir apps/desktop tauri build
pnpm --dir apps/desktop tauri dev
```

Open the demo website, sign in with any demo name, click **Connect desktop agent**. The link opens the app (in a built `.app`; in `tauri dev` paste the link or code via *Connect a website*). Approve the request, choose a project folder and an agent ("Test agent" works without any AI account), then send a prompt from the website. Try the prompts `permission` and `slow` to see local permission prompts and cancellation.

Real agents: in **AI Providers**, click *Install connector* (pinned official ACP adapters: codex-acp 2.5.0, claude-agent-acp 0.100.0) and sign in with the official flow (`codex login` / `claude auth login`). No API keys are used.

## Website integration

```ts
import { RemoteAcp } from "@remote-acp/web-sdk";
const bridge = new RemoteAcp({ serviceId, serviceSecret, relayUrl });
const pairing = await bridge.createPairing({ externalUserId: user.id });   // show pairing.url / pairing.code
const { connectionId } = await bridge.waitForPairing(pairing.pairingId);
const task = await bridge.startTask({ connectionId, externalUserId: user.id, prompt, idempotencyKey: crypto.randomUUID() });
for await (const ev of bridge.streamEvents(task.taskId)) { /* text_delta, plan, tool_call, permission_pending, … */ }
```

Register the website in the relay config (`docs/deployment.md`). Websites can only start interactive tasks, observe progress, cancel, and revoke. They cannot run commands, reach files outside the folder the user chose, or answer permission prompts.

## Tests

```sh
cargo test --workspace                                   # 46 tests: protocol, ACP host, policy, relay+bridge E2E
pnpm -r --filter '!remote-acp-desktop' test              # 66 tests: protocol types, SDK, helper, demo, Node E2E (real relay + headless desktop)
pnpm --dir apps/desktop test                             # 7 desktop UI component tests
cargo test -p e2e-tests --test real_codex -- --ignored   # real Codex through the bridge (uses your Codex login)
```

## Layout

```
apps/desktop        Tauri app (src = React UI, src-tauri = Rust shell)
apps/relay          relay server
crates/             bridge-protocol, agent-host, connection-policy, bridge-core
packages/           web-sdk, browser-helper, protocol-types
examples/web-demo   demo website
tests/              contract fixtures, Rust E2E, Node E2E
docs/               architecture, protocol, threat model, compliance, deployment, troubleshooting
```

Status and known limitations: `PROGRESS.md`. Security model: `SECURITY.md`.
