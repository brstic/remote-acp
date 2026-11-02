/**
 * Hand-written TypeScript mirror of `crates/bridge-protocol` (protocol v1)
 * and of the relay REST/SSE contract in `apps/relay/src/http.rs`.
 *
 * The Rust crate is the source of truth. Keep this file in sync with it; the
 * contract fixtures in `tests/contract/*.json` are checked by this package's
 * tests against the runtime guards below.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_TEXT_DELTA_BYTES = 256 * 1024;
export const MAX_ID_LEN = 128;

export const SCOPES = ["task.interactive"] as const;
export type Scope = (typeof SCOPES)[number];

// ---------------------------------------------------------------------------
// Task state & events
// ---------------------------------------------------------------------------

/** Desktop-side task lifecycle (`bridge_protocol::TaskState`). */
export type TaskState =
  | "created"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "rejected"
  | "expired";

export const TASK_STATES: readonly TaskState[] = [
  "created",
  "awaiting_approval",
  "queued",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
  "rejected",
  "expired",
];

export interface PlanEntry {
  content: string;
  /** ACP plan status, e.g. `pending`, `in_progress`, `completed`. */
  status: string;
  priority?: string;
}

export type PermissionOutcome = "allowed" | "denied" | "cancelled";

/** Sanitized, website-facing task events (`bridge_protocol::TaskEvent`). */
export type TaskEvent =
  | { type: "status"; state: TaskState }
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "tool_call"; toolCallId: string; title: string; kind: string; status: string }
  | { type: "tool_call_update"; toolCallId: string; title?: string; status?: string }
  /** A local permission prompt is visible on the desktop. Websites can only observe it. */
  | { type: "permission_pending"; requestId: string; title: string }
  | { type: "permission_resolved"; requestId: string; outcome: PermissionOutcome };

export type TaskEventType = TaskEvent["type"];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface ErrorPayload {
  code: string;
  message: string;
}
export type Empty = Record<string, never>;
export interface Hello {
  appVersion: string;
  supportedVersions: number[];
}
export interface Ready {
  desktopId: string;
  negotiatedVersion: number;
  activeConnections: string[];
}
export interface Revoke {
  reason: string;
}
export interface ConnectionStatePayload {
  state: "active" | "paused";
}
export type InputBlock = { type: "text"; text: string };
export interface TaskStart {
  externalUserId: string;
  input: InputBlock[];
  mode: "interactive";
  serviceId: string;
}
export interface TaskCompleted {
  /** ACP stop reason (`end_turn`, `max_tokens`, `refusal`, `cancelled`, ...). */
  stopReason: string;
}

/** Map of allowlisted envelope kinds to payload types. */
export interface BodyMap {
  "connection.hello": Hello;
  "connection.ready": Ready;
  "connection.revoke": Revoke;
  "connection.state": ConnectionStatePayload;
  "task.start": TaskStart;
  "task.accepted": Empty;
  "task.rejected": ErrorPayload;
  "task.cancel": Empty;
  "task.event": TaskEvent;
  "task.completed": TaskCompleted;
  "task.failed": ErrorPayload;
  heartbeat: Empty;
  error: ErrorPayload;
}
export type EnvelopeKind = keyof BodyMap;

export const ENVELOPE_KINDS: readonly EnvelopeKind[] = [
  "connection.hello",
  "connection.ready",
  "connection.revoke",
  "connection.state",
  "task.start",
  "task.accepted",
  "task.rejected",
  "task.cancel",
  "task.event",
  "task.completed",
  "task.failed",
  "heartbeat",
  "error",
];

export const KINDS_FROM_DESKTOP: readonly EnvelopeKind[] = [
  "connection.hello",
  "connection.revoke",
  "connection.state",
  "task.accepted",
  "task.rejected",
  "task.event",
  "task.completed",
  "task.failed",
  "heartbeat",
  "error",
];

export const KINDS_FROM_RELAY: readonly EnvelopeKind[] = [
  "connection.ready",
  "connection.revoke",
  "task.start",
  "task.cancel",
  "heartbeat",
  "error",
];

const TASK_SCOPED: readonly EnvelopeKind[] = [
  "task.start",
  "task.accepted",
  "task.rejected",
  "task.cancel",
  "task.event",
  "task.completed",
  "task.failed",
];

interface EnvelopeHeader {
  version: typeof PROTOCOL_VERSION;
  id: string;
  connectionId?: string;
  taskId?: string;
  /** Per-task desktop sequence; 0 when not sequenced. */
  sequence: number;
  /** RFC 3339 timestamp. */
  createdAt: string;
}

export type Envelope<K extends EnvelopeKind = EnvelopeKind> = K extends EnvelopeKind
  ? EnvelopeHeader & { kind: K; payload: BodyMap[K] }
  : never;

export type Sender = "desktop" | "relay";

