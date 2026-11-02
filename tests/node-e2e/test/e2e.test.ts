// REAL end-to-end test: Rust relay binary + headless desktop (real bridge-core
// driving the mock ACP agent over stdio) + @remote-acp/web-sdk + web demo.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteAcp, RemoteAcpError, parseSseStream, type StreamItem, type TaskStreamEvent } from "@remote-acp/web-sdk";
import {
  DEMO_SECRET,
  DroppingProxy,
  OTHER_SECRET,
  Proc,
  REPO,
  cleanupTmp,
  ensureBinaries,
  startDesktop,
  startRelay,
  stop,
  type RelayHandle,
} from "./harness.js";

let relay: RelayHandle;
let desktop: { proc: Proc; workspace: string };
let proxy: DroppingProxy;
let sdk: RemoteAcp;
let connectionId = "";
const USER = "sdk-user-1";

const isTask = (e: StreamItem): e is TaskStreamEvent => "seq" in e;
const textOf = (evs: StreamItem[]) =>
  evs
    .filter(isTask)
    .map((e) => (e.kind === "task.event" && e.payload.type === "text_delta" ? e.payload.text : ""))
    .join("");
const terminalOf = (evs: StreamItem[]) => evs.filter(isTask).find((e) => ["task.completed", "task.failed", "task.rejected"].includes(e.kind));

async function collect(it: AsyncIterable<StreamItem>, onEvent?: (e: StreamItem) => void | Promise<void>): Promise<StreamItem[]> {
  const out: StreamItem[] = [];
  for await (const e of it) {
    out.push(e);
    await onEvent?.(e);
  }
  return out;
}

async function pairWithDesktop(url: string): Promise<{ connectionId: string; service: string }> {
  const from = desktop.proc.lines.length;
  desktop.proc.write(`${url}\n`);
  return desktop.proc.waitJson((v) => v.event === "paired" || v.event === "error", 20_000, from).then((v) => {
    if (v.event !== "paired") throw new Error(`desktop pairing failed: ${JSON.stringify(v)}`);
    return v as unknown as { connectionId: string; service: string };
  });
}

