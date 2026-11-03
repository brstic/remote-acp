/**
 * EXAMPLE — "Docs Generator": asks the user's desktop agent to WRITE a
 * README / CONTRIBUTING / CHANGELOG into their project folder.
 *
 * What this example shows:
 * - the permission flow: writing a file triggers a local permission prompt in
 *   Remote ACP Bridge. The website receives `permission_pending` and
 *   `permission_resolved` events and can only *observe* them — there is no API
 *   to answer a permission on the user's behalf,
 * - error handling with friendly messages for every relay/desktop error code
 *   (see errors.ts), returned by the server so every client shows the same text,
 * - connection status (online / offline / paused / revoked) via getConnection,
 *   and Disconnect via revokeConnection.
 *
 * DEMO sign-in: pick any username. Everything is in memory.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteAcp, RemoteAcpError, type ConnectionInfo } from "@remote-acp/web-sdk";
import { DOC_TYPES, buildDocPrompt, cleanNotes, docType } from "./docs.js";
import { friendlyError } from "./errors.js";

export interface DocsServerConfig {
  relayUrl: string;
  serviceId: string;
  serviceSecret: string;
  publicDir?: string;
  secureCookies?: boolean;
  pairingTtlSeconds?: number;
  bridge?: RemoteAcp;
}

interface Job {
  id: string; // relay taskId
  doc: string;
  file: string;
  notes: string;
  prompt: string;
  createdAt: string;
}

interface UserState {
  pairingId?: string;
  /** The connection this user approved (kept even after revocation, to report its status). */
  connectionId?: string;
  jobs: Map<string, Job>;
}

/** Website-facing connection state. */
export type ConnectionState = "none" | "online" | "offline" | "paused" | "revoked" | "expired";

const USERNAME_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const MAX_BODY = 16 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const externalUserIdFor = (username: string) => `docs-example:${username}`;

export function connectionState(c: ConnectionInfo | null): ConnectionState {
  if (!c) return "none";
  if (c.status === "active") return c.online ? "online" : "offline";
  return c.status; // paused | revoked | expired
}

