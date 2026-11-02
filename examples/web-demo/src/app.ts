/**
 * DEMO ONLY — "Acme Notes": a minimal SaaS backend integrating Remote ACP
 * Bridge. Sign-in is fake (pick any username). Everything is in memory.
 *
 * Security properties this demo does implement (copy them):
 * - The service secret stays on the server; the browser only talks to us.
 * - Session cookie is random, HttpOnly, SameSite=Lax; mutating requests
 *   must come from our own Origin.
 * - The browser never chooses an externalUserId or connectionId: both are
 *   derived from the signed-in session server-side.
 * - Task status/cancel/events are only served for tasks this user started.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteAcp, RemoteAcpError, type ConnectionInfo } from "@remote-acp/web-sdk";

export interface DemoConfig {
  relayUrl: string;
  serviceId: string;
  serviceSecret: string;
  /** Directory with index.html / app.js / styles.css. */
  publicDir?: string;
  /** Set the `Secure` cookie attribute (use behind https). */
  secureCookies?: boolean;
  /** Pairing link lifetime in seconds (default 120). */
  pairingTtlSeconds?: number;
  /** Injected client (tests). */
  bridge?: RemoteAcp;
}

interface Session {
  username: string;
  createdAt: number;
}

interface UserState {
  pairingId?: string;
  /** taskIds this user started — the ownership check for task routes. */
  tasks: Set<string>;
}

const USERNAME_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const MAX_BODY = 80 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
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

/** Path of the built @remote-acp/browser-helper ES module (served to the browser as-is). */
function resolveBrowserHelper(): string {
  try {
    if (typeof import.meta.resolve === "function") return fileURLToPath(import.meta.resolve("@remote-acp/browser-helper"));
  } catch {
    /* fall through */
  }
  return fileURLToPath(new URL("../node_modules/@remote-acp/browser-helper/dist/index.js", import.meta.url));
}

/** The relay-side user id for a demo user. Never taken from the browser. */
export function externalUserIdFor(username: string): string {
  return `acme-demo:${username}`;
}

