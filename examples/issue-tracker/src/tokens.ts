/**
 * Short-lived bearer tokens for Bugboard's MCP endpoint.
 *
 * One token is minted per "Fix with my agent" run and handed to the user's
 * desktop agent in the task's `tools[].headers`. A token is bound to one
 * (user, issue, run) triple and is useless for anything else:
 * - it only reaches the issue it was issued for,
 * - it expires after `ttlMs` (default 30 minutes),
 * - it is revoked shortly after the run finishes.
 *
 * Only the SHA-256 of a token is stored, so a memory dump of this map does
 * not reveal usable tokens.
 */
import { createHash, randomBytes } from "node:crypto";

export interface TokenGrant {
  username: string;
  issueId: string;
  /** The relay task id, once the task was created (null while it is being created). */
  runId: string | null;
  issuedAt: number;
  expiresAt: number;
  /** Number of MCP requests made with this token. */
  uses: number;
}

export type VerifyResult = { ok: true; grant: TokenGrant } | { ok: false; reason: "missing" | "unknown" | "expired" };

export const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;
const TOKEN_RE = /^bb_[A-Za-z0-9_-]{43}$/;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class TokenStore {
  private readonly grants = new Map<string, TokenGrant>(); // sha256(token) -> grant

  constructor(
    private readonly now: () => number = Date.now,
    readonly ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ) {}

  /** Mint a token for one user's issue. Returns the raw token (never stored). */
  issue(username: string, issueId: string): { token: string; grant: TokenGrant } {
    this.sweep();
    const token = `bb_${randomBytes(32).toString("base64url")}`;
    const t = this.now();
    const grant: TokenGrant = { username, issueId, runId: null, issuedAt: t, expiresAt: t + this.ttlMs, uses: 0 };
    this.grants.set(hash(token), grant);
    return { token, grant };
  }

  /** Bind a freshly minted token to the relay task it was sent with. */
  bind(token: string, runId: string): void {
    const g = this.grants.get(hash(token));
    if (g && g.runId === null) g.runId = runId;
  }

  /** Look up the grant for an `Authorization` header value. */
  verifyHeader(header: string | undefined): VerifyResult {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
    if (!m) return { ok: false, reason: "missing" };
    return this.verify(m[1]!);
  }

  verify(token: string): VerifyResult {
    if (!TOKEN_RE.test(token)) return { ok: false, reason: "unknown" };
    const key = hash(token);
    const g = this.grants.get(key);
    if (!g) return { ok: false, reason: "unknown" };
    if (this.now() >= g.expiresAt) {
      this.grants.delete(key);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, grant: g };
  }

  /** Shorten the lifetime of every token of a run (e.g. when the run finished). */
  expireRun(runId: string, inMs = 0): void {
    const at = this.now() + inMs;
    for (const g of this.grants.values()) if (g.runId === runId && g.expiresAt > at) g.expiresAt = at;
  }

  /** Drop a token right away (e.g. the task could not be started). */
  revoke(token: string): void {
    this.grants.delete(hash(token));
  }

  get size(): number {
    return this.grants.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, g] of this.grants) if (t >= g.expiresAt) this.grants.delete(k);
  }
}