// ---------------------------------------------------------------------------
// Relay REST API
// ---------------------------------------------------------------------------

export interface RelayErrorBody {
  error: { code: string; message: string };
}

export interface CreatePairingRequest {
  externalUserId: string;
  scopes?: Scope[];
  expiresInSeconds?: number;
}
export interface CreatePairingResponse {
  pairingId: string;
  /** `remoteacp://pair?ticket=...&relay=...` deep link (single use). */
  url: string;
  /** Human-enterable code, `XXXXX-XXXXX`. */
  code: string;
  expiresAt: string;
}

export type PairingStatus = "pending" | "claimed" | "accepted" | "rejected" | "expired";
export interface PairingStatusResponse {
  pairingId: string;
  status: PairingStatus;
  connectionId: string | null;
  expiresAt: string;
}

export type ConnectionStatus = "active" | "paused" | "expired" | "revoked";
export interface ConnectionInfo {
  connectionId: string;
  externalUserId: string;
  status: ConnectionStatus;
  /** Whether the owning desktop currently holds a socket to the relay. */
  online: boolean;
  /** Provider label chosen on the desktop (e.g. "Codex"). */
  provider: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
}
export interface ListConnectionsResponse {
  connections: ConnectionInfo[];
}

export interface CreateTaskRequest {
  connectionId: string;
  externalUserId: string;
  prompt: string;
  idempotencyKey: string;
}

/** Relay-side task state (`RelayTaskState`). */
export type RelayTaskState = "pending" | "running" | "completed" | "cancelled" | "failed" | "rejected";
export const TERMINAL_RELAY_TASK_STATES: readonly RelayTaskState[] = ["completed", "cancelled", "failed", "rejected"];