export function createDocsServer(cfg: DocsServerConfig): Server {
  const bridge = cfg.bridge ?? new RemoteAcp({ relayUrl: cfg.relayUrl, serviceId: cfg.serviceId, serviceSecret: cfg.serviceSecret });
  const publicDir = cfg.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url));
  const sessions = new Map<string, string>();
  const users = new Map<string, UserState>();
  const userState = (u: string) => {
    let s = users.get(u);
    if (!s) users.set(u, (s = { jobs: new Map() }));
    return s;
  };
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? "; Secure" : ""}`;

  function sessionOf(req: IncomingMessage): { sid: string; username: string } | null {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k !== "docs_sid") continue;
      const sid = v.join("=");
      const username = sessions.get(sid);
      if (username) return { sid, username };
    }
    return null;
  }

  function requireUser(req: IncomingMessage): string {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "signed_out", "Please sign in first.");
    return s.username;
  }

  function checkOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* refused below */
    }
    if (host !== req.headers.host) throw new HttpError(403, "bad_origin", "Cross-origin request refused.");
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      if ((size += c.length) > MAX_BODY) throw new HttpError(413, "too_large", "Request body too large.");
      chunks.push(c);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "bad_json", "Invalid JSON body.");
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  /** Every error carries the raw `code` plus a friendly title/message. */
  function sendError(res: ServerResponse, e: unknown) {
    let status = 500;
    let code = "internal";
    let message = "Something went wrong.";
    if (e instanceof HttpError) {
      ({ status, code, message } = e);
    } else if (e instanceof RemoteAcpError) {
      if (e.code === "unauthorized") {
        status = 502;
        code = "relay_auth_failed";
      } else {
        status = e.status >= 400 && e.status < 600 ? e.status : 502;
        code = e.code;
      }
      message = e.message;
    } else {
      console.error("[docs-generator] unexpected error", e);
    }
    const f = friendlyError(code, message);
    send(res, status, { error: { code, message: f.message, title: f.title, reconnect: !!f.reconnect, detail: message } });
  }

  /** The user's connection: the one they approved, else the newest live one on the relay. */
  async function connectionOf(username: string): Promise<ConnectionInfo | null> {
    const u = userState(username);
    let stored: ConnectionInfo | null = null;
    if (u.connectionId) {
      try {
        stored = await bridge.getConnection(u.connectionId);
        if (stored.status === "active" || stored.status === "paused") return stored;
      } catch (e) {
        if (!(e instanceof RemoteAcpError && e.status === 404)) throw e;
        delete u.connectionId;
      }
    }
    // Revoked/expired (or unknown): prefer a newer live connection if there is one.
    const list = await bridge.listConnections(externalUserIdFor(username));
    const live = list.find((c) => c.status === "active" || c.status === "paused") ?? null;
    if (live) u.connectionId = live.connectionId;
    return live ?? stored;
  }

  const publicConnection = (c: ConnectionInfo | null) => ({
    state: connectionState(c),
    connection: c && { connectionId: c.connectionId, status: c.status, online: c.online, provider: c.provider, createdAt: c.createdAt, expiresAt: c.expiresAt },
  });

  const jobSummary = (j: Job) => ({ id: j.id, doc: j.doc, file: j.file, notes: j.notes, createdAt: j.createdAt });

  function ownJob(username: string, id: string): Job {
    const j = userState(username).jobs.get(id);
    if (!j) throw new HttpError(404, "not_found", "Job not found.");
    return j;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (method !== "GET") checkOrigin(req);

    if (path === "/api/me" && method === "GET") {
      const s = sessionOf(req);
      return send(res, 200, { user: s ? { username: s.username } : null });
    }
    if (path === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      if (!USERNAME_RE.test(username)) {
        throw new HttpError(400, "invalid_username", "Use 2-24 lowercase letters, digits, '-' or '_', starting with a letter.");
      }
      const old = sessionOf(req);
      if (old) sessions.delete(old.sid);
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sid, username);
      return send(res, 200, { user: { username } }, { "set-cookie": `docs_sid=${sid}; ${cookieAttrs}; Max-Age=86400` });
    }
    if (path === "/api/logout" && method === "POST") {
      const s = sessionOf(req);
      if (s) sessions.delete(s.sid);
      return send(res, 200, { ok: true }, { "set-cookie": `docs_sid=; ${cookieAttrs}; Max-Age=0` });
    }
    if (path === "/api/doc-types" && method === "GET") {
      return send(res, 200, { types: DOC_TYPES.map(({ id, file, title, description }) => ({ id, file, title, description })) });
    }

    const username = requireUser(req);
    const user = userState(username);

    if (path === "/api/connection" && method === "GET") {
      return send(res, 200, publicConnection(await connectionOf(username)));
    }
    if (path === "/api/connection/disconnect" && method === "POST") {
      const c = await connectionOf(username);
      if (!c || c.status === "revoked" || c.status === "expired") throw new HttpError(409, "not_connected", "Not connected.");
      await bridge.revokeConnection(c.connectionId);
      return send(res, 200, publicConnection(await bridge.getConnection(c.connectionId)));
    }
    if (path === "/api/pairings" && method === "POST") {
      const p = await bridge.createPairing({
        externalUserId: externalUserIdFor(username),
        scopes: ["task.interactive"],
        expiresInSeconds: cfg.pairingTtlSeconds ?? 120,
      });
      user.pairingId = p.pairingId;
      return send(res, 200, { url: p.url, code: p.code, expiresAt: p.expiresAt });
    }
    if (path === "/api/pairings/current" && method === "GET") {
      if (!user.pairingId) return send(res, 200, { pairing: null });
      const p = await bridge.getPairing(user.pairingId);
      if (p.status === "accepted" && p.connectionId) user.connectionId = p.connectionId;
      return send(res, 200, { pairing: { status: p.status, expiresAt: p.expiresAt } });
    }

    if (path === "/api/jobs" && method === "GET") {
      return send(res, 200, { jobs: [...user.jobs.values()].reverse().map(jobSummary) });
    }
    if (path === "/api/jobs" && method === "POST") {
      const body = await readJson(req);
      const doc = docType(body.doc);
      if (!doc) throw new HttpError(400, "invalid_doc", "Pick a document to generate.");
      const notes = cleanNotes(body.notes);
      const prompt = buildDocPrompt(doc, notes);
      const conn = await connectionOf(username);
      if (!conn) throw new HttpError(409, "not_connected", "Connect your desktop agent first.");
      // Deliberately no client-side pre-checks for paused/offline/revoked: the
      // relay is the source of truth and returns precise error codes.
      const idem = typeof body.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : randomUUID();
      const task = await bridge.startTask({
        connectionId: conn.connectionId,
        externalUserId: externalUserIdFor(username),
        prompt,
        idempotencyKey: `${username}:${idem}`.slice(0, 128),
      });
      const job: Job = user.jobs.get(task.taskId) ?? { id: task.taskId, doc: doc.id, file: doc.file, notes, prompt, createdAt: task.createdAt };
      user.jobs.set(job.id, job);
      return send(res, 201, jobSummary(job));
    }

    const m = /^\/api\/jobs\/([A-Za-z0-9_.:-]{1,128})(\/cancel|\/events)?$/.exec(path);
    if (m) {
      const job = ownJob(username, m[1]!);
      if (!m[2] && method === "GET") {
        const t = await bridge.getTask(job.id);
        const error = t.error && { ...t.error, ...friendlyError(t.error.code, t.error.message) };
        return send(res, 200, { ...jobSummary(job), prompt: job.prompt, state: t.state, stopReason: t.stopReason, error });
      }
      if (m[2] === "/cancel" && method === "POST") return send(res, 200, await bridge.cancelTask(job.id));
      if (m[2] === "/events" && method === "GET") return proxyEvents(req, res, job.id);
    }
    throw new HttpError(404, "not_found", "No such endpoint.");
  }

  /**
   * Re-stream relay SSE to the browser. Terminal failures get a `friendly`
   * field so every client explains errors the same way.
   */
  async function proxyEvents(req: IncomingMessage, res: ServerResponse, taskId: string) {
    const raw = req.headers["last-event-id"];
    const lastEventId = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    try {
      for await (const ev of bridge.streamEvents(taskId, { signal: ac.signal, ...(lastEventId !== undefined ? { lastEventId } : {}) })) {
        if (!("seq" in ev)) {
          res.write(`event: notice\ndata: ${JSON.stringify(ev.payload)}\n\n`);
          continue;
        }
        const out = ev.kind === "task.failed" || ev.kind === "task.rejected" ? { ...ev, friendly: friendlyError(ev.payload.code, ev.payload.message) } : ev;
        res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(out)}\n\n`);
      }
      res.write("event: end\ndata: {}\n\n");
    } catch (e) {
      if (!ac.signal.aborted) {
        const code = e instanceof RemoteAcpError ? e.code : "internal";
        const f = friendlyError(code, e instanceof RemoteAcpError ? e.message : "Event stream failed");
        res.write(`event: proxy_error\ndata: ${JSON.stringify({ code, ...f })}\n\n`);
      }
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  }

  async function serveStatic(res: ServerResponse, path: string) {
    let file: string;
    if (path === "/vendor/browser-helper.js") file = fileURLToPath(import.meta.resolve("@remote-acp/browser-helper"));
    else {
      const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
      file = normalize(join(publicDir, rel));
      if (!file.startsWith(normalize(publicDir + sep))) throw new HttpError(404, "not_found", "Not found");
    }
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, "not_found", "Not found");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  }

  return createServer((req, res) => {
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const handler = path.startsWith("/api/")
      ? api(req, res, path)
      : req.method === "GET"
        ? serveStatic(res, path)
        : Promise.reject(new HttpError(405, "method", "Method not allowed"));
    handler.catch((e: unknown) => {
      if (res.headersSent) return res.end();
      sendError(res, e);
    });
  });
}
