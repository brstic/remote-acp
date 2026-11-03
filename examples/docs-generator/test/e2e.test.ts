// REAL end-to-end test of the Docs Generator example: Rust relay binary + two
// headless test desktops (real bridge-core + deterministic mock ACP agent; one
// answers local permission prompts with allow_once, the other with deny) +
// this example's built server, driven only through its own HTTP API.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteAcp } from "@remote-acp/web-sdk";
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
import { AppClient, eventually, streamedText, type SseMessage } from "../../../tests/node-e2e/test/app-client.js";

const SECRET = "dev-only-docs-generator-secret-0123456789";
const SERVER = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let relay: RelayHandle;
let allowDesk: { proc: Proc; workspace: string };
let denyDesk: { proc: Proc; workspace: string };
let app: { proc: Proc; base: string };
let sdk: RemoteAcp;
const alice = () => clients.alice!;
const carol = () => clients.carol!;
const clients: Record<string, AppClient> = {};

const taskEvents = (msgs: SseMessage[], type: string) => msgs.filter((m) => m.event === "task.event" && m.data.payload.type === type).map((m) => m.data.payload);
const terminal = (msgs: SseMessage[]) => msgs.find((m) => ["task.completed", "task.failed", "task.rejected"].includes(m.event));

async function signInAndPair(name: string, desk: { proc: Proc }): Promise<string> {
  const c = (clients[name] = new AppClient(app.base));
  expect((await c.post("/api/login", { username: name })).status).toBe(200);
  expect((await c.call("/api/connection")).body).toEqual({ state: "none", connection: null });
  const pairing = await c.post("/api/pairings");
  const paired = await pairDesktop(desk.proc, pairing.body.url);
  expect(paired.service).toBe("Docs Generator (example)");
  await eventually(() => c.call("/api/pairings/current"), (r) => r.body.pairing?.status === "accepted");
  const conn = await eventually(() => c.call("/api/connection"), (r) => r.body.state === "online");
  expect(conn.body.connection).toMatchObject({ connectionId: paired.connectionId, status: "active", online: true });
  return paired.connectionId;
}

let aliceConn = "";
let carolConn = "";

beforeAll(async () => {
  ensureBinaries();
  relay = await startRelay({
    services: [
      { id: "svc_docs_generator", displayName: "Docs Generator (example)", origin: "http://localhost:3103", secretSha256: sha256(SECRET), verification: "operator" },
    ],
  });
  allowDesk = await startDesktop(relay.url, { permissionChoice: "allow_once" });
  denyDesk = await startDesktop(relay.url, { permissionChoice: "deny" });
  app = await startNodeServer(SERVER, { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: SECRET }, "docs-generator");
  sdk = new RemoteAcp({ serviceId: "svc_docs_generator", serviceSecret: SECRET, relayUrl: relay.url });
});

afterAll(async () => {
  await stop(app?.proc.child);
  await stop(allowDesk?.proc.child);
  await stop(denyDesk?.proc.child);
  await stop(relay?.proc.child);
  cleanupTmp();
});

