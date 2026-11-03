/**
 * EXAMPLE — "Bugboard": a team issue tracker where every bug has
 * "Fix with my agent". The fix runs on the user's own desktop agent (Codex,
 * Claude Code or the Test agent) through Remote ACP Bridge, in the project
 * folder the user chose. Bugboard never sees the code or any AI credentials.
 *
 * On top of the other examples this shows:
 * - website `instructions` (the agent's role for Bugboard) and website
 *   `tools`: Bugboard's own MCP server at /mcp, authorised by a short-lived
 *   token bound to (user, issue, run) — see src/tokens.ts and src/mcp.ts,
 * - live issue pages: comments and status changes the agent makes through
 *   the tools are pushed to the browser over a per-issue SSE stream,
 * - a per-run SSE stream (server-side collector, Last-Event-ID replay) with
 *   run state, plan, tool calls and streamed text, plus Cancel,
 * - run history per issue and activity badges on the issue list.
 *
 * DEMO sign-in: pick any name. Everything lives in server memory.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteAcp, RemoteAcpError, type ConnectionInfo, type StreamItem, type TaskStreamEvent } from "@remote-acp/web-sdk";
import { MCP_MAX_BODY, handleMcp, type McpToolCall } from "./mcp.js";
import { FIXER_INSTRUCTIONS, TOOL_SERVER_NAME, buildFixPrompt } from "./prompt.js";
import { STATUS_LABEL, Tracker, TrackerError, type Issue } from "./store.js";
import { DEFAULT_TOKEN_TTL_MS, TokenStore, type TokenGrant } from "./tokens.js";

export interface BugboardConfig {
  relayUrl: string;
  serviceId: string;
  serviceSecret: string;
  /**
   * Public origin of this site, used to build the MCP tool URL
   * (`<publicUrl>/mcp`). Must be on the service's registered domain.
   * Default: `http://localhost:<listening port>`.
   */
  publicUrl?: string;
  publicDir?: string;
  secureCookies?: boolean;
  pairingTtlSeconds?: number;
  /** MCP token lifetime (default 30 minutes). */
  tokenTtlMs?: number;
  /** How long a run's token keeps working after the run finished (default 5 s). */
  tokenGraceMs?: number;
  /**
   * TEST ONLY: print each minted MCP token as a JSON line on stdout so an
   * end-to-end test can play the agent's part. Never enable in production.
   */
  exposeTokensForTests?: boolean;
  /** Max runs kept per issue (oldest finished ones are dropped). Default 10. */
  runHistoryLimit?: number;
  bridge?: RemoteAcp;
}

type RunState = "running" | "completed" | "cancelled" | "failed" | "rejected";
type RunPhase = "starting" | "awaiting_approval" | "running" | "permission_pending" | "cancelling" | "finished";

interface ToolCallLog extends McpToolCall {
  at: string;
}

interface Run {
  id: string; // = relay taskId
  issueId: string;
  username: string;
  prompt: string;
  toolUrl: string;
  createdAt: string;
  finishedAt: string | null;
  state: RunState;
  phase: RunPhase;
  stopReason: string | null;
  error: { code: string; message: string } | null;
  /** Calls the agent made to Bugboard's MCP tools during this run. */
  toolCalls: ToolCallLog[];
  /** Relay events in order (seq ascending), bounded. */
  events: TaskStreamEvent[];
  /** When Bugboard received each stored event (ms), aligned with `events`. */
  eventTimes: number[];
  storedTextBytes: number;
  truncated: boolean;
  preview: string;
  done: boolean;
  listeners: Set<(item: StreamItem | null) => void>;
  abort: AbortController;
}

interface UserState {
  pairingId?: string;
  runs: Map<string, Run>; // runId -> run (all issues)
  /** Recent fix requests by idempotency key, so retries resend the same token. */
  fixRequests: Map<string, { token: string; runId: string | null }>;
}

const USERNAME_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const ISSUE_ID_RE = /^BUG-\d{1,6}$/;
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_BODY = 16 * 1024;
const MAX_STORED_EVENTS = 20_000;
const MAX_STORED_TEXT_BYTES = 512 * 1024;
const MAX_TOOL_LOG = 100;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
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

