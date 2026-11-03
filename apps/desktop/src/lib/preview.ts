// Static sample data for previewing the UI in a normal browser
// (`vite` dev server with `?preview`). Never used inside the Tauri app.
import type { Snapshot } from "./types";

const now = Date.now();
const iso = (ms: number) => new Date(now + ms).toISOString();

const answer = `Here's a quick security review of **acme-notes**.

## Findings
1. **Session cookie lacks \`Secure\`**: \`src/server/session.ts:42\` sets the cookie without \`Secure\`, so it can leak over plain HTTP.
2. **Unvalidated redirect**: \`/login?next=\` accepts absolute URLs.
3. No issues found in the SQL layer: all queries are parameterized.

## Suggested fix
\`\`\`ts
res.cookie("sid", id, { httpOnly: true, secure: true, sameSite: "lax" });
\`\`\`

I checked today's notes with the **acme** tool. They match the release checklist.`;

export const previewSnapshot: Snapshot = {
  bridge: { paused: false, relay: { state: "connected", latencyMs: 18 }, relayUrl: "https://relay.example.com", desktopId: "dsk_preview", activity: "working" },
  providers: [
    { id: "mock", name: "Test agent", description: "Built-in agent for trying the bridge. Does not use AI.", state: "ready", cliPath: null, cliVersion: null, adapterVersion: "built-in", adapterPinned: null, authMode: "none", authLabel: null, policy: { remote: "allowed", note: "" }, statusMessage: "Ready", actions: [], verified: true },
    { id: "codex", name: "Codex", description: "OpenAI's coding agent, via the official ACP adapter.", state: "ready", cliPath: "/opt/homebrew/bin/codex", cliVersion: "codex-cli 0.155.1", adapterVersion: "2.5.0", adapterPinned: "2.5.0", authMode: "subscription", authLabel: "ChatGPT", policy: { remote: "allowed", note: "" }, statusMessage: "Signed in (ChatGPT)", actions: ["recheck", "sign_out", "install_adapter"], verified: true },
    { id: "claude", name: "Claude Code", description: "Anthropic's Claude Code agent, via the official ACP adapter.", state: "ready", cliPath: "/opt/homebrew/bin/claude", cliVersion: "2.1.316 (Claude Code)", adapterVersion: "0.100.0", adapterPinned: "0.100.0", authMode: "subscription", authLabel: "Claude Max", policy: { remote: "allowed", note: "" }, statusMessage: "Signed in (Claude Max)", actions: ["recheck", "sign_out", "install_adapter"], verified: true },
  ],
  grants: [
    { connectionId: "conn_preview", service: { id: "svc_acme", displayName: "Acme Notes", origin: "https://app.acme-notes.com", domain: "app.acme-notes.com", verified: true }, externalUserId: "user-1842", providerId: "claude", workspace: "~/Projects/acme-notes", scopes: ["task.interactive", "agent.tools"], requireTaskApproval: true, access: "read_only", expiresAt: iso(86400e3), status: "active", expired: false, createdAt: iso(-3600e3), lastActiveAt: iso(-20e3), busy: true },
  ],
  pairingRequests: [],
  tasks: [
    {
      id: "task_preview", source: "remote", connectionId: "conn_preview", serviceName: "Acme Notes", serviceDomain: "app.acme-notes.com", providerId: "claude",
      workspace: "~/Projects/acme-notes", state: "completed", prompt: "Run a security review of this project and check today's release notes.",
      instructions: "You are the Acme Notes review assistant. Be concise, cite file:line, never modify files.",
      tools: ["acme (https://app.acme-notes.com/mcp)"],
      transcript: [
        { type: "user", text: "Run a security review of this project and check today's release notes." },
        { type: "plan", entries: [
          { content: "Map the server code and auth flow", status: "completed" },
          { content: "Review cookies, redirects and SQL", status: "completed" },
          { content: "Cross-check today's release notes", status: "completed" },
        ] },
        { type: "tool", toolCallId: "t1", title: "Search \"cookie\" in ./src", kind: "search", status: "completed" },
        { type: "tool", toolCallId: "t2", title: "Read ./src/server/session.ts", kind: "read", status: "completed" },
        { type: "tool", toolCallId: "t3", title: "Read ./src/routes/login.ts", kind: "read", status: "completed" },
        { type: "permission", requestId: "p1", title: "Use tool acme: get_release_notes", outcome: "allowed" },
        { type: "tool", toolCallId: "t4", title: "acme · get_release_notes", kind: "fetch", status: "completed" },
        { type: "agent", text: answer },
      ],
      createdAt: iso(-90e3), finishedAt: iso(-10e3), stopReason: "end_turn", error: null,
    },
    { id: "task_old1", source: "remote", connectionId: "conn_preview", serviceName: "Acme Notes", serviceDomain: "app.acme-notes.com", providerId: "claude", workspace: "~/Projects/acme-notes", state: "completed", prompt: "Explain the architecture of this project", transcript: [], createdAt: iso(-1800e3), finishedAt: null, stopReason: "end_turn", error: null },
    { id: "task_old2", source: "local", connectionId: null, serviceName: null, serviceDomain: null, providerId: "codex", workspace: "~/Projects/acme-notes", state: "cancelled", prompt: "Write a test plan for the sync module", transcript: [], createdAt: iso(-5400e3), finishedAt: null, stopReason: "cancelled", error: null },
  ],
  permissions: [],
  settings: { relayUrl: "https://relay.example.com", defaultProvider: "claude", requireTaskApprovalDefault: true, notifications: true, launchAtLogin: false, keepInTray: true, theme: "system", sessionIdleMinutes: 15, customAgents: [], codexSubscriptionAcknowledged: true },
};

export const isPreview = (): boolean =>
  typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window) && new URLSearchParams(window.location.search).has("preview");
