// Covers every screen and action of the desktop UI against a mocked engine API.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostics, GrantView, ProviderView, Snapshot } from "./lib/types";

const calls: Record<string, unknown[][]> = {};
let snapshot: Snapshot;
let failNext: string | null = null;

const diagnostics: Diagnostics = {
  appVersion: "0.1.0", os: "macos", arch: "aarch64", relayUrl: "http://127.0.0.1:8787",
  relay: { state: "connected", latencyMs: 4 }, desktopId: "dsk_1", secretBackend: "app data file (owner-only)",
  secretBackendSecure: true, bridgeProtocolVersion: 1, acpProtocolVersion: 1, providers: [],
  sessions: [{ key: "conn_1", providerId: "claude", agentName: "@agentclientprotocol/claude-agent-acp", agentVersion: "0.100.0", protocolVersion: 1, authMethods: [], modes: ["default", "acceptEdits"], currentMode: "default", sandboxEnforced: true, alive: true, stderrTail: ["ready"] }],
  recentErrors: ["12:00:00 relay: test error"],
  audit: [{ id: 1, connectionId: "conn_1", taskId: null, eventType: "connection_granted", createdAt: new Date().toISOString(), metadata: { provider: "claude" } }],
};

vi.mock("./lib/api", () => {
  const rec = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    if (failNext === name) {
      failNext = null;
      return Promise.reject(new Error(`${name} failed for test`));
    }
    if (name === "diagnostics") return Promise.resolve(diagnostics);
    if (name === "updateSettings") return Promise.resolve(args[0]);
    return Promise.resolve(undefined);
  };
  return {
    ApiError: Error,
    api: new Proxy({}, { get: (_t, prop: string) => (prop === "snapshot" ? () => Promise.resolve(snapshot) : rec(prop)) }),
    onBridgeEvent: () => Promise.resolve(() => {}),
    pickFolder: () => Promise.resolve("/Users/alex/Projects/site"),
    pickFile: () => Promise.resolve("/usr/local/bin/my-acp-agent"),
    openExternal: rec("openExternal"),
  };
});

import { App } from "./App";

const prov = (id: string, over: Partial<ProviderView> = {}): ProviderView => ({
  id, name: { codex: "Codex", claude: "Claude Code", mock: "Test agent" }[id] ?? id, description: "", state: "ready",
  cliPath: null, cliVersion: "1.0", adapterVersion: "1", adapterPinned: "1", authMode: "subscription", authLabel: "Plan",
  policy: { remote: "allowed", note: "" }, statusMessage: "Ready", actions: ["recheck", "sign_out", "install_adapter"], verified: true, ...over,
});

const grant = (over: Partial<GrantView> = {}): GrantView => ({
  connectionId: "conn_1", service: { id: "svc_a", displayName: "Acme Notes", origin: "https://acme.example", domain: "acme.example", verified: true },
  externalUserId: "u-1", providerId: "claude", workspace: "/Users/alex/Projects/site", scopes: ["task.interactive"], requireTaskApproval: true,
  access: "read_only", expiresAt: new Date(Date.now() + 86400e3).toISOString(), status: "active", expired: false,
  createdAt: new Date().toISOString(), lastActiveAt: null, busy: false, ...over,
});

function base(): Snapshot {
  return {
    bridge: { paused: false, relay: { state: "connected", latencyMs: 3 }, relayUrl: "http://127.0.0.1:8787", desktopId: "dsk_1", activity: "idle" },
    providers: [prov("mock", { authMode: "none", authLabel: null, actions: [] }), prov("codex"), prov("claude")],
    grants: [], pairingRequests: [], tasks: [], permissions: [],
    settings: { relayUrl: "http://127.0.0.1:8787", defaultProvider: null, requireTaskApprovalDefault: true, notifications: true, launchAtLogin: false, keepInTray: true, theme: "system", sessionIdleMinutes: 15, customAgents: [], codexSubscriptionAcknowledged: false },
  };
}

async function go(label: RegExp) {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  snapshot = base();
  failNext = null;
  localStorage.setItem("rab.onboarded.v1", "1");
});

