// REAL end-to-end test of the Code Review Assistant example: Rust relay binary
// + headless test desktop (real bridge-core + deterministic mock ACP agent) +
// this example's built server, driven only through its own HTTP API.
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

const SECRET = "dev-only-code-review-assistant-secret-0123456789";
const SERVER = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const ECHO = "Hello from the test agent. You said: ";

let relay: RelayHandle;
let desktop: { proc: Proc; workspace: string };
let app: { proc: Proc; base: string };
let alice: AppClient;
let bob: AppClient;
let connectionId = "";

const terminal = (msgs: SseMessage[]) => msgs.find((m) => ["task.completed", "task.failed", "task.rejected"].includes(m.event));

beforeAll(async () => {
  ensureBinaries();
  relay = await startRelay({
    services: [
      { id: "svc_code_review", displayName: "Code Review Assistant (example)", origin: "http://localhost:3102", secretSha256: sha256(SECRET), verification: "operator" },
    ],
  });
  desktop = await startDesktop(relay.url);
  app = await startNodeServer(SERVER, { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: SECRET }, "code-review");
  alice = new AppClient(app.base);
  bob = new AppClient(app.base);
});

afterAll(async () => {
  await stop(app?.proc.child);
  await stop(desktop?.proc.child);
  await stop(relay?.proc.child);
  cleanupTmp();
});