describe("docs-generator example (real relay + desktops)", () => {
  it("serves the UI with a strict CSP and lists the documents", async () => {
    const c = new AppClient(app.base);
    const page = await c.call("/");
    expect(page.body).toContain("Waiting for your approval in Remote ACP Bridge");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await c.call("/api/doc-types")).body.types.map((t: { file: string }) => t.file)).toEqual(["README.md", "CONTRIBUTING.md", "CHANGELOG.md"]);
    expect((await c.call("/api/connection")).status).toBe(401);
  });

  it("pairs two users with two desktops", async () => {
    aliceConn = await signInAndPair("alice", allowDesk);
    carolConn = await signInAndPair("carol", denyDesk);
    expect(aliceConn).not.toBe(carolConn);
    const none = await alice().post("/api/jobs", { doc: "license" });
    expect(none.status).toBe(400);
  });

  it("permission ALLOWED on the desktop: pending -> resolved(allowed) -> file written", async () => {
    const job = await alice().post("/api/jobs", { doc: "readme", notes: "Audience: new users" });
    expect(job.status).toBe(201);
    expect(job.body).toMatchObject({ doc: "readme", file: "README.md", notes: "Audience: new users" });
    const events = await alice().sse(`/api/jobs/${job.body.id}/events`);

    const pending = taskEvents(events, "permission_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toContain("Write mock-output.txt");
    const resolved = taskEvents(events, "permission_resolved");
    expect(resolved).toEqual([{ type: "permission_resolved", requestId: pending[0].requestId, outcome: "allowed" }]);
    // Order: the website saw the prompt before the outcome.
    const idx = (t: string) => events.findIndex((m) => m.event === "task.event" && m.data.payload.type === t);
    expect(idx("permission_pending")).toBeLessThan(idx("permission_resolved"));
    expect(streamedText(events)).toContain("PERMISSION_GRANTED");
    expect(terminal(events)?.data.payload.stopReason).toBe("end_turn");
    expect(readFileSync(join(allowDesk.workspace, "mock-output.txt"), "utf8")).toBe("written by mock agent\n");

    const detail = await alice().call(`/api/jobs/${job.body.id}`);
    expect(detail.body).toMatchObject({ state: "completed", stopReason: "end_turn", error: null });
    expect(detail.body.prompt).toContain("Write the complete file to `README.md`");
    expect(detail.body.prompt).toContain("Audience: new users");
  });

  it("permission DENIED on the desktop: resolved(denied) -> nothing written", async () => {
    const job = await carol().post("/api/jobs", { doc: "contributing" });
    expect(job.status).toBe(201);
    const events = await carol().sse(`/api/jobs/${job.body.id}/events`);
    expect(taskEvents(events, "permission_pending")).toHaveLength(1);
    expect(taskEvents(events, "permission_resolved").map((p) => p.outcome)).toEqual(["denied"]);
    expect(streamedText(events)).toContain("PERMISSION_DENIED");
    expect(terminal(events)?.data.payload.stopReason).toBe("end_turn");
    expect(existsSync(join(denyDesk.workspace, "mock-output.txt"))).toBe(false);
  });

  it("isolates users: no access to another user's jobs", async () => {
    const aliceJobs = (await alice().call("/api/jobs")).body.jobs;
    expect(aliceJobs).toHaveLength(1);
    const id = aliceJobs[0].id;
    expect((await carol().call(`/api/jobs/${id}`)).status).toBe(404);
    expect((await carol().call(`/api/jobs/${id}/events`)).status).toBe(404);
    expect((await carol().post(`/api/jobs/${id}/cancel`)).status).toBe(404);
    expect((await carol().call("/api/jobs")).body.jobs.map((j: { file: string }) => j.file)).toEqual(["CONTRIBUTING.md"]);
  });

  it("task_in_progress while a job runs; cancel works", async () => {
    // "slow" in the notes makes the test agent stream for ~3s instead of writing.
    const first = await alice().post("/api/jobs", { doc: "changelog", notes: "slow and thorough" });
    expect(first.status).toBe(201);
    const second = await alice().post("/api/jobs", { doc: "readme" });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "task_in_progress", title: "Already working" });
    let cancelled = false;
    const events = await alice().sse(`/api/jobs/${first.body.id}/events`, {
      onEvent: async (m) => {
        if (!cancelled && m.event === "task.event" && m.data.payload.type === "text_delta") {
          cancelled = true;
          expect((await alice().post(`/api/jobs/${first.body.id}/cancel`)).body.ok).toBe(true);
        }
      },
    });
    expect(terminal(events)?.data.payload.stopReason).toBe("cancelled");
  });

  it("policy_blocked from the desktop's safety checks gets a friendly explanation", async () => {
    // The test agent prints a fake AWS key when the prompt mentions "secret".
    const job = await alice().post("/api/jobs", { doc: "readme", notes: "document the secret token setup" });
    const events = await alice().sse(`/api/jobs/${job.body.id}/events`);
    const fin = terminal(events);
    expect(fin?.event).toBe("task.failed");
    expect(fin?.data.payload.code).toBe("policy_blocked");
    expect(fin?.data.friendly.title).toBe("Stopped by your computer's safety checks");
    const detail = await alice().call(`/api/jobs/${job.body.id}`);
    expect(detail.body).toMatchObject({ state: "failed", error: { code: "policy_blocked", title: "Stopped by your computer's safety checks" } });
  });

  it("connection_revoked: revoked elsewhere -> status 'revoked' and a friendly start error", async () => {
    // Revoke behind the website's back (as the desktop's "Revoke" would).
    await sdk.revokeConnection(aliceConn);
    const conn = await alice().call("/api/connection");
    expect(conn.body.state).toBe("revoked");
    const r = await alice().post("/api/jobs", { doc: "readme" });
    expect(r.status).toBe(410);
    expect(r.body.error).toMatchObject({ code: "connection_revoked", title: "Connection removed", reconnect: true });
  });

  it("desktop_offline when the user's desktop app is not running", async () => {
    await stop(denyDesk.proc.child);
    const conn = await eventually(() => carol().call("/api/connection"), (r) => r.body.state === "offline");
    expect(conn.body.connection).toMatchObject({ status: "active", online: false });
    const r = await carol().post("/api/jobs", { doc: "changelog" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "desktop_offline", title: "Your computer is offline" });
  });

  it("Disconnect revokes the connection (getConnection -> revoked)", async () => {
    const r = await carol().post("/api/connection/disconnect");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("revoked");
    expect((await sdk.getConnection(carolConn)).status).toBe("revoked");
    expect((await carol().post("/api/connection/disconnect")).body.error.code).toBe("not_connected");
  });
});