describe("AI Providers screen", () => {
  it("lists all providers with no API-key UI", async () => {
    await go(/^AI Providers/);
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText(/API key/i)).toBeNull();
    expect(screen.queryByText(/Website use/)).toBeNull();
  });

  it("install, sign-in, sign-out and recheck call the engine", async () => {
    snapshot.providers = [prov("claude", { state: "signed_out", authMode: "none", actions: ["recheck", "sign_in"] }), prov("codex", { state: "installed", actions: ["recheck", "install_adapter"] })];
    await go(/^AI Providers/);
    fireEvent.click(await screen.findByRole("button", { name: /Sign in to Claude/ }));
    await waitFor(() => expect(calls.signIn?.[0]).toEqual(["claude"]));
    fireEvent.click(screen.getByRole("button", { name: /Install connector/ }));
    await waitFor(() => expect(calls.installAdapter?.[0]).toEqual(["codex"]));
    fireEvent.click(screen.getByRole("button", { name: /Recheck/ }));
    await waitFor(() => expect(calls.refreshProviders).toBeTruthy());
  });

  it("sign out and install-missing-CLI links", async () => {
    snapshot.providers = [prov("claude"), prov("codex", { state: "not_installed", actions: ["recheck", "open_codex_install"] })];
    await go(/^AI Providers/);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls.signOut?.[0]).toEqual(["claude"]));
    fireEvent.click(screen.getByRole("button", { name: /Install Codex/ }));
    await waitFor(() => expect(String(calls.openExternal?.[0]?.[0])).toContain("codex"));
  });

  it("adds a custom ACP agent", async () => {
    await go(/^AI Providers/);
    fireEvent.click(await screen.findByRole("button", { name: /Add another ACP agent/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect((screen.getByLabelText("Executable") as HTMLInputElement).value).toBe("/usr/local/bin/my-acp-agent"));
    fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: "--acp --verbose" } });
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(calls.addCustomAgent?.[0]).toEqual(["My agent", "/usr/local/bin/my-acp-agent", ["--acp", "--verbose"]]));
  });

  it("shows engine errors as a toast", async () => {
    snapshot.providers = [prov("codex", { state: "installed", actions: ["install_adapter"] })];
    failNext = "installAdapter";
    await go(/^AI Providers/);
    fireEvent.click(await screen.findByRole("button", { name: /Install connector/ }));
    expect(await screen.findByText("installAdapter failed for test")).toBeTruthy();
  });
});

describe("Connected Websites screen", () => {
  it("connect by code opens the pairing sheet and calls the engine", async () => {
    await go(/^Connected Websites/);
    fireEvent.click(screen.getAllByRole("button", { name: /Connect a website/ })[0]);
    const input = await screen.findByLabelText("Pairing link or code");
    fireEvent.change(input, { target: { value: "ABCDE-12345" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(calls.beginPairing?.[0]).toEqual(["ABCDE-12345"]));
  });

  it("pause, approval toggle, access level and disconnect", async () => {
    snapshot.grants = [grant()];
    await go(/^Connected Websites/);
    fireEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(calls.setGrantPaused?.[0]).toEqual(["conn_1", true]));
    fireEvent.click(screen.getByRole("switch", { name: "Ask before each task" }));
    await waitFor(() => expect(calls.updateGrant?.[0]).toEqual(["conn_1", false, "read_only"]));
    fireEvent.click(screen.getByRole("button", { name: "Can edit" }));
    await waitFor(() => expect(calls.updateGrant?.[1]).toEqual(["conn_1", true, "workspace_write"]));
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/ }));
    expect(calls.revokeGrant).toBeUndefined(); // needs confirmation
    fireEvent.click(screen.getByRole("button", { name: /Confirm disconnect/ }));
    await waitFor(() => expect(calls.revokeGrant?.[0]).toEqual(["conn_1"]));
  });

  it("paused, revoked and expired connections render honestly; old ones can be removed", async () => {
    snapshot.grants = [grant({ status: "paused" }), grant({ connectionId: "conn_2", status: "revoked" }), grant({ connectionId: "conn_3", expired: true })];
    await go(/^Connected Websites/);
    expect(await screen.findByRole("button", { name: /Resume/ })).toBeTruthy();
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByText("Previously connected")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Remove/ })[0]);
    await waitFor(() => expect(calls.forgetGrant?.[0]?.[0]).toMatch(/conn_[23]/));
  });

  it("unverified websites are flagged", async () => {
    snapshot.grants = [grant({ service: { id: "svc_b", displayName: "Shady", origin: "http://localhost:4000", domain: "localhost", verified: false } })];
    await go(/^Connected Websites/);
    expect(await screen.findByText("Unverified")).toBeTruthy();
  });
});