export function createDemoServer(cfg: DemoConfig): Server {
  const bridge =
    cfg.bridge ?? new RemoteAcp({ relayUrl: cfg.relayUrl, serviceId: cfg.serviceId, serviceSecret: cfg.serviceSecret });
  const publicDir = cfg.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url));
  let helperPath: string | undefined;
  const sessions = new Map<string, Session>();
  const users = new Map<string, UserState>();
  const userState = (u: string) => {
    let s = users.get(u);
    if (!s) users.set(u, (s = { tasks: new Set() }));
    return s;
  };

  // ------------------------------------------------------------- helpers

  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? "; Secure" : ""}`;

  function sessionOf(req: IncomingMessage): { sid: string; session: Session } | null {
    const header = req.headers.cookie ?? "";
    for (const part of header.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === "acme_sid") {
        const sid = v.join("=");
        const session = sessions.get(sid);
        if (session) return { sid, session };
      }
    }
    return null;
  }

  function requireUser(req: IncomingMessage): string {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "signed_out", "Please sign in first.");
    return s.session.username;
  }

  function checkOrigin(req: IncomingMessage) {
    // CSRF defence in depth on top of SameSite=Lax.
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, "bad_origin", "Cross-origin request refused.");
    }
    if (host !== req.headers.host) throw new HttpError(403, "bad_origin", "Cross-origin request refused.");
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "too_large", "Request body too large.");
      chunks.push(c as Buffer);
    }
    if (size === 0) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "bad_json", "Invalid JSON body.");
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(text);
  }

  function sendError(res: ServerResponse, e: unknown) {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof RemoteAcpError) {
      // The relay rejecting *our service credential* is a server misconfiguration,
      // not the browser user's fault.
      if (e.code === "unauthorized") {
        return send(res, 502, { error: { code: "relay_auth_failed", message: "The demo server's relay credentials are invalid." } });
      }
      const status = e.status >= 400 && e.status < 600 ? e.status : 502;
      return send(res, status, { error: { code: e.code, message: e.message } });
    }
    console.error("[web-demo] unexpected error", e);
    return send(res, 500, { error: { code: "internal", message: "Something went wrong." } });
  }

  /** The user's usable connection (newest active/paused), plus the newest of any status. */
  async function connectionsOf(username: string): Promise<{ current: ConnectionInfo | null; latest: ConnectionInfo | null }> {
    const list = await bridge.listConnections(externalUserIdFor(username));
    const current = list.find((c) => c.status === "active" || c.status === "paused") ?? null;
    return { current, latest: list[0] ?? null };
  }

  const publicConnection = (c: ConnectionInfo | null) =>
    c && {
      connectionId: c.connectionId,
      status: c.status,
      online: c.online,
      provider: c.provider,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
    };

  function ownTask(username: string, taskId: string) {
    if (!userState(username).tasks.has(taskId)) throw new HttpError(404, "not_found", "Task not found.");
  }

  // -------------------------------------------------------------- routes

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (method !== "GET") checkOrigin(req);

    if (path === "/api/me" && method === "GET") {
      const s = sessionOf(req);
      return send(res, 200, { user: s ? { username: s.session.username } : null });
    }

    if (path === "/api/login" && method === "POST") {
      const body = await readJson(req);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      if (!USERNAME_RE.test(username)) {
        throw new HttpError(400, "invalid_username", "Use 2–24 lowercase letters, digits, '-' or '_', starting with a letter.");
      }
      const old = sessionOf(req);
      if (old) sessions.delete(old.sid);
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sid, { username, createdAt: Date.now() });
      return send(res, 200, { user: { username } }, { "set-cookie": `acme_sid=${sid}; ${cookieAttrs}; Max-Age=86400` });
    }

    if (path === "/api/logout" && method === "POST") {
      const s = sessionOf(req);
      if (s) sessions.delete(s.sid);
      return send(res, 200, { ok: true }, { "set-cookie": `acme_sid=; ${cookieAttrs}; Max-Age=0` });
    }

    const username = requireUser(req);

    if (path === "/api/connection" && method === "GET") {
      const { current, latest } = await connectionsOf(username);
      return send(res, 200, { connection: publicConnection(current), latest: publicConnection(latest) });
    }

    if (path === "/api/connection/disconnect" && method === "POST") {
      const list = await bridge.listConnections(externalUserIdFor(username));
      const live = list.filter((c) => c.status === "active" || c.status === "paused");
      for (const c of live) await bridge.revokeConnection(c.connectionId);
      return send(res, 200, { ok: true, revoked: live.length });
    }

    if (path === "/api/pairings" && method === "POST") {
      const p = await bridge.createPairing({
        externalUserId: externalUserIdFor(username),
        scopes: ["task.interactive"],
        expiresInSeconds: cfg.pairingTtlSeconds ?? 120,
      });
      userState(username).pairingId = p.pairingId;
      return send(res, 200, { pairingId: p.pairingId, url: p.url, code: p.code, expiresAt: p.expiresAt });
    }

    if (path === "/api/pairings/current" && method === "GET") {
      const pid = userState(username).pairingId;
      if (!pid) return send(res, 200, { pairing: null, connection: null });
      const p = await bridge.getPairing(pid);
      let connection: ConnectionInfo | null = null;
      if (p.status === "accepted" && p.connectionId) connection = await bridge.getConnection(p.connectionId);
      return send(res, 200, {
        pairing: { pairingId: p.pairingId, status: p.status, expiresAt: p.expiresAt },
        connection: publicConnection(connection),
      });
    }

    if (path === "/api/tasks" && method === "POST") {
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (!prompt.trim()) throw new HttpError(400, "empty_prompt", "Type a prompt first.");
      const idem =
        typeof body.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.idempotencyKey) ? body.idempotencyKey : randomUUID();
      const { current } = await connectionsOf(username);
      if (!current) throw new HttpError(409, "not_connected", "Connect your desktop agent first.");
      const task = await bridge.startTask({
        connectionId: current.connectionId,
        externalUserId: externalUserIdFor(username),
        prompt,
        // Namespace the browser-provided key per user so users cannot collide.
        idempotencyKey: `${username}:${idem}`.slice(0, 128),
      });
      userState(username).tasks.add(task.taskId);
      return send(res, 201, task);
    }

    const m = /^\/api\/tasks\/([A-Za-z0-9_-]{1,128})(\/cancel|\/events)?$/.exec(path);
    if (m) {
      const taskId = m[1]!;
      ownTask(username, taskId);
      if (!m[2] && method === "GET") return send(res, 200, await bridge.getTask(taskId));
      if (m[2] === "/cancel" && method === "POST") return send(res, 200, await bridge.cancelTask(taskId));
      if (m[2] === "/events" && method === "GET") return proxyEvents(req, res, taskId);
    }

    throw new HttpError(404, "not_found", "No such endpoint.");
  }

  /** Re-stream relay SSE to the browser (EventSource-compatible, resumable). */
  async function proxyEvents(req: IncomingMessage, res: ServerResponse, taskId: string) {
    const lastId = req.headers["last-event-id"];
    const lastEventId = typeof lastId === "string" && /^\d+$/.test(lastId) ? Number(lastId) : undefined;
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
        if ("seq" in ev) {
          res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
        } else {
          res.write(`event: notice\ndata: ${JSON.stringify(ev.payload)}\n\n`);
        }
      }
      res.write(`event: end\ndata: {}\n\n`);
    } catch (e) {
      if (!ac.signal.aborted) {
        const code = e instanceof RemoteAcpError ? e.code : "internal";
        const message = e instanceof RemoteAcpError ? e.message : "Event stream failed";
        res.write(`event: proxy_error\ndata: ${JSON.stringify({ code, message })}\n\n`);
      }
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  }

  async function serveStatic(res: ServerResponse, path: string) {
    let file: string;
    if (path === "/vendor/browser-helper.js") {
      file = helperPath ??= resolveBrowserHelper();
    } else {
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
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const handler = path.startsWith("/api/") ? api(req, res, path) : req.method === "GET" ? serveStatic(res, path) : Promise.reject(new HttpError(405, "method", "Method not allowed"));
    handler.catch((e: unknown) => {
      if (res.headersSent) return res.end();
      sendError(res, e);
    });
  });
}
