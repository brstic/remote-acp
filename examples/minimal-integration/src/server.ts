/**
 * EXAMPLE — the smallest useful Remote ACP Bridge integration.
 *
 * Read this file top to bottom. It is a complete website backend that lets a
 * visitor connect *their own* desktop AI agent (Codex, Claude Code, or the
 * built-in Test agent) and ask it something, with the answer streamed back.
 *
 * Plain `node:http`, no framework, everything in memory. The browser page is
 * in ../public (zero-build vanilla JS).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { RemoteAcp, RemoteAcpError } from "@remote-acp/web-sdk";

// ---------------------------------------------------------------------------
// Step 1 — create the SDK client. It authenticates *this website* to the relay
// with the service id + secret registered in the relay config (relay.dev.json).
// The secret lives only here, on the server. Never send it to a browser.
// ---------------------------------------------------------------------------
const secret = process.env.REMOTE_ACP_SERVICE_SECRET;
if (!secret) {
  console.error("Set REMOTE_ACP_SERVICE_SECRET (see README.md; `pnpm dev` sets the dev-only secret).");
  process.exit(1);
}
const bridge = new RemoteAcp({
  relayUrl: process.env.RELAY_URL ?? "http://127.0.0.1:8787",
  serviceId: process.env.REMOTE_ACP_SERVICE_ID ?? "svc_minimal",
  serviceSecret: secret,
});

// ---------------------------------------------------------------------------
// Step 2 — who is the user? A real website uses its own sign-in and passes the
// signed-in user's id. To stay tiny, this example has ONE fixed demo user, so
// anyone who can open this page acts as that user. Never do that in production.
// ---------------------------------------------------------------------------
const USER_ID = "minimal-example-user";
let pairingId: string | null = null; // the pairing currently shown to the user
let connectionId: string | null = null; // set once the user approved on their desktop
const myTasks = new Set<string>(); // tasks we started: only these may be streamed/cancelled

// ---------------------------------------------------------------------------
// Step 3 — the HTTP API used by public/app.js.
// ---------------------------------------------------------------------------
async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  // 3a. "Connect": create a one-time pairing and give the browser ONLY the
  // remoteacp:// link, the short code and the expiry. The user opens the link
  // (or types the code) in the Remote ACP Bridge desktop app and approves.
  if (req.method === "POST" && path === "/api/connect") {
    const p = await bridge.createPairing({ externalUserId: USER_ID, expiresInSeconds: 120 });
    pairingId = p.pairingId;
    return json(res, 200, { url: p.url, code: p.code, expiresAt: p.expiresAt });
  }

  // 3b. Long-poll until the user accepts, declines, or the link expires.
  // `waitForPairing` polls the relay for us. If the browser goes away, stop.
  if (req.method === "GET" && path === "/api/connect/wait") {
    if (!pairingId) return json(res, 409, { error: { code: "no_pairing", message: "Click Connect first." } });
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const final = await bridge.waitForPairing(pairingId, { signal: ac.signal });
    if (final.status === "accepted" && final.connectionId) connectionId = final.connectionId;
    return json(res, 200, { status: final.status });
  }

  // 3c. Status: is there a connection, and is the desktop online right now?
  if (req.method === "GET" && path === "/api/status") {
    if (!connectionId) return json(res, 200, { connected: false });
    const c = await bridge.getConnection(connectionId);
    return json(res, 200, { connected: c.status === "active" || c.status === "paused", status: c.status, online: c.online, provider: c.provider });
  }

  // 3d. Ask: start an interactive task on the user's desktop agent. The relay
  // checks the connection belongs to this user, is active and online. The
  // desktop then asks the user to approve the task (unless they turned that off).
  if (req.method === "POST" && path === "/api/ask") {
    const { prompt } = (await readJson(req)) as { prompt?: unknown };
    if (typeof prompt !== "string" || !prompt.trim()) return json(res, 400, { error: { code: "empty_prompt", message: "Type a question first." } });
    if (!connectionId) return json(res, 409, { error: { code: "not_connected", message: "Connect your desktop agent first." } });
    const task = await bridge.startTask({ connectionId, externalUserId: USER_ID, prompt, idempotencyKey: randomUUID() });
    myTasks.add(task.taskId);
    return json(res, 201, { taskId: task.taskId });
  }

  // 3e. Stream the task's events to the browser as Server-Sent Events. The SDK
  // reconnects to the relay by itself; we forward the browser's Last-Event-ID
  // so an EventSource reconnect resumes instead of starting over.
  const m = /^\/api\/tasks\/([A-Za-z0-9_.:-]{1,128})\/(events|cancel)$/.exec(path);
  if (m && myTasks.has(m[1]!)) {
    const taskId = m[1]!;
    if (req.method === "POST" && m[2] === "cancel") return json(res, 200, await bridge.cancelTask(taskId));
    if (req.method === "GET" && m[2] === "events") {
      const last = req.headers["last-event-id"];
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      try {
        const opts = { signal: ac.signal, ...(typeof last === "string" && /^\d+$/.test(last) ? { lastEventId: Number(last) } : {}) };
        for await (const ev of bridge.streamEvents(taskId, opts)) {
          // Each relay event: {seq, kind, payload}. Kinds: task.accepted, task.event
          // (text_delta, plan, tool_call, permission_pending, ...), and exactly one
          // terminal event: task.completed, task.failed or task.rejected.
          if ("seq" in ev) res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
        }
        res.write("event: end\ndata: {}\n\n"); // tells the page not to reconnect
      } catch (e) {
        if (!ac.signal.aborted) res.write(`event: end\ndata: ${JSON.stringify({ error: errorBody(e).error })}\n\n`);
      }
      return void res.end();
    }
  }
  json(res, 404, { error: { code: "not_found", message: "No such endpoint." } });
}

// ---------------------------------------------------------------------------
// Step 4 — the web server: security headers, a same-origin check for POSTs,
// static files, and turning SDK errors into JSON the page can show.
// ---------------------------------------------------------------------------
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const STATIC: Record<string, [string, string]> = {
  "/": [`${PUBLIC}index.html`, "text/html; charset=utf-8"],
  "/app.js": [`${PUBLIC}app.js`, "text/javascript; charset=utf-8"],
  "/style.css": [`${PUBLIC}style.css`, "text/css; charset=utf-8"],
  // The browser helper renders the pairing button + code. It contains no secrets.
  "/vendor/browser-helper.js": [fileURLToPath(import.meta.resolve("@remote-acp/browser-helper")), "text/javascript; charset=utf-8"],
};

const server = createServer((req, res) => {
  // Strict CSP: only our own scripts/styles, no inline code, no framing.
  res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  const path = new URL(req.url ?? "/", "http://x").pathname;
  // CSRF defence: a browser always sends Origin on cross-site POSTs; refuse foreign ones.
  if (req.method === "POST" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    return json(res, 403, { error: { code: "bad_origin", message: "Cross-origin request refused." } });
  }
  const file = STATIC[path];
  const work = file && req.method === "GET" ? serveFile(res, file) : path.startsWith("/api/") ? api(req, res, path) : Promise.resolve(json(res, 404, {}));
  work.catch((e: unknown) => (res.headersSent ? res.end() : json(res, statusOf(e), errorBody(e))));
});

async function serveFile(res: ServerResponse, [file, type]: [string, string]) {
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" }).end(await readFile(file));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    if ((size += chunk.length) > 70_000) throw new Error("body too large"); // prompts are capped at 64 KiB
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

// Relay errors carry a stable `code` (desktop_offline, connection_revoked,
// task_in_progress, ...). The page maps codes to friendly text.
function errorBody(e: unknown) {
  if (e instanceof RemoteAcpError) return { error: { code: e.code, message: e.message } };
  console.error(e);
  return { error: { code: "internal", message: "Something went wrong." } };
}
function statusOf(e: unknown): number {
  return e instanceof RemoteAcpError && e.status >= 400 && e.status !== 401 ? e.status : 502;
}

// ---------------------------------------------------------------------------
// Step 5 — listen. (The JSON line is read by the automated test.)
// ---------------------------------------------------------------------------
server.listen(Number(process.env.PORT ?? 3101), process.env.HOST ?? "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  console.log(JSON.stringify({ event: "listening", port }));
  console.log(`Minimal integration example on http://localhost:${port}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