export const externalUserIdFor = (username: string) => `bugboard-example:${username}`;

function resolveBrowserHelper(): string {
  return fileURLToPath(import.meta.resolve("@remote-acp/browser-helper"));
}

export function createBugboardServer(cfg: BugboardConfig): Server {
  const bridge = cfg.bridge ?? new RemoteAcp({ relayUrl: cfg.relayUrl, serviceId: cfg.serviceId, serviceSecret: cfg.serviceSecret });
  const publicDir = cfg.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url));
  const runHistoryLimit = cfg.runHistoryLimit ?? 10;
  const tokenGraceMs = cfg.tokenGraceMs ?? 5000;
  const sessions = new Map<string, string>(); // sid -> username
  const users = new Map<string, UserState>();
  const issueListeners = new Map<string, Set<() => void>>(); // `${user}/${issueId}` -> listeners
  const tokens = new TokenStore(Date.now, cfg.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS);
  const tracker = new Tracker((username, issue) => notifyIssue(username, issue.id));
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? "; Secure" : ""}`;
  let server: Server;

  const userState = (u: string) => {
    let s = users.get(u);
    if (!s) users.set(u, (s = { runs: new Map(), fixRequests: new Map() }));
    return s;
  };

  function listeningPort(): number {
    const a = server.address();
    return a && typeof a === "object" ? a.port : 3104;
  }
  function publicBase(): string {
    return (cfg.publicUrl ?? `http://localhost:${listeningPort()}`).replace(/\/+$/, "");
  }
  function ownOrigins(): string[] {
    const port = listeningPort();
    return [new URL(publicBase()).origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`];
  }

  // ------------------------------------------------------------ helpers

  function sessionOf(req: IncomingMessage): { sid: string; username: string } | null {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k !== "bugboard_sid") continue;
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
      /* invalid -> refused below */
    }
    if (host !== req.headers.host) throw new HttpError(403, "bad_origin", "Cross-origin request refused.");
  }

  async function readBody(req: IncomingMessage, max: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      if ((size += c.length) > max) throw new HttpError(413, "too_large", "Request body too large.");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readBody(req, MAX_BODY);
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as unknown;
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

  function sendError(res: ServerResponse, e: unknown) {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof TrackerError) return send(res, e.code === "not_found" ? 404 : 400, { error: { code: e.code, message: e.message } });
    if (e instanceof RemoteAcpError) {
      if (e.code === "unauthorized") {
        return send(res, 502, { error: { code: "relay_auth_failed", message: "This server's relay credentials are invalid." } });
      }
      return send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { error: { code: e.code, message: e.message } });
    }
    console.error("[bugboard] unexpected error", e);
    return send(res, 500, { error: { code: "internal", message: "Something went wrong." } });
  }

  async function connections(username: string): Promise<{ current: ConnectionInfo | null; latest: ConnectionInfo | null }> {
    const list = await bridge.listConnections(externalUserIdFor(username));
    return { current: list.find((c) => c.status === "active" || c.status === "paused") ?? null, latest: list[0] ?? null };
  }

  const publicConnection = (c: ConnectionInfo | null) =>
    c && {
      connectionId: c.connectionId,
      status: c.status,
      online: c.online,
      provider: c.provider,
      tools: c.scopes.includes("agent.tools"),
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
    };

  const runSummary = (r: Run) => ({
    id: r.id,
    issueId: r.issueId,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    state: r.state,
    phase: r.phase,
    stopReason: r.stopReason,
    error: r.error,
    preview: r.preview,
    toolCalls: r.toolCalls,
  });

  const issueRuns = (username: string, issueId: string) =>
    [...userState(username).runs.values()].filter((r) => r.issueId === issueId).reverse();

  const publicIssue = (i: Issue) => ({
    id: i.id,
    title: i.title,
    description: i.description,
    steps: i.steps,
    expected: i.expected,
    actual: i.actual,
    stackTrace: i.stackTrace ?? null,
    labels: i.labels,
    status: i.status,
    statusLabel: STATUS_LABEL[i.status],
    reporter: i.reporter,
    assignee: i.assignee,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    comments: i.comments,
    version: i.version,
  });

  const issueSnapshot = (username: string, issue: Issue) => ({ issue: publicIssue(issue), runs: issueRuns(username, issue.id).map(runSummary) });

  function ownRun(username: string, id: string): Run {
    const r = userState(username).runs.get(id);
    if (!r) throw new HttpError(404, "not_found", "Run not found.");
    return r;
  }

  function notifyIssue(username: string, issueId: string) {
    for (const l of issueListeners.get(`${username}/${issueId}`) ?? []) l();
  }

  // ------------------------------------------------------------ MCP tool calls -> run timeline

  function onToolCall(grant: TokenGrant, call: McpToolCall) {
    const run = grant.runId ? users.get(grant.username)?.runs.get(grant.runId) : undefined;
    if (run && run.toolCalls.length < MAX_TOOL_LOG) run.toolCalls.push({ ...call, at: new Date().toISOString() });
    notifyIssue(grant.username, grant.issueId);
  }

  // ------------------------------------------------------------ collector

  /** Consume the relay stream for one run and keep its events in memory. */
  async function collect(r: Run) {
    const emit = (item: StreamItem | null) => {
      for (const l of r.listeners) l(item);
    };
    const setPhase = (p: RunPhase) => {
      if (r.phase === p) return;
      r.phase = p;
      notifyIssue(r.username, r.issueId);
    };
    try {
      for await (const item of bridge.streamEvents(r.id, { signal: r.abort.signal })) {
        if (!("seq" in item)) {
          emit(item); // relay notice (e.g. resume_unavailable): pass through, not stored
          continue;
        }
        const ev = item;
        if (ev.kind === "task.event" && (ev.payload.type === "text_delta" || ev.payload.type === "thought_delta")) {
          const bytes = Buffer.byteLength(ev.payload.text);
          if (r.storedTextBytes + bytes > MAX_STORED_TEXT_BYTES || r.events.length >= MAX_STORED_EVENTS) {
            r.truncated = true;
            continue; // keep memory bounded; the terminal event is still stored
          }
          r.storedTextBytes += bytes;
          if (ev.payload.type === "text_delta" && r.preview.length < 200) r.preview = (r.preview + ev.payload.text).slice(0, 200);
        }
        r.events.push(ev);
        r.eventTimes.push(Date.now());
        if (ev.kind === "task.accepted") setPhase("running");
        else if (ev.kind === "task.event") {
          const p = ev.payload;
          if (p.type === "status") {
            if (p.state === "awaiting_approval") setPhase("awaiting_approval");
            else if (p.state === "running") setPhase("running");
            else if (p.state === "cancelling") setPhase("cancelling");
          } else if (p.type === "permission_pending") setPhase("permission_pending");
          else if (p.type === "permission_resolved") setPhase("running");
        } else if (ev.kind === "task.completed") {
          r.stopReason = ev.payload.stopReason;
          r.state = ev.payload.stopReason === "cancelled" ? "cancelled" : "completed";
        } else if (ev.kind === "task.failed" || ev.kind === "task.rejected") {
          r.state = ev.kind === "task.failed" ? "failed" : "rejected";
          r.error = { code: ev.payload.code, message: ev.payload.message };
        }
        emit(ev);
      }
    } catch (e) {
      if (!r.abort.signal.aborted) {
        r.state = "failed";
        r.error = e instanceof RemoteAcpError ? { code: e.code, message: e.message } : { code: "internal", message: "Event stream failed" };
      }
    } finally {
      if (r.state === "running") {
        r.state = "failed";
        r.error ??= { code: "stream_interrupted", message: "Lost the event stream for this run" };
      }
      r.finishedAt = new Date().toISOString();
      r.phase = "finished";
      r.done = true;
      // The agent is done: its Bugboard token stops working shortly after.
      tokens.expireRun(r.id, tokenGraceMs);
      emit(null);
      r.listeners.clear();
      notifyIssue(r.username, r.issueId);
    }
  }

  function trimHistory(u: UserState, issueId: string) {
    const runs = [...u.runs.values()].filter((r) => r.issueId === issueId);
    let excess = runs.length - runHistoryLimit;
    for (const r of runs) {
      if (excess <= 0) break;
      if (r.done) {
        u.runs.delete(r.id);
        excess--;
      }
    }
  }

  // ------------------------------------------------------------ fix with my agent

  async function startFix(username: string, issueId: string, idemIn: unknown): Promise<{ run: Run; created: boolean }> {
    const user = userState(username);
    const project = tracker.project(username);
    const issue = tracker.issue(username, issueId);
    const { current, latest } = await connections(username);
    if (!current) {
      if (latest?.status === "revoked") throw new HttpError(409, "connection_revoked", "This connection was revoked. Connect your desktop agent again.");
      if (latest?.status === "expired") throw new HttpError(409, "connection_expired", "This connection expired. Connect your desktop agent again.");
      throw new HttpError(409, "not_connected", "Connect your desktop agent first.");
    }
    const prompt = buildFixPrompt(issue, project.name);
    const toolUrl = `${publicBase()}/mcp`;
    const idem = typeof idemIn === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(idemIn) ? idemIn : randomUUID();
    const idempotencyKey = `${username}:${issue.id}:${idem}`.slice(0, 128);
    // A retry with the same key must send the very same request (the relay
    // rejects a changed one with idempotency_conflict), so it reuses its token.
    const prior = user.fixRequests.get(idempotencyKey);
    const priorRun = prior?.runId ? user.runs.get(prior.runId) : undefined;
    if (priorRun) return { run: priorRun, created: false };
    const reuse = prior && tokens.verify(prior.token).ok;
    // One token per run, bound to (user, issue) now and to the task id below.
    const token = reuse ? prior.token : tokens.issue(username, issue.id).token;
    const request = { token, runId: null as string | null };
    user.fixRequests.set(idempotencyKey, request);
    while (user.fixRequests.size > 100) user.fixRequests.delete(user.fixRequests.keys().next().value!);
    let task;
    try {
      task = await bridge.startTask({
        connectionId: current.connectionId,
        externalUserId: externalUserIdFor(username),
        prompt,
        idempotencyKey,
        // The site's role for the agent: appended to the agent's system prompt.
        instructions: FIXER_INSTRUCTIONS,
        // Bugboard's own tools. Needs the "agent.tools" scope; the desktop
        // only allows tool URLs on this service's domain.
        tools: [{ name: TOOL_SERVER_NAME, url: toolUrl, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }],
      });
    } catch (e) {
      // Keep the token for a retry only if the request may have reached the relay.
      const maybeSent = e instanceof RemoteAcpError && ["network_error", "timeout", "aborted"].includes(e.code);
      if (!maybeSent) {
        tokens.revoke(token);
        user.fixRequests.delete(idempotencyKey);
      }
      throw e;
    }
    request.runId = task.taskId;
    const existing = user.runs.get(task.taskId);
    if (existing) return { run: existing, created: false };
    tokens.bind(token, task.taskId);
    if (cfg.exposeTokensForTests) console.log(JSON.stringify({ event: "mcp_token", runId: task.taskId, issueId: issue.id, username, token }));
    const run: Run = {
      id: task.taskId,
      issueId: issue.id,
      username,
      prompt,
      toolUrl,
      createdAt: task.createdAt,
      finishedAt: null,
      state: "running",
      phase: "starting",
      stopReason: null,
      error: null,
      toolCalls: [],
      events: [],
      eventTimes: [],
      storedTextBytes: 0,
      truncated: false,
      preview: "",
      done: false,
      listeners: new Set(),
      abort: new AbortController(),
    };
    user.runs.set(run.id, run);
    trimHistory(user, issue.id);
    void collect(run);
    notifyIssue(username, issue.id);
    return { run, created: true };
  }

  // ------------------------------------------------------------ routes

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
      return send(res, 200, { user: { username } }, { "set-cookie": `bugboard_sid=${sid}; ${cookieAttrs}; Max-Age=86400` });
    }
    if (path === "/api/logout" && method === "POST") {
      const s = sessionOf(req);
      if (s) sessions.delete(s.sid);
      return send(res, 200, { ok: true }, { "set-cookie": `bugboard_sid=; ${cookieAttrs}; Max-Age=0` });
    }

    const username = requireUser(req);
    const user = userState(username);

    // ---- desktop connection
    if (path === "/api/connection" && method === "GET") {
      const { current, latest } = await connections(username);
      return send(res, 200, { connection: publicConnection(current), latest: publicConnection(latest) });
    }
    if (path === "/api/connection/disconnect" && method === "POST") {
      const { current } = await connections(username);
      if (current) await bridge.revokeConnection(current.connectionId);
      return send(res, 200, { ok: true, revoked: current ? 1 : 0 });
    }
    if (path === "/api/pairings" && method === "POST") {
      const p = await bridge.createPairing({
        externalUserId: externalUserIdFor(username),
        // "agent.tools": the user is asked to let the agent use Bugboard's tools.
        scopes: ["task.interactive", "agent.tools"],
        expiresInSeconds: cfg.pairingTtlSeconds ?? 120,
      });
      user.pairingId = p.pairingId;
      return send(res, 200, { url: p.url, code: p.code, expiresAt: p.expiresAt });
    }
    if (path === "/api/pairings/current" && method === "GET") {
      if (!user.pairingId) return send(res, 200, { pairing: null, connection: null });
      const p = await bridge.getPairing(user.pairingId);
      const conn = p.status === "accepted" && p.connectionId ? await bridge.getConnection(p.connectionId) : null;
      return send(res, 200, { pairing: { status: p.status, expiresAt: p.expiresAt }, connection: publicConnection(conn) });
    }

    // ---- issues
    if (path === "/api/issues" && method === "GET") {
      const project = tracker.project(username);
      const list = [...project.issues.values()].map((i) => {
        const runs = issueRuns(username, i.id);
        const last = runs[0];
        return {
          id: i.id,
          title: i.title,
          status: i.status,
          statusLabel: STATUS_LABEL[i.status],
          labels: i.labels,
          reporter: i.reporter,
          assignee: i.assignee,
          updatedAt: i.updatedAt,
          commentCount: i.comments.filter((c) => c.authorKind !== "system").length,
          agentCommentCount: i.comments.filter((c) => c.authorKind === "agent").length,
          runCount: runs.length,
          activity: last ? { runId: last.id, state: last.state, phase: last.phase, error: last.error, at: last.finishedAt ?? last.createdAt } : null,
        };
      });
      return send(res, 200, { project: { key: project.key, name: project.name, description: project.description }, issues: list });
    }

    const im = /^\/api\/issues\/([^/]+)(\/comments|\/status|\/fix|\/stream)?$/.exec(path);
    if (im) {
      const issueId = im[1]!;
      if (!ISSUE_ID_RE.test(issueId)) throw new HttpError(404, "not_found", "Issue not found.");
      const issue = tracker.issue(username, issueId);
      if (!im[2] && method === "GET") return send(res, 200, issueSnapshot(username, issue));
      if (im[2] === "/stream" && method === "GET") return streamIssue(req, res, username, issue);
      if (im[2] === "/comments" && method === "POST") {
        const body = await readJson(req);
        const comment = tracker.addComment(username, issue.id, { author: username, authorKind: "human", body: body.body });
        return send(res, 201, comment);
      }
      if (im[2] === "/status" && method === "POST") {
        const body = await readJson(req);
        tracker.setStatus(username, issue.id, body.status, { author: username, authorKind: "human" });
        return send(res, 200, publicIssue(issue));
      }
      if (im[2] === "/fix" && method === "POST") {
        const body = await readJson(req);
        const { run, created } = await startFix(username, issue.id, body.idempotencyKey);
        return send(res, created ? 201 : 200, runSummary(run));
      }
    }

    // ---- runs
    const rm = /^\/api\/runs\/([^/]+)(\/cancel|\/events)?$/.exec(path);
    if (rm && RUN_ID_RE.test(rm[1]!)) {
      const run = ownRun(username, rm[1]!);
      if (!rm[2] && method === "GET") {
        return send(res, 200, { ...runSummary(run), prompt: run.prompt, instructions: FIXER_INSTRUCTIONS, toolServer: { name: TOOL_SERVER_NAME, url: run.toolUrl }, truncated: run.truncated });
      }
      if (rm[2] === "/cancel" && method === "POST") return send(res, 200, await bridge.cancelTask(run.id));
      if (rm[2] === "/events" && method === "GET") return streamRun(req, res, run);
    }
    throw new HttpError(404, "not_found", "No such endpoint.");
  }

  function sseHead(res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
  }

  /**
   * Live issue page: an `issue` snapshot (issue + runs) on connect and after
   * every change — new comments, status changes, run state, tool calls.
   */
  function streamIssue(_req: IncomingMessage, res: ServerResponse, username: string, issue: Issue) {
    sseHead(res);
    let n = 0;
    const write = () => res.write(`id: ${issue.version}.${++n}\nevent: issue\ndata: ${JSON.stringify(issueSnapshot(username, issue))}\n\n`);
    const key = `${username}/${issue.id}`;
    let set = issueListeners.get(key);
    if (!set) issueListeners.set(key, (set = new Set()));
    const listeners = set;
    // Coalesce bursts (e.g. comment + status in the same tick).
    let pending = false;
    const listener = () => {
      if (pending) return;
      pending = true;
      setImmediate(() => {
        pending = false;
        write();
      });
    };
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    res.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(listener);
      if (listeners.size === 0) issueListeners.delete(key);
    });
    listeners.add(listener);
    write();
  }

  /** Replay stored run events after Last-Event-ID, then follow live ones. */
  function streamRun(req: IncomingMessage, res: ServerResponse, r: Run) {
    const raw = req.headers["last-event-id"];
    const last = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 0;
    sseHead(res);
    const write = (item: StreamItem | null, at = Date.now()) => {
      if (item === null) {
        res.write(`event: end\ndata: ${JSON.stringify({ state: r.state, error: r.error })}\n\n`);
        cleanup();
        res.end();
      } else if ("seq" in item) {
        // `at`: when Bugboard received the event, so replays keep real times.
        if (item.seq > last) res.write(`id: ${item.seq}\nevent: ${item.kind}\ndata: ${JSON.stringify({ ...item, at: new Date(at).toISOString() })}\n\n`);
      } else {
        res.write(`event: notice\ndata: ${JSON.stringify(item.payload)}\n\n`);
      }
    };
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(keepAlive);
      r.listeners.delete(write);
    };
    res.on("close", cleanup);
    r.events.forEach((ev, i) => write(ev, r.eventTimes[i]));
    if (r.truncated) res.write(`event: notice\ndata: ${JSON.stringify({ code: "truncated", message: "Part of this run's output was too long to keep." })}\n\n`);
    if (r.done) write(null);
    else r.listeners.add(write);
  }

  // ------------------------------------------------------------ MCP endpoint

  async function mcp(req: IncomingMessage, res: ServerResponse) {
    const body = req.method === "POST" ? await readBody(req, MCP_MAX_BODY) : undefined;
    const out = handleMcp(
      { tokens, tracker, allowedOrigins: ownOrigins, onToolCall },
      { method: req.method ?? "GET", authorization: req.headers.authorization, origin: req.headers.origin, body },
    );
    res.writeHead(out.status, out.headers ?? {});
    res.end(out.body === undefined ? undefined : JSON.stringify(out.body));
  }

  async function serveStatic(res: ServerResponse, path: string) {
    let file: string;
    if (path === "/vendor/browser-helper.js") file = resolveBrowserHelper();
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

  server = createServer((req, res) => {
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    // /mcp is called by the user's desktop agent with a bearer token; it never
    // looks at cookies, so the cookie session / Origin checks don't apply.
    const handler =
      path === "/mcp"
        ? mcp(req, res)
        : path.startsWith("/api/")
          ? api(req, res, path)
          : req.method === "GET"
            ? serveStatic(res, path)
            : Promise.reject(new HttpError(405, "method", "Method not allowed"));
    handler.catch((e: unknown) => {
      if (res.headersSent) return res.end();
      sendError(res, e);
    });
  });
  server.on("close", () => {
    for (const u of users.values()) for (const r of u.runs.values()) r.abort.abort();
  });
  return server;
}