async function waitOnline(id: string) {
  for (let i = 0; i < 100; i++) {
    const c = await sdk.getConnection(id);
    if (c.online) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("desktop never came online");
}

beforeAll(async () => {
  ensureBinaries();
  relay = await startRelay();
  desktop = await startDesktop(relay.url);
  proxy = new DroppingProxy(relay.port);
  await proxy.start();
  sdk = new RemoteAcp({ serviceId: "svc_demo", serviceSecret: DEMO_SECRET, relayUrl: relay.url });
});

afterAll(async () => {
  await stop(desktop?.proc.child);
  await stop(relay?.proc.child);
  await proxy?.close();
  cleanupTmp();
});

describe("web-sdk against the real relay + desktop", () => {
  it("pairs: createPairing -> desktop accepts -> waitForPairing accepted", async () => {
    const p = await sdk.createPairing({ externalUserId: USER, scopes: ["task.interactive"], expiresInSeconds: 120 });
    expect(p.url).toMatch(/^remoteacp:\/\/pair\?ticket=/);
    expect(p.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect((await sdk.getPairing(p.pairingId)).status).toBe("pending");

    const waiting = sdk.waitForPairing(p.pairingId, { intervalMs: 100, timeoutMs: 20_000 });
    const paired = await pairWithDesktop(p.url);
    expect(paired.service).toBe("Acme Notes (demo)");
    const final = await waiting;
    expect(final.status).toBe("accepted");
    expect(final.connectionId).toBe(paired.connectionId);
    connectionId = paired.connectionId;

    const list = await sdk.listConnections(USER);
    expect(list.map((c) => c.connectionId)).toContain(connectionId);
    const c = await waitOnline(connectionId);
    expect(c).toMatchObject({ status: "active", externalUserId: USER, scopes: ["task.interactive"] });
    expect(c.provider.length).toBeGreaterThan(0);

    // Single-use ticket: replaying the same link fails on the desktop.
    const from = desktop.proc.lines.length;
    desktop.proc.write(`${p.url}\n`);
    const err = await desktop.proc.waitJson((v) => v.event === "error" || v.event === "paired", 20_000, from);
    expect(err.event).toBe("error");
  });

  it('streams "hello sdk" to completion with exact text', async () => {
    const key = `idem-${Date.now()}`;
    const task = await sdk.startTask({ connectionId, externalUserId: USER, prompt: "hello sdk", idempotencyKey: key });
    expect(task.taskId).toMatch(/^task_/);
    expect(task.state).toBe("pending");
    // Idempotent retry returns the same task.
    const again = await sdk.startTask({ connectionId, externalUserId: USER, prompt: "hello sdk", idempotencyKey: key });
    expect(again.taskId).toBe(task.taskId);

    const events = await collect(sdk.streamEvents(task.taskId));
    expect(textOf(events)).toBe("Hello from the test agent. You said: hello sdk");
    const fin = terminalOf(events)!;
    expect(fin.kind).toBe("task.completed");
    expect(fin.payload).toEqual({ stopReason: "end_turn" });
    const tev = events.filter(isTask);
    expect(tev.some((e) => e.kind === "task.accepted")).toBe(true);
    expect(tev.some((e) => e.kind === "task.event" && e.payload.type === "plan")).toBe(true);
    expect(tev.some((e) => e.kind === "task.event" && e.payload.type === "status" && e.payload.state === "awaiting_approval")).toBe(true);
    const seqs = tev.map((e) => e.seq);
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!)).toBe(true);
    expect(tev.at(-1)).toBe(fin); // stream ends right after the terminal event

    expect((await sdk.getTask(task.taskId)).state).toBe("completed");

    // Explicit resume with Last-Event-ID replays only later events.
    const mid = seqs[Math.floor(seqs.length / 2)]!;
    const replay = await collect(sdk.streamEvents(task.taskId, { lastEventId: mid }));
    expect(replay.filter(isTask).every((e) => e.seq > mid)).toBe(true);
    expect(terminalOf(replay)?.kind).toBe("task.completed");
    // Resuming past the end returns promptly with nothing.
    expect(await collect(sdk.streamEvents(task.taskId, { lastEventId: fin.seq }))).toEqual([]);
  });

  it("observes permission_pending + permission_resolved(allowed) for a permission task", async () => {
    const task = await sdk.startTask({ connectionId, externalUserId: USER, prompt: "permission" });
    const events = await collect(sdk.streamEvents(task.taskId));
    const tev = events.filter(isTask).filter((e) => e.kind === "task.event");
    const pending = tev.find((e) => e.kind === "task.event" && e.payload.type === "permission_pending");
    const resolved = tev.find((e) => e.kind === "task.event" && e.payload.type === "permission_resolved");
    expect(pending, JSON.stringify(events)).toBeDefined();
    expect(resolved?.payload).toMatchObject({ type: "permission_resolved", outcome: "allowed" });
    expect(tev.some((e) => e.kind === "task.event" && e.payload.type === "tool_call")).toBe(true);
    expect(textOf(events)).toContain("PERMISSION_GRANTED");
    expect(terminalOf(events)?.kind).toBe("task.completed");
    expect(existsSync(join(desktop.workspace, "mock-output.txt"))).toBe(true);
    expect(desktop.proc.lines.some((l) => l.includes('"event":"permission"'))).toBe(true);
  });

  it('cancels a "slow" task via cancelTask -> stopReason cancelled', async () => {
    const task = await sdk.startTask({ connectionId, externalUserId: USER, prompt: "slow" });
    let cancelled = false;
    const events = await collect(sdk.streamEvents(task.taskId), async (e) => {
      if (!cancelled && isTask(e) && e.kind === "task.event" && e.payload.type === "text_delta") {
        cancelled = true;
        const r = await sdk.cancelTask(task.taskId);
        expect(r).toEqual({ ok: true, alreadyFinished: false });
      }
    });
    const fin = terminalOf(events)!;
    expect(fin.kind).toBe("task.completed");
    expect(fin.payload).toEqual({ stopReason: "cancelled" });
    expect(textOf(events)).not.toContain("step 59");
    expect((await sdk.getTask(task.taskId)).state).toBe("cancelled");
  });

  it("automatically resumes with Last-Event-ID after a real mid-stream TCP drop", async () => {
    const viaProxy = new RemoteAcp({ serviceId: "svc_demo", serviceSecret: DEMO_SECRET, relayUrl: `http://127.0.0.1:${proxy.port}` });
    const task = await viaProxy.startTask({ connectionId, externalUserId: USER, prompt: "slow" });
    const before = proxy.eventRequests;
    proxy.dropNextEventStreamAfter(1500); // a few events in, mid-event
    const events = await collect(viaProxy.streamEvents(task.taskId, { retryDelayMs: 50 }));
    expect(proxy.drops).toBe(1);
    expect(proxy.eventRequests - before).toBeGreaterThanOrEqual(2);
    const expected = Array.from({ length: 60 }, (_, i) => `step ${i}. `).join("");
    expect(textOf(events)).toBe(expected);
    const seqs = events.filter(isTask).map((e) => e.seq);
    // Relay seqs are gap-free per task: we must have seen every one exactly once.
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i));
    expect(seqs[0]).toBe(1);
    expect(terminalOf(events)?.payload).toEqual({ stopReason: "end_turn" });
  });

  it("isolates services: another service cannot see this task or connection", async () => {
    const other = new RemoteAcp({ serviceId: "svc_other", serviceSecret: OTHER_SECRET, relayUrl: relay.url });
    const t = await sdk.startTask({ connectionId, externalUserId: USER, prompt: "hello again" });
    await collect(sdk.streamEvents(t.taskId));
    await expect(other.getTask(t.taskId)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(other.getConnection(connectionId)).rejects.toMatchObject({ status: 404 });
    expect(await other.listConnections(USER)).toEqual([]);
    // Wrong end user on the right service is refused too.
    await expect(sdk.startTask({ connectionId, externalUserId: "someone-else", prompt: "x" })).rejects.toMatchObject({ status: 404 });
    const bad = new RemoteAcp({ serviceId: "svc_demo", serviceSecret: "wrong-secret-0123456789", relayUrl: relay.url });
    await expect(bad.listConnections(USER)).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("revokeConnection -> startTask fails with connection_revoked", async () => {
    await sdk.revokeConnection(connectionId);
    const err = await sdk.startTask({ connectionId, externalUserId: USER, prompt: "after revoke" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteAcpError);
    expect(err).toMatchObject({ code: "connection_revoked", status: 410 });
    expect((await sdk.getConnection(connectionId)).status).toBe("revoked");
  });
});

describe("web demo server end-to-end (real relay + desktop)", () => {
  let demo: Proc;
  let base = "";

  beforeAll(async () => {
    const main = join(REPO, "examples/web-demo/dist/main.js");
    if (!existsSync(main)) throw new Error("examples/web-demo is not built; run `pnpm -r --filter '!remote-acp-desktop' build` first");
    const child = spawn(process.execPath, [main], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", RELAY_URL: relay.url, REMOTE_ACP_SERVICE_ID: "svc_demo", REMOTE_ACP_SERVICE_SECRET: DEMO_SECRET },
    });
    demo = new Proc(child, "web-demo");
    const { port } = await demo.waitJson<{ port: number }>((v) => v.event === "listening");
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await stop(demo?.child);
  });

  async function login(username: string) {
    const r = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ username }),
    });
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  }
  const api = async (cookie: string, path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { cookie, "content-type": "application/json", origin: base },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  async function sseThroughDemo(cookie: string, taskId: string, lastEventId?: number) {
    const r = await fetch(`${base}/api/tasks/${taskId}/events`, {
      headers: { cookie, accept: "text/event-stream", ...(lastEventId ? { "last-event-id": String(lastEventId) } : {}) },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const out: { id: string; event: string; data: any }[] = [];
    for await (const m of parseSseStream(r.body!)) {
      out.push({ id: m.id, event: m.event, data: JSON.parse(m.data) });
      if (m.event === "end" || m.event === "proxy_error") break;
    }
    return out;
  }

  it("sign-in -> pairing -> connected -> streamed task -> isolation -> disconnect", async () => {
    // Static UI is served.
    expect(await (await fetch(`${base}/`)).text()).toContain("Acme Notes");

    const alice = await login("alice");
    expect((await api(alice, "/api/me")).body.user).toEqual({ username: "alice" });
    expect((await api(alice, "/api/connection")).body.connection).toBeNull();

    // Pairing through the demo's own endpoint.
    const pair = await api(alice, "/api/pairings", { method: "POST" });
    expect(pair.status).toBe(200);
    expect(pair.body.url).toMatch(/^remoteacp:\/\/pair\?/);
    expect((await api(alice, "/api/pairings/current")).body.pairing.status).toBe("pending");
    const paired = await pairWithDesktop(pair.body.url);

    let current: Record<string, any> = {};
    for (let i = 0; i < 50; i++) {
      current = (await api(alice, "/api/pairings/current")).body;
      if (current.pairing.status === "accepted") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(current.pairing.status).toBe("accepted");
    expect(current.connection.connectionId).toBe(paired.connectionId);
    expect(current.connection.provider.length).toBeGreaterThan(0);
    await waitOnline(paired.connectionId);
    expect((await api(alice, "/api/connection")).body.connection).toMatchObject({ status: "active", online: true });

    // Task streamed through the demo server's SSE proxy.
    const task = await api(alice, "/api/tasks", { method: "POST", body: { prompt: "hello demo" } });
    expect(task.status).toBe(201);
    const taskId = task.body.taskId as string;
    const events = await sseThroughDemo(alice, taskId);
    const text = events
      .filter((e) => e.event === "task.event" && e.data.payload.type === "text_delta")
      .map((e) => e.data.payload.text)
      .join("");
    expect(text).toBe("Hello from the test agent. You said: hello demo");
    const fin = events.find((e) => e.event === "task.completed");
    expect(fin?.data.payload.stopReason).toBe("end_turn");
    expect(fin?.id).toBe(String(fin?.data.seq));
    expect(events.at(-1)?.event).toBe("end");

    // EventSource-style resume through the proxy (Last-Event-ID forwarded to the relay).
    const resumed = await sseThroughDemo(alice, taskId, 3);
    expect(resumed.filter((e) => e.event.startsWith("task.")).every((e) => e.data.seq > 3)).toBe(true);

    // Another demo user can't see alice's connection or task.
    const bob = await login("bob");
    expect((await api(bob, "/api/connection")).body.connection).toBeNull();
    expect((await api(bob, `/api/tasks/${taskId}`)).status).toBe(404);
    expect((await fetch(`${base}/api/tasks/${taskId}/events`, { headers: { cookie: bob } })).status).toBe(404);
    expect((await api(bob, "/api/tasks", { method: "POST", body: { prompt: "steal" } })).body.error.code).toBe("not_connected");

    // Disconnect revokes the connection on the relay.
    const dis = await api(alice, "/api/connection/disconnect", { method: "POST" });
    expect(dis.body).toEqual({ ok: true, revoked: 1 });
    expect((await sdk.getConnection(paired.connectionId)).status).toBe("revoked");
    const after = await api(alice, "/api/connection");
    expect(after.body.connection).toBeNull();
    expect(after.body.latest.status).toBe("revoked");
    const refused = await api(alice, "/api/tasks", { method: "POST", body: { prompt: "after disconnect" } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("not_connected");
  });
});
