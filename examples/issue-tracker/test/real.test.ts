// Bugboard with a REAL agent (Codex or Claude Code via their official ACP
// adapters, using the developer's own sign-in). Opt-in:
//
//   REAL_AGENTS=codex,claude pnpm --filter @remote-acp/example-issue-tracker test
//
// A copy of sample-project/ is the workspace ("Can edit" access). The agent
// gets BUG-101 (a real bug in src/slugify.js), Bugboard's instructions and
// Bugboard's MCP tools. We check that it reported back through the tools
// (comment + "in_review") and that the bug is really fixed on disk.
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTmp, ensureBinaries, pairDesktop, sha256, startDesktop, startNodeServer, startRelay, stop, tmp, type Proc } from "../../../tests/node-e2e/test/harness.js";
import { AppClient, eventually, streamedText, type SseMessage } from "../../../tests/node-e2e/test/app-client.js";

const providers = (process.env.REAL_AGENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is "codex" | "claude" => s === "codex" || s === "claude");

const SECRET = "dev-only-bugboard-secret-0123456789abcdef";
const SERVER = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../sample-project/", import.meta.url));
const terminal = (msgs: SseMessage[]) => msgs.find((m) => ["task.completed", "task.failed", "task.rejected"].includes(m.event));
const children: Proc[] = [];

afterAll(async () => {
  for (const p of children.reverse()) await stop(p.child);
  cleanupTmp();
});

describe.skipIf(providers.length === 0)("Bugboard with real agents", () => {
  for (const provider of providers) {
    it(`${provider}: fixes BUG-101 in the sample project and reports back through Bugboard's MCP tools`, async () => {
      ensureBinaries();
      const ws = tmp(`bugboard-${provider}-`);
      cpSync(SAMPLE, ws, { recursive: true });
      const before = spawnSync(process.execPath, ["--input-type=module", "-e", `import { slugify } from ${JSON.stringify(join(ws, "src/slugify.js"))}; console.log(slugify("Summer Sale -- 50% OFF!"));`], { encoding: "utf8" });
      expect(before.stdout.trim()).toBe("Summer-Sale----50--OFF"); // the bug is real

      const relay = await startRelay({
        services: [{ id: "svc_bugboard", displayName: "Bugboard (example)", origin: "http://localhost:3104", secretSha256: sha256(SECRET), verification: "operator" }],
      });
      children.push(relay.proc);
      const desktop = await startDesktop(relay.url, { provider, permissionChoice: "allow_once", workspace: ws, access: "workspace_write" });
      children.push(desktop.proc);
      const app = await startNodeServer(SERVER, { RELAY_URL: relay.url, REMOTE_ACP_SERVICE_SECRET: SECRET }, `bugboard-${provider}`);
      children.push(app.proc);

      const c = new AppClient(app.base);
      expect((await c.post("/api/login", { username: "alice" })).status).toBe(200);
      const pairing = await c.post("/api/pairings");
      await pairDesktop(desktop.proc, pairing.body.url);
      await eventually(() => c.call("/api/connection"), (r) => r.body.connection?.online === true && r.body.connection?.tools === true, 20_000);

      const created = await c.post("/api/issues/BUG-101/fix");
      expect(created.status).toBe(201);
      const runId = created.body.id as string;
      const events = await c.sse(`/api/runs/${runId}/events`, { timeoutMs: 600_000 });
      await new Promise((r) => setTimeout(r, 1000));

      const text = streamedText(events);
      const toolTitles = events.filter((m) => m.event === "task.event" && m.data.payload.type === "tool_call").map((m) => m.data.payload.title);
      const prompts = events.filter((m) => m.event === "task.event" && m.data.payload.type === "permission_pending").map((m) => m.data.payload.title);
      const snap = (await c.call("/api/issues/BUG-101")).body;
      const run = snap.runs.find((r: { id: string }) => r.id === runId);
      const agentComments = snap.issue.comments.filter((x: { authorKind: string }) => x.authorKind === "agent");
      console.log(`[${provider}] terminal: ${JSON.stringify(terminal(events)?.data?.payload)}`);
      console.log(`[${provider}] agent tool calls: ${JSON.stringify(toolTitles)}`);
      console.log(`[${provider}] desktop permission prompts: ${JSON.stringify(prompts)}`);
      console.log(`[${provider}] Bugboard MCP calls: ${JSON.stringify(run?.toolCalls)}`);
      console.log(`[${provider}] final text: ${JSON.stringify(text.slice(-600))}`);
      console.log(`[${provider}] desktop diag:\n${desktop.proc.lines.filter((l) => l.includes("[diag]")).join("\n")}`);
      for (const ac of agentComments) console.log(`[${provider}] AGENT COMMENT by ${ac.author}:\n${ac.body}\n`);

      expect(terminal(events)?.event).toBe("task.completed");
      expect(agentComments.length).toBeGreaterThan(0);
      expect(agentComments.at(-1).author).toBe("alice's agent");
      expect(run.toolCalls.some((t: { tool: string; ok: boolean }) => t.tool === "add_comment" && t.ok)).toBe(true);
      expect(snap.issue.status).toBe("in_review");

      // The fix is real: the reported case works and the project's own tests pass.
      const after = spawnSync(process.execPath, ["--input-type=module", "-e", `import { slugify } from ${JSON.stringify(join(ws, "src/slugify.js"))}; console.log(slugify("Summer Sale -- 50% OFF!")); console.log(slugify("crème brûlée"));`], { encoding: "utf8" });
      console.log(`[${provider}] slugify after fix: ${JSON.stringify(after.stdout)}`);
      expect(after.stdout.trim().split("\n")).toEqual(["summer-sale-50-off", "creme-brulee"]);
      const tests = spawnSync(process.execPath, ["--test"], { cwd: ws, encoding: "utf8" });
      console.log(`[${provider}] node --test: status ${tests.status}\n${tests.stdout.split("\n").filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join("\n")}`);
      expect(tests.status).toBe(0);
      console.log(`[${provider}] src/slugify.js after:\n${readFileSync(join(ws, "src/slugify.js"), "utf8")}`);
    }, 900_000);
  }
});
