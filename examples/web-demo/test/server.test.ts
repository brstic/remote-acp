// Unit tests for the demo server's session + isolation rules, with the relay
// replaced by a mocked fetch. The real relay is exercised in tests/node-e2e.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteAcp } from "@remote-acp/web-sdk";
import { createDemoServer, externalUserIdFor } from "../src/app.js";

const relayCalls: { url: string; body: unknown }[] = [];
let taskCounter = 0;

const relayFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  relayCalls.push({ url, body });
  const u = new URL(url);
  const j = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
  if (u.pathname === "/v1/connections") {
    const user = u.searchParams.get("externalUserId");
    return j(200, {
      connections:
        user === externalUserIdFor("alice")
          ? [{ connectionId: "conn_alice", externalUserId: user, status: "active", online: true, provider: "Test agent", scopes: ["task.interactive"], expiresAt: "2030-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }]
          : [],
    });
  }
  if (u.pathname === "/v1/tasks" && init?.method === "POST") return j(201, { taskId: `task_${++taskCounter}`, connectionId: body.connectionId, state: "pending" });
  if (u.pathname.startsWith("/v1/tasks/")) return j(200, { taskId: u.pathname.split("/")[3], state: "running" });
  if (u.pathname === "/v1/pairings") return j(200, { pairingId: "pair_1", url: "remoteacp://pair?ticket=t", code: "ABCDE-12345", expiresAt: "2030-01-01T00:00:00Z" });
  return j(404, { error: { code: "not_found", message: "nope" } });
};

let base = "";
const server = createDemoServer({
  relayUrl: "http://127.0.0.1:1",
  serviceId: "svc_demo",
  serviceSecret: "unit-test-secret-0123456789",
  bridge: new RemoteAcp({ relayUrl: "http://127.0.0.1:1", serviceId: "svc_demo", serviceSecret: "unit-test-secret-0123456789", fetch: relayFetch }),
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

async function login(username: string): Promise<string> {
  const r = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ username }), headers: { "content-type": "application/json" } });
  expect(r.status).toBe(200);
  const cookie = r.headers.get("set-cookie")!;
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
  return cookie.split(";")[0]!;
}

const call = (path: string, cookie: string | null, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", ...(init.headers as object) } });

describe("demo server", () => {
  it("serves the UI with a strict CSP and the browser helper module", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await r.text()).toContain("DEMO");
    const js = await fetch(`${base}/vendor/browser-helper.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("renderPairing");
    expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404);
  });

  it("rejects bad usernames and unauthenticated API calls", async () => {
    expect((await call("/api/login", null, { method: "POST", body: JSON.stringify({ username: "<script>" }) })).status).toBe(400);
    const r = await call("/api/connection", null);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("signed_out");
  });

  it("refuses cross-origin mutations", async () => {
    const cookie = await login("alice");
    const r = await call("/api/pairings", cookie, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("derives externalUserId and connectionId from the session, never the browser", async () => {
    const alice = await login("alice");
    relayCalls.length = 0;
    const r = await call("/api/tasks", alice, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", connectionId: "conn_someone_else", externalUserId: "acme-demo:bob", idempotencyKey: "abcdefgh12" }),
    });
    expect(r.status).toBe(201);
    const start = relayCalls.find((c) => c.url.endsWith("/v1/tasks"))!;
    expect(start.body).toMatchObject({ connectionId: "conn_alice", externalUserId: "acme-demo:alice", idempotencyKey: "alice:abcdefgh12" });

    const bob = await login("bob");
    const noConn = await call("/api/tasks", bob, { method: "POST", body: JSON.stringify({ prompt: "hi" }) });
    expect(noConn.status).toBe(409);
    expect((await noConn.json()).error.code).toBe("not_connected");
  });

  it("only serves task routes for the owner", async () => {
    const alice = await login("alice");
    const t = await (await call("/api/tasks", alice, { method: "POST", body: JSON.stringify({ prompt: "x" }) })).json();
    expect((await call(`/api/tasks/${t.taskId}`, alice)).status).toBe(200);
    const bob = await login("bob");
    for (const [path, method] of [
      [`/api/tasks/${t.taskId}`, "GET"],
      [`/api/tasks/${t.taskId}/cancel`, "POST"],
      [`/api/tasks/${t.taskId}/events`, "GET"],
    ] as const) {
      expect((await call(path, bob, { method })).status, path).toBe(404);
    }
  });
});