describe("Settings, Diagnostics and Help", () => {
  it("every setting is saved through the engine", async () => {
    await go(/^Settings/);
    fireEvent.click(await screen.findByRole("switch", { name: "Launch at login" }));
    await waitFor(() => expect((calls.updateSettings?.[0]?.[0] as { launchAtLogin: boolean }).launchAtLogin).toBe(true));
    fireEvent.click(screen.getByRole("switch", { name: "Notifications" }));
    await waitFor(() => expect((calls.updateSettings?.[1]?.[0] as { notifications: boolean }).notifications).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    await waitFor(() => expect((calls.updateSettings?.[2]?.[0] as { theme: string }).theme).toBe("light"));
    fireEvent.change(screen.getByLabelText("Default provider"), { target: { value: "claude" } });
    await waitFor(() => expect((calls.updateSettings?.[3]?.[0] as { defaultProvider: string }).defaultProvider).toBe("claude"));
    fireEvent.change(screen.getByLabelText("Idle timeout"), { target: { value: "60" } });
    await waitFor(() => expect((calls.updateSettings?.[4]?.[0] as { sessionIdleMinutes: number }).sessionIdleMinutes).toBe(60));
    fireEvent.change(screen.getByLabelText("Relay address"), { target: { value: "https://relay.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect((calls.updateSettings?.[5]?.[0] as { relayUrl: string }).relayUrl).toBe("https://relay.example.com"));
    expect(screen.queryByText(/Keep running when the window is closed/)).toBeNull();
  });

  it("security: pause bridge and disconnect all (with confirmation)", async () => {
    await go(/^Settings/);
    fireEvent.click(await screen.findByRole("switch", { name: "Bridge paused" }));
    await waitFor(() => expect(calls.setPaused?.[0]).toEqual([true]));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect all" }));
    expect(calls.revokeAll).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.revokeAll).toBeTruthy());
  });

  it("diagnostics shows relay, sessions, errors and audit; refresh and clear work", async () => {
    await go(/^Settings/);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText(/claude-agent-acp 0.100.0/)).toBeTruthy();
    expect(screen.getByText("restricted")).toBeTruthy();
    expect(screen.getByText(/relay: test error/)).toBeTruthy();
    expect(screen.getByText("connection_granted")).toBeTruthy();
    expect(screen.getByText("app data file (owner-only)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(calls.diagnostics.length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));
    await waitFor(() => expect(calls.clearDiagnostics).toBeTruthy());
  });

  it("help explains background running and providers", async () => {
    await go(/^Help/);
    expect(await screen.findByText(/keeps the app running in the background/)).toBeTruthy();
    expect(screen.getByText(/official ACP adapters/)).toBeTruthy();
  });
});

describe("Overview and states", () => {
  it("paused and offline states", async () => {
    snapshot.bridge = { ...snapshot.bridge, paused: true };
    const { unmount } = render(<App />);
    expect((await screen.findAllByText("Bridge is paused")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    await waitFor(() => expect(calls.setPaused?.[0]).toEqual([false]));
    unmount();
    snapshot = base();
    snapshot.bridge.relay = { state: "disconnected", message: "Can't reach the relay" };
    render(<App />);
    expect((await screen.findAllByText("Offline")).length).toBeGreaterThan(0);
  });

  it("decline from the tray and deny a permission", async () => {
    snapshot.tasks = [{ id: "t1", source: "remote", connectionId: "conn_1", serviceName: "Acme", serviceDomain: "acme.example", providerId: "codex", workspace: "/w", state: "awaiting_approval", prompt: "do x", transcript: [], createdAt: new Date().toISOString(), finishedAt: null, stopReason: null, error: null }];
    snapshot.permissions = [{ requestId: "p1", taskId: "t0", title: "Run command", kind: "execute", details: null, canAllowForTask: false, serviceName: "Acme", createdAt: new Date().toISOString() }];
    render(<App />);
    const tray = await screen.findByRole("region", { name: "Requests waiting for you" });
    expect(within(tray).queryByRole("button", { name: "Allow for this task" })).toBeNull(); // execute must be approved each time
    await act(async () => fireEvent.click(within(tray).getByRole("button", { name: "Deny" })));
    expect(calls.respondPermission[0]).toEqual(["p1", "deny"]);
    await act(async () => fireEvent.click(within(tray).getByRole("button", { name: "Decline" })));
    expect(calls.approveTask[0]).toEqual(["t1", false]);
  });

  it("activity sends a local task with the chosen agent and folder", async () => {
    await go(/^Activity/);
    fireEvent.change(await screen.findByLabelText("Agent"), { target: { value: "claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect((screen.getByLabelText("Project folder") as HTMLInputElement).value).toBe("/Users/alex/Projects/site"));
    fireEvent.change(screen.getByPlaceholderText(/Try your agent locally/), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.startLocalTask?.[0]).toEqual(["claude", "/Users/alex/Projects/site", "hello"]));
  });
});

describe("Activity chat", () => {
  it("renders markdown safely, groups tool steps, shows site customization", async () => {
    snapshot.tasks = [{
      id: "t9", source: "remote", connectionId: "conn_1", serviceName: "Acme Notes", serviceDomain: "acme.example", providerId: "claude",
      workspace: "/Users/alex/Projects/site", state: "completed", prompt: "Summarize", instructions: "You are the Acme assistant.", tools: ["acme (https://acme.example/mcp)"],
      transcript: [
        { type: "user", text: "Summarize" },
        { type: "tool", toolCallId: "a", title: "Read README.md", kind: "read", status: "completed" },
        { type: "tool", toolCallId: "b", title: "acme: lookup_note", kind: "fetch", status: "completed" },
        { type: "agent", text: "## Summary\nThe app uses **Rust** and `tokio`.\n- one\n- two\n```rust\nfn main() {}\n```\n<img src=x onerror=alert(1)>" },
      ],
      createdAt: new Date().toISOString(), finishedAt: null, stopReason: "end_turn", error: null,
    }];
    await go(/^Activity/);
    expect(await screen.findByText("2 steps")).toBeTruthy();
    expect(screen.getByText("Read README.md")).toBeTruthy();
    expect(screen.getByText("Rust").tagName).toBe("STRONG");
    expect(screen.getByText("tokio").tagName).toBe("CODE");
    expect(screen.getByText("fn main() {}").tagName).toBe("PRE");
    // Raw HTML from the agent stays text.
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Customized by Acme Notes/ }));
    expect(screen.getByText("You are the Acme assistant.")).toBeTruthy();
    expect(screen.getByText("acme (https://acme.example/mcp)")).toBeTruthy();
  });

  it("consent sheet mentions website tools when requested", async () => {
    snapshot.pairingRequests = [{
      pairingId: "pair_t", service: { id: "svc_a", displayName: "Acme Notes", origin: "https://acme.example", domain: "acme.example", verified: true, verification: "operator" },
      externalUserId: "u", scopes: ["task.interactive", "agent.tools"], expiresAt: new Date(Date.now() + 600e3).toISOString(), receivedAt: new Date().toISOString(),
    }];
    render(<App />);
    expect(await screen.findByText(/Give the agent its own tools \(MCP servers on acme.example\)/)).toBeTruthy();
  });
});
