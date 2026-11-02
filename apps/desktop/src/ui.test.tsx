import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "./lib/types";

const calls: Record<string, unknown[][]> = {};
let snapshot: Snapshot;

vi.mock("./lib/api", () => {
  const rec =
    (name: string, ret: unknown = undefined) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return Promise.resolve(ret);
    };
  return {
    ApiError: Error,
    api: new Proxy(
      {},
      {
        get: (_t, prop: string) => (prop === "snapshot" ? () => Promise.resolve(snapshot) : rec(prop)),
      },
    ),
    onBridgeEvent: () => Promise.resolve(() => {}),
    pickFolder: () => Promise.resolve("/Users/alex/Projects/site"),
    pickFile: () => Promise.resolve(null),
    openExternal: rec("openExternal"),
  };
});

import { App } from "./App";

const provider = (id: string, over: Partial<Snapshot["providers"][number]> = {}) => ({
  id,
  name: id === "codex" ? "Codex" : id === "mock" ? "Test agent" : "Claude Code",
  description: "",
  state: "ready" as const,
  cliPath: null,
  cliVersion: null,
  adapterVersion: "1",
  adapterPinned: null,
  authMode: "none" as const,
  authLabel: null,
  policy: { remote: "allowed" as const, note: "ok" },
  statusMessage: "Ready",
  actions: [],
  verified: true,
  ...over,
});

function baseSnapshot(): Snapshot {
  return {
    bridge: { paused: false, relay: { state: "connected", latencyMs: 12 }, relayUrl: "http://127.0.0.1:8787", desktopId: "dsk_1", activity: "idle" },
    providers: [provider("mock")],
    grants: [],
    pairingRequests: [],
    tasks: [],
    permissions: [],
    settings: {
      relayUrl: "http://127.0.0.1:8787",
      defaultProvider: null,
      requireTaskApprovalDefault: true,
      notifications: true,
      launchAtLogin: false,
      keepInTray: false,
      theme: "system",
      sessionIdleMinutes: 15,
      customAgents: [],
      codexSubscriptionAcknowledged: false,
    },
  };
}

const future = () => new Date(Date.now() + 600_000).toISOString();

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  snapshot = baseSnapshot();
  localStorage.setItem("rab.onboarded.v1", "1");
});

describe("desktop UI", () => {
  it("shows bridge status and providers on the overview", async () => {
    render(<App />);
    expect((await screen.findAllByText("Bridge is on")).length).toBe(2);
    expect(screen.getByText("12 ms")).toBeTruthy();
    expect(screen.getAllByText("Test agent").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(calls.setPaused?.[0]).toEqual([true]));
  });

  it("shows onboarding on first run", async () => {
    localStorage.removeItem("rab.onboarded.v1");
    render(<App />);
    expect(await screen.findByText("Connect your AI agent to websites securely.")).toBeTruthy();
  });

  it("consent sheet requires a folder and sends the chosen options", async () => {
    snapshot.pairingRequests = [
      {
        pairingId: "pair_1",
        service: { id: "svc_a", displayName: "Acme Notes", origin: "https://acme.example", domain: "acme.example", verified: true, verification: "operator" },
        externalUserId: "u-42",
        scopes: ["task.interactive"],
        expiresAt: future(),
        receivedAt: new Date().toISOString(),
      },
    ];
    render(<App />);
    expect(await screen.findByText("Acme Notes wants to connect")).toBeTruthy();
    expect(screen.getByText("Verified domain")).toBeTruthy();
    const allow = screen.getByRole("button", { name: /Allow connection/ });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Choose…/ }));
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Can edit" }));
    fireEvent.click(allow);
    await waitFor(() => expect(calls.acceptPairing).toBeTruthy());
    const [id, opts] = calls.acceptPairing[0] as [string, Record<string, unknown>];
    expect(id).toBe("pair_1");
    expect(opts).toMatchObject({ providerId: "mock", workspace: "/Users/alex/Projects/site", access: "workspace_write", requireTaskApproval: true, durationSecs: 86400 });
  });

  it("unverified service shows a warning and provider notices must be acknowledged", async () => {
    snapshot.providers = [provider("codex", { policy: { remote: "allowed_with_notice", note: "Uses your ChatGPT plan limits." }, authLabel: "ChatGPT" })];
    snapshot.pairingRequests = [
      {
        pairingId: "pair_2",
        service: { id: "svc_b", displayName: "Shady", origin: "http://localhost:4000", domain: "localhost", verified: false, verification: "unverified" },
        externalUserId: "u",
        scopes: ["task.interactive"],
        expiresAt: future(),
        receivedAt: new Date().toISOString(),
      },
    ];
    render(<App />);
    expect(await screen.findByText(/could not verify/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Choose…/ }));
    const allow = screen.getByRole("button", { name: /Allow connection/ }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByDisplayValue("/Users/alex/Projects/site")).toBeTruthy());
    expect(allow.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(allow.disabled).toBe(false);
  });

  it("blocked providers are never offered for website connections", async () => {
    snapshot.providers = [provider("claude", { policy: { remote: "blocked", note: "Not allowed" } })];
    snapshot.pairingRequests = [
      {
        pairingId: "pair_3",
        service: { id: "svc_a", displayName: "Acme", origin: "https://acme.example", domain: "acme.example", verified: true, verification: "operator" },
        externalUserId: "u",
        scopes: [],
        expiresAt: future(),
        receivedAt: new Date().toISOString(),
      },
    ];
    render(<App />);
    expect(await screen.findByText(/No AI provider is ready for website use/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("permission prompts and task approvals are answered locally", async () => {
    snapshot.tasks = [
      {
        id: "task_1", source: "remote", connectionId: "conn_1", serviceName: "Acme Notes", serviceDomain: "acme.example",
        providerId: "mock", workspace: "/w", state: "awaiting_approval", prompt: "Summarize the repo",
        transcript: [{ type: "user", text: "Summarize the repo" }], createdAt: new Date().toISOString(), finishedAt: null, stopReason: null, error: null,
      },
    ];
    snapshot.permissions = [
      { requestId: "perm_1", taskId: "task_0", title: "Write README.md", kind: "edit", details: "{\"path\":\"README.md\"}", canAllowForTask: true, serviceName: "Acme Notes", createdAt: new Date().toISOString() },
    ];
    render(<App />);
    expect(await screen.findByText("Acme Notes wants to start a task")).toBeTruthy();
    expect(screen.getByText("Write README.md")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow for this task" })));
    expect(calls.respondPermission[0]).toEqual(["perm_1", "allow_task"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Allow task/ })));
    expect(calls.approveTask[0]).toEqual(["task_1", true]);
  });

  it("activity shows a streaming transcript with stop", async () => {
    snapshot.tasks = [
      {
        id: "task_2", source: "remote", connectionId: "conn_1", serviceName: "Acme Notes", serviceDomain: "acme.example",
        providerId: "mock", workspace: "/w", state: "running", prompt: "hello",
        transcript: [
          { type: "user", text: "hello" },
          { type: "plan", entries: [{ content: "Respond", status: "in_progress" }] },
          { type: "tool", toolCallId: "t1", title: "Read notes.txt", kind: "read", status: "completed" },
          { type: "agent", text: "Hi there" },
        ],
        createdAt: new Date().toISOString(), finishedAt: null, stopReason: null, error: null,
      },
    ];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^Activity/ }));
    expect(await screen.findByText("Hi there")).toBeTruthy();
    expect(screen.getByText("Read notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(calls.cancelTask?.[0]).toEqual(["task_2"]));
  });
});
