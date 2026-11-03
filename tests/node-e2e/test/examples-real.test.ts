// The three example apps driven through their own HTTP APIs with a REAL agent
// (Codex or Claude Code via their official ACP adapters, using the developer's
// own sign-in). Opt-in: REAL_AGENTS=codex,claude pnpm --filter @remote-acp/node-e2e test
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO, cleanupTmp, ensureBinaries, pairDesktop, sha256, startDesktop, startNodeServer, startRelay, stop, tmp, type Proc, type RelayHandle } from "./harness.js";
import { AppClient, eventually, streamedText, type SseMessage } from "./app-client.js";

const providers = (process.env.REAL_AGENTS ?? "").split(",").map((s) => s.trim()).filter((s): s is "codex" | "claude" => s === "codex" || s === "claude");

const APPS = {
  minimal: { id: "svc_minimal", name: "Minimal Integration (example)", origin: "http://localhost:3101", secret: "dev-only-minimal-integration-secret-0123456789", server: "examples/minimal-integration/dist/server.js" },
  review: { id: "svc_code_review", name: "Code Review Assistant (example)", origin: "http://localhost:3102", secret: "dev-only-code-review-assistant-secret-0123456789", server: "examples/code-review-assistant/dist/main.js" },
  docs: { id: "svc_docs_generator", name: "Docs Generator (example)", origin: "http://localhost:3103", secret: "dev-only-docs-generator-secret-0123456789", server: "examples/docs-generator/dist/main.js" },
} as const;

const terminal = (msgs: SseMessage[]) => msgs.find((m) => ["task.completed", "task.failed", "task.rejected"].includes(m.event));
const children: Proc[] = [];

afterAll(async () => {
  for (const p of children.reverse()) await stop(p.child);
  cleanupTmp();
});

function serverPath(rel: string): string {
  const p = resolve(REPO, rel);
  if (existsSync(p)) return p;
  // Some examples name their entry differently.
  for (const alt of ["dist/server.js", "dist/main.js", "dist/index.js"]) {
    const q = resolve(REPO, rel.split("/dist/")[0]!, alt);
    if (existsSync(q)) return q;
  }
  throw new Error(`missing build output for ${rel} (run pnpm -r build)`);
}

describe.skipIf(providers.length === 0)("example apps with real agents", () => {
  for (const provider of providers) {
    describe(provider, () => {
      let relay: RelayHandle;
      let desktop: { proc: Proc; workspace: string };
      const ws = tmp(`real-${provider}-`);

      it("setup: relay, headless desktop with the real adapter, three example servers", async () => {
        ensureBinaries();
        mkdirSync(join(ws, "src"), { recursive: true });
        writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "tiny-notes", version: "1.0.0", description: "A tiny notes service", main: "src/index.js" }, null, 2));
        writeFileSync(join(ws, "src/index.js"), "const notes = [];\nexport function addNote(text) { notes.push({ text, at: Date.now() }); return notes.length; }\nexport function listNotes() { return notes.slice(); }\n");
        relay = await startRelay({
          services: Object.values(APPS).map((a) => ({ id: a.id, displayName: a.name, origin: a.origin, secretSha256: sha256(a.secret), verification: "operator" as const })),
        });
        children.push(relay.proc);
        desktop = await startDesktop(relay.url, { provider, permissionChoice: "allow_once", workspace: ws });
        children.push(desktop.proc);
      }, 240_000);

      it("minimal-integration: ask -> streamed answer", async () => {
        const app = await startNodeServer(serverPath(APPS.minimal.server), { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: APPS.minimal.secret }, "minimal");
        children.push(app.proc);
        const c = new AppClient(app.base);
        const pairing = await c.post("/api/connect");
        const waiting = c.call("/api/connect/wait");
        await pairDesktop(desktop.proc, pairing.body.url);
        expect((await waiting).body).toEqual({ status: "accepted" });
        await eventually(() => c.call("/api/status"), (r) => r.body.online === true, 20_000);
        const ask = await c.post("/api/ask", { prompt: "Reply with exactly the text MINIMAL_OK and nothing else. Do not use tools." });
        expect(ask.status).toBe(201);
        const events = await c.sse(`/api/tasks/${ask.body.taskId}/events`, { timeoutMs: 240_000 });
        console.log(`[${provider}] minimal:`, JSON.stringify(streamedText(events)));
        expect(streamedText(events)).toContain("MINIMAL_OK");
        expect(terminal(events)?.event).toBe("task.completed");
      }, 300_000);

      it("code-review-assistant: architecture review with website instructions", async () => {
        const app = await startNodeServer(serverPath(APPS.review.server), { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: APPS.review.secret }, "review");
        children.push(app.proc);
        const c = new AppClient(app.base);
        expect((await c.post("/api/login", { username: "alice" })).status).toBe(200);
        const pairing = await c.post("/api/pairings");
        await pairDesktop(desktop.proc, pairing.body.url);
        await eventually(() => c.call("/api/connection"), (r) => r.body.connection?.online === true, 20_000);
        const created = await c.post("/api/reviews", { type: "architecture" });
        expect(created.status).toBe(201);
        const events = await c.sse(`/api/reviews/${created.body.id}/events`, { timeoutMs: 300_000 });
        const text = streamedText(events);
        console.log(`[${provider}] review (${text.length} chars):`, JSON.stringify(text.slice(0, 300)));
        expect(terminal(events)?.event).toBe("task.completed");
        expect(text.length).toBeGreaterThan(80);
        expect(text.toLowerCase()).toMatch(/note/);
        expect(existsSync(join(ws, "REVIEW.md"))).toBe(false); // read-only review never writes
      }, 360_000);

      it("docs-generator: README written after a real permission prompt (allowed on the desktop)", async () => {
        const app = await startNodeServer(serverPath(APPS.docs.server), { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: APPS.docs.secret }, "docs");
        children.push(app.proc);
        const c = new AppClient(app.base);
        expect((await c.post("/api/login", { username: "alice" })).status).toBe(200);
        const pairing = await c.post("/api/pairings");
        await pairDesktop(desktop.proc, pairing.body.url);
        await eventually(() => c.call("/api/connection"), (r) => r.body.state === "online", 20_000);
        const job = await c.post("/api/jobs", { doc: "readme", notes: "Keep it short." });
        expect(job.status).toBe(201);
        const events = await c.sse(`/api/jobs/${job.body.id}/events`, { timeoutMs: 300_000 });
        const pending = events.filter((m) => m.event === "task.event" && m.data.payload.type === "permission_pending").map((m) => m.data.payload.title);
        await new Promise((r) => setTimeout(r, 1500));
        console.log(`[${provider}] desktop diag:`, desktop.proc.lines.filter((l) => l.includes("[diag]")).join("\n"));
        console.log(`[${provider}] docs: permission prompts ${JSON.stringify(pending)}, terminal ${JSON.stringify(terminal(events)?.data?.payload)}`);
        expect(terminal(events)?.event).toBe("task.completed");
        expect(pending.length).toBeGreaterThan(0);
        const readme = readFileSync(join(ws, "README.md"), "utf8");
        console.log(`[${provider}] README.md: ${readme.length} chars`);
        expect(readme.toLowerCase()).toContain("note");
      }, 360_000);
    });
  }
});