export interface TaskSummary {
  taskId: string;
  connectionId: string;
  state: RelayTaskState;
  stopReason: string | null;
  error: ErrorPayload | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CancelTaskResponse {
  ok: true;
  alreadyFinished: boolean;
}

// ---------------------------------------------------------------------------
// SSE: GET /v1/tasks/{id}/events
// ---------------------------------------------------------------------------

export type TaskStreamKind = "task.accepted" | "task.event" | "task.completed" | "task.failed" | "task.rejected";
export const TERMINAL_STREAM_KINDS: readonly TaskStreamKind[] = ["task.completed", "task.failed", "task.rejected"];

interface StreamPayloads {
  "task.accepted": Empty;
  "task.event": TaskEvent;
  "task.completed": TaskCompleted;
  "task.failed": ErrorPayload;
  "task.rejected": ErrorPayload;
}

/** One relay SSE event: `id:` = seq, `event:` = kind, `data:` = this object as JSON. */
export type TaskStreamEvent<K extends TaskStreamKind = TaskStreamKind> = K extends TaskStreamKind
  ? { seq: number; kind: K; payload: StreamPayloads[K] }
  : never;

/** Out-of-band SSE `error` event (no id). */
export interface StreamErrorEvent {
  kind: "error";
  payload: { code: "resume_unavailable" | "lagged" | (string & {}); message: string };
}

export function isTerminalStreamEvent(e: { kind: string }): boolean {
  return (TERMINAL_STREAM_KINDS as readonly string[]).includes(e.kind);
}

// ---------------------------------------------------------------------------
// Runtime guards (mirror `Envelope::validate`)
// ---------------------------------------------------------------------------

export type ValidationResult = { ok: true; envelope: Envelope } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isOptStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const byteLen = (s: string): number => new TextEncoder().encode(s).length;

export function isValidId(s: unknown): s is string {
  return isStr(s) && s.length > 0 && s.length <= MAX_ID_LEN && /^[A-Za-z0-9_.:-]+$/.test(s);
}

export function isPlanEntry(v: unknown): v is PlanEntry {
  return isObj(v) && isStr(v.content) && isStr(v.status) && isOptStr(v.priority);
}

export function isTaskEvent(v: unknown): v is TaskEvent {
  if (!isObj(v) || !isStr(v.type)) return false;
  switch (v.type) {
    case "status":
      return isStr(v.state) && (TASK_STATES as readonly string[]).includes(v.state);
    case "text_delta":
    case "thought_delta":
      return isStr(v.text);
    case "plan":
      return Array.isArray(v.entries) && v.entries.every(isPlanEntry);
    case "tool_call":
      return isStr(v.toolCallId) && isStr(v.title) && isStr(v.kind) && isStr(v.status);
    case "tool_call_update":
      return isStr(v.toolCallId) && isOptStr(v.title) && isOptStr(v.status);
    case "permission_pending":
      return isStr(v.requestId) && isStr(v.title);
    case "permission_resolved":
      return isStr(v.requestId) && (v.outcome === "allowed" || v.outcome === "denied" || v.outcome === "cancelled");
    default:
      return false;
  }
}

const isErrorPayload = (v: unknown): v is ErrorPayload => isObj(v) && isStr(v.code) && isStr(v.message);

function payloadValid(kind: EnvelopeKind, p: unknown): string | null {
  switch (kind) {
    case "connection.hello":
      return isObj(p) && isStr(p.appVersion) && Array.isArray(p.supportedVersions) && p.supportedVersions.every(Number.isInteger)
        ? null
        : "payload";
    case "connection.ready":
      return isObj(p) && isStr(p.desktopId) && Number.isInteger(p.negotiatedVersion) && Array.isArray(p.activeConnections) && p.activeConnections.every(isStr)
        ? null
        : "payload";
    case "connection.revoke":
      return isObj(p) && isStr(p.reason) ? null : "payload";
    case "connection.state":
      return isObj(p) && (p.state === "active" || p.state === "paused") ? null : "payload";
    case "task.start": {
      if (!isObj(p) || !Array.isArray(p.input) || p.mode !== "interactive" || !isStr(p.externalUserId)) return "payload";
      if (p.input.length === 0) return "input";
      let total = 0;
      for (const b of p.input) {
        if (!isObj(b) || b.type !== "text" || !isStr(b.text)) return "input";
        total += byteLen(b.text);
      }
      if (total > MAX_PROMPT_BYTES) return "prompt too large";
      if (p.externalUserId.length === 0 || byteLen(p.externalUserId) > 256) return "externalUserId";
      if (!isValidId(p.serviceId)) return "serviceId";
      return null;
    }
    case "task.accepted":
    case "task.cancel":
    case "heartbeat":
      return isObj(p) ? null : "payload";
    case "task.event":
      if (!isTaskEvent(p)) return "payload";
      if ((p.type === "text_delta" || p.type === "thought_delta") && byteLen(p.text) > MAX_TEXT_DELTA_BYTES) return "text";
      return null;
    case "task.completed":
      return isObj(p) && isStr(p.stopReason) ? null : "payload";
    case "task.rejected":
    case "task.failed":
    case "error":
      if (!isErrorPayload(p)) return "payload";
      return p.code.length > MAX_ID_LEN || byteLen(p.message) > 4096 ? "error" : null;
  }
}

/**
 * Validate an inbound envelope from `sender`, mirroring the Rust
 * `Envelope::validate` rules: version, id formats, kind allowlist per sender,
 * task scoping and payload shape.
 */
export function validateEnvelope(value: unknown, sender: Sender): ValidationResult {
  if (!isObj(value)) return { ok: false, error: "not an object" };
  if (value.version !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version ${String(value.version)}` };
  if (!isValidId(value.id)) return { ok: false, error: "field `id` is invalid" };
  if (value.connectionId !== undefined && value.connectionId !== null && !isValidId(value.connectionId))
    return { ok: false, error: "field `connectionId` is invalid" };
  if (value.taskId !== undefined && value.taskId !== null && !isValidId(value.taskId))
    return { ok: false, error: "field `taskId` is invalid" };
  const seq = value.sequence ?? 0;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return { ok: false, error: "field `sequence` is invalid" };
  if (!isStr(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) return { ok: false, error: "field `createdAt` is invalid" };
  const kind = value.kind;
  if (!isStr(kind) || !(ENVELOPE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `unknown message kind \`${String(kind)}\`` };
  }
  const k = kind as EnvelopeKind;
  const allowed = sender === "desktop" ? KINDS_FROM_DESKTOP : KINDS_FROM_RELAY;
  if (!allowed.includes(k)) return { ok: false, error: `message kind \`${k}\` not permitted from this sender` };
  if (TASK_SCOPED.includes(k) && (!value.taskId || !value.connectionId)) return { ok: false, error: "field `taskId` is invalid" };
  if ((k === "connection.revoke" || k === "connection.state") && !value.connectionId)
    return { ok: false, error: "field `connectionId` is invalid" };
  const bad = payloadValid(k, value.payload);
  if (bad) return { ok: false, error: `field \`${bad}\` is invalid` };
  return { ok: true, envelope: { ...value, sequence: seq } as unknown as Envelope };
}

export function isEnvelope(value: unknown, sender: Sender): value is Envelope {
  return validateEnvelope(value, sender).ok;
}

/** Guard for the `data:` JSON of a relay task SSE event. */
export function isTaskStreamEvent(v: unknown): v is TaskStreamEvent {
  if (!isObj(v) || typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 1 || !isStr(v.kind)) return false;
  switch (v.kind) {
    case "task.accepted":
      return isObj(v.payload);
    case "task.event":
      return isTaskEvent(v.payload);
    case "task.completed":
      return isObj(v.payload) && isStr(v.payload.stopReason);
    case "task.failed":
    case "task.rejected":
      return isErrorPayload(v.payload);
    default:
      return false;
  }
}
