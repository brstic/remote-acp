// REAL end-to-end test of the minimal integration: the Rust relay binary, the
// headless test desktop (real bridge-core + deterministic mock ACP agent) and
// this example's built server, driven only through its own HTTP API.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTmp,
  ensureBinaries,
  pairDesktop,
  sha256,
  startDesktop,
  startNodeServer,
  startRelay,
  stop,
  type Proc,
  type RelayHandle,
} from "../../../tests/node-e2e/test/harness.js";
import { AppClient, eventually, streamedText } from "../../../tests/node-e2e/test/app-client.js";

const SECRET = "dev-only-minimal-integration-secret-0123456789";
const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));

let relay: RelayHandle;
let desktop: { proc: Proc; workspace: string };
let app: { proc: Proc; base: string };
let client: AppClient;

beforeAll(async () => {
  ensureBinaries();
  relay = await startRelay({
    services: [
      { id: "svc_minimal", displayName: "Minimal Integration (example)", origin: "http://localhost:3101", secretSha256: sha256(SECRET), verification: "operator" },
    ],
  });
  desktop = await startDesktop(relay.url);
  app = await startNodeServer(SERVER, { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: SECRET }, "minimal");
  client = new AppClient(app.base);
});

afterAll(async () => {
  await stop(app?.proc.child);
  await stop(desktop?.proc.child);
  await stop(relay?.proc.child);
  cleanupTmp();
});

describe("minimal-integration example (real relay + desktop)", () => {
  it("serves the page with a strict CSP and refuses cross-origin writes", async () => {
    const page = await client.call("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Minimal Integration (Example)");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await client.call("/vendor/browser-helper.js")).body).toContain("renderPairing");

    const foreign = await client.call("/api/connect", { method: "POST", body: {}, headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect((await client.post("/api/ask", { prompt: "hi" })).body.error.code).toBe("not_connected");
    expect((await client.call("/api/status")).body).toEqual({ connected: false });
  });

  it("connect -> pairing link -> accepted on the desktop -> connected", async () => {
    const pairing = await client.post("/api/connect");
    expect(pairing.status).toBe(200);
    expect(pairing.body.url).toMatch(/^remoteacp:\/\/pair\?ticket=/);
    expect(pairing.body.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    const waiting = client.call("/api/connect/wait"); // long-poll, resolves on accept
    const paired = await pairDesktop(desktop.proc, pairing.body.url);
    expect(paired.service).toBe("Minimal Integration (example)");
    expect((await waiting).body).toEqual({ status: "accepted" });

    const status = await eventually(() => client.call("/api/status"), (r) => r.body.online === true);
    expect(status.body).toMatchObject({ connected: true, status: "active", online: true });
    expect(status.body.provider.length).toBeGreaterThan(0);
  });

  it("asks a question and streams the answer (with Last-Event-ID resume)", async () => {
    const ask = await client.post("/api/ask", { prompt: "hello minimal" });
    expect(ask.status).toBe(201);
    const events = await client.sse(`/api/tasks/${ask.body.taskId}/events`);
    expect(streamedText(events)).toBe("Hello from the test agent. You said: hello minimal");
    expect(events.find((e) => e.event === "task.accepted")).toBeTruthy();
    const done = events.find((e) => e.event === "task.completed");
    expect(done?.data.payload.stopReason).toBe("end_turn");
    expect(events.at(-1)?.event).toBe("end");

    // An EventSource reconnect sends Last-Event-ID: only later events come back.
    const resumed = await client.sse(`/api/tasks/${ask.body.taskId}/events`, { lastEventId: 3 });
    const seqs = resumed.filter((e) => e.event.startsWith("task.")).map((e) => e.data.seq as number);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.every((s) => s > 3)).toBe(true);
  });

  it("cancels a running task", async () => {
    const ask = await client.post("/api/ask", { prompt: "slow" });
    expect(ask.status).toBe(201);
    let cancelled = false;
    const events = await client.sse(`/api/tasks/${ask.body.taskId}/events`, {
      onEvent: async (m) => {
        if (!cancelled && m.event === "task.event" && m.data.payload.type === "text_delta") {
          cancelled = true;
          expect((await client.post(`/api/tasks/${ask.body.taskId}/cancel`)).status).toBe(200);
        }
      },
    });
    expect(cancelled).toBe(true);
    expect(events.find((e) => e.event === "task.completed")?.data.payload.stopReason).toBe("cancelled");
    expect(streamedText(events)).not.toContain("step 59.");
  });

  it("only streams tasks this server started", async () => {
    expect((await client.call("/api/tasks/task_not_mine/events")).status).toBe(404);
    expect((await client.post("/api/tasks/task_not_mine/cancel")).status).toBe(404);
  });
});