describe("code-review-assistant example (real relay + desktop)", () => {
  it("serves the UI with a strict CSP; requires sign-in", async () => {
    const page = await alice.call("/");
    expect(page.body).toContain("Code Review Assistant (Example)");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect((await alice.call("/render.js")).body).toContain("renderMarkdown");
    expect((await alice.call("/api/reviews")).status).toBe(401);
    expect((await alice.call("/api/review-types")).body.types.map((t: { id: string }) => t.id)).toEqual(["security", "bugs", "architecture", "tests"]);
  });

  it("signs in, pairs with the desktop and shows the connection", async () => {
    expect((await alice.post("/api/login", { username: "alice" })).status).toBe(200);
    expect((await bob.post("/api/login", { username: "bob" })).status).toBe(200);
    expect((await alice.post("/api/reviews", { type: "security" })).body.error.code).toBe("not_connected");

    const pairing = await alice.post("/api/pairings");
    expect(pairing.body.url).toMatch(/^remoteacp:\/\/pair\?/);
    const paired = await pairDesktop(desktop.proc, pairing.body.url);
    expect(paired.service).toBe("Code Review Assistant (example)");
    connectionId = paired.connectionId;
    const cur = await eventually(() => alice.call("/api/pairings/current"), (r) => r.body.pairing?.status === "accepted");
    expect(cur.body.connection.connectionId).toBe(connectionId);
    const conn = await eventually(() => alice.call("/api/connection"), (r) => r.body.connection?.online === true);
    expect(conn.body.connection).toMatchObject({ status: "active", online: true });
    // bob is a different user of the same website: no connection.
    expect((await bob.call("/api/connection")).body.connection).toBeNull();
  });

  it("runs a security review and streams the report, plan and status", async () => {
    expect((await alice.post("/api/reviews", { type: "nope" })).body.error.code).toBe("invalid_type");
    const created = await alice.post("/api/reviews", { type: "security", focus: "Check the login handler" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ type: "security", title: "Security review", state: "running", focus: "Check the login handler" });
    const id = created.body.id as string;

    const events = await alice.sse(`/api/reviews/${id}/events`);
    const text = streamedText(events);
    // The mock agent echoes the prompt the server built.
    expect(text.startsWith(`${ECHO}Code review request: Security review.`)).toBe(true);
    expect(text).toContain("Check the login handler");
    expect(text).toContain("- Hardening checklist");
    expect(events.some((m) => m.event === "task.event" && m.data.payload.type === "status" && m.data.payload.state === "awaiting_approval")).toBe(true);
    const plan = events.filter((m) => m.event === "task.event" && m.data.payload.type === "plan").at(-1);
    expect(plan?.data.payload.entries.every((e: { status: string }) => e.status === "completed")).toBe(true);
    expect(terminal(events)?.data.payload.stopReason).toBe("end_turn");
    expect(events.at(-1)).toMatchObject({ event: "end", data: { state: "completed", error: null } });

    // The server kept the report: a second viewer replays it, Last-Event-ID resumes.
    const replay = await alice.sse(`/api/reviews/${id}/events`);
    expect(streamedText(replay)).toBe(text);
    const resumed = await alice.sse(`/api/reviews/${id}/events`, { lastEventId: 5 });
    expect(resumed.filter((m) => m.event.startsWith("task.")).every((m) => m.data.seq > 5)).toBe(true);
    expect(streamedText(resumed).length).toBeLessThan(text.length);

    const detail = await alice.call(`/api/reviews/${id}`);
    expect(detail.body.prompt.startsWith("Code review request: Security review.")).toBe(true);
    const history = await alice.call("/api/reviews");
    expect(history.body.reviews).toHaveLength(1);
    expect(history.body.reviews[0]).toMatchObject({ id, state: "completed", stopReason: "end_turn" });
    expect(history.body.reviews[0].preview.startsWith(ECHO)).toBe(true);

    // Per-user isolation.
    expect((await bob.call(`/api/reviews/${id}`)).status).toBe(404);
    expect((await bob.call("/api/reviews")).body.reviews).toEqual([]);
    expect((await bob.post(`/api/reviews/${id}/cancel`)).status).toBe(404);
    expect((await bob.post("/api/reviews", { type: "bugs" })).body.error.code).toBe("not_connected");
  });

  it("refuses a second concurrent review (task_in_progress) and cancels a running one", async () => {
    // "slow" in the focus notes makes the test agent stream for ~3s.
    const first = await alice.post("/api/reviews", { type: "architecture", focus: "slow walkthrough please" });
    expect(first.status).toBe(201);
    const second = await alice.post("/api/reviews", { type: "tests" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("task_in_progress");

    let cancelled = false;
    const events = await alice.sse(`/api/reviews/${first.body.id}/events`, {
      onEvent: async (m) => {
        if (!cancelled && m.event === "task.event" && m.data.payload.type === "text_delta") {
          cancelled = true;
          expect((await alice.post(`/api/reviews/${first.body.id}/cancel`)).status).toBe(200);
        }
      },
    });
    expect(terminal(events)?.data.payload.stopReason).toBe("cancelled");
    expect(streamedText(events)).not.toContain("step 59.");
    const list = (await alice.call("/api/reviews")).body.reviews;
    expect(list[0]).toMatchObject({ id: first.body.id, state: "cancelled" });
  });

  it("surfaces the desktop's safety stop as policy_blocked", async () => {
    // The test agent prints a fake AWS key when the prompt mentions "secret";
    // the desktop's output firewall stops the task before it reaches us.
    const r = await alice.post("/api/reviews", { type: "bugs", focus: "is there a secret in the config?" });
    expect(r.status).toBe(201);
    const events = await alice.sse(`/api/reviews/${r.body.id}/events`);
    expect(terminal(events)).toMatchObject({ event: "task.failed", data: { payload: { code: "policy_blocked" } } });
    // The full key never arrives (a chunk sent before the key was recognisable may hold a prefix).
    expect(streamedText(events)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect((await alice.call(`/api/reviews/${r.body.id}`)).body).toMatchObject({ state: "failed", error: { code: "policy_blocked" } });
  });

  it("disconnect revokes the connection on the relay", async () => {
    const dis = await alice.post("/api/connection/disconnect");
    expect(dis.body).toEqual({ ok: true, revoked: 1 });
    const sdk = new RemoteAcp({ serviceId: "svc_code_review", serviceSecret: SECRET, relayUrl: relay.url });
    expect((await sdk.getConnection(connectionId)).status).toBe("revoked");
    const after = await alice.call("/api/connection");
    expect(after.body.connection).toBeNull();
    expect(after.body.latest.status).toBe("revoked");
    expect((await alice.post("/api/reviews", { type: "security" })).body.error.code).toBe("not_connected");
    // History survives in server memory for the session.
    expect((await alice.call("/api/reviews")).body.reviews).toHaveLength(3);
  });
});
