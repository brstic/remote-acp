// Process harness for the real end-to-end test. Starts the actual Rust relay
// binary and the headless e2e desktop (which runs the real bridge-core with
// the deterministic mock ACP agent). Nothing here is mocked.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const BIN = join(REPO, "target", "debug");
export const RELAY_BIN = join(BIN, "remote-acp-relay");
export const DESKTOP_BIN = join(BIN, "e2e-desktop");
export const MOCK_AGENT_BIN = join(BIN, "mock-acp-agent");

/** Dev secret documented in examples/web-demo/README.md. */
export const DEMO_SECRET = "dev-only-acme-notes-secret-0123456789abcdef";
export const DEMO_SECRET_SHA256 = "a46dd2a85259263aab5d4c3786af730252dcefede253ec54e1da238bf130980c";
export const OTHER_SECRET = "other-service-secret-for-e2e-only-0123456789";

const children = new Set<ChildProcess>();
const tmpDirs = new Set<string>();
process.on("exit", () => {
  for (const c of children) c.kill("SIGKILL");
});

export function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.add(d);
  return d;
}

function findCargo(): string | null {
  if (process.env.CARGO && existsSync(process.env.CARGO)) return process.env.CARGO;
  const which = spawnSync("sh", ["-c", "command -v cargo"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const home = join(homedir(), ".cargo", "bin", "cargo");
  return existsSync(home) ? home : null;
}

/** `cargo build -p remote-acp-relay -p e2e-tests` (incremental; a no-op when up to date). */
export function ensureBinaries(): void {
  const have = [RELAY_BIN, DESKTOP_BIN, MOCK_AGENT_BIN].every((p) => existsSync(p));
  const cargo = findCargo();
  if (!cargo) {
    if (have) return;
    throw new Error("Rust binaries are missing and cargo was not found. Run `source ~/.cargo/env && cargo build -p remote-acp-relay -p e2e-tests`.");
  }
  if (have && process.env.REMOTE_ACP_E2E_SKIP_CARGO === "1") return;
  const r = spawnSync(cargo, ["build", "-p", "remote-acp-relay", "-p", "e2e-tests"], {
    cwd: REPO,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PATH: `${dirname(cargo)}:${process.env.PATH ?? ""}` },
    timeout: 14 * 60_000,
  });
  if (r.status !== 0) throw new Error(`cargo build failed (status ${r.status})`);
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const t = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(t);
  children.delete(child);
}

export function cleanupTmp(): void {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.clear();
}

/** Line-oriented child process with JSON-line waiting. */
export class Proc {
  readonly lines: string[] = [];
  private waiters: { pred: (l: string) => boolean; resolve: (l: string) => void }[] = [];

  constructor(readonly child: ChildProcess, readonly name: string) {
    children.add(child);
    const onLine = (line: string) => {
      this.lines.push(line);
      if (process.env.E2E_VERBOSE) console.log(`[${name}] ${line}`);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(line)) {
          w.resolve(line);
          return false;
        }
        return true;
      });
    };
    if (child.stdout) createInterface({ input: child.stdout }).on("line", onLine);
    if (child.stderr) createInterface({ input: child.stderr }).on("line", (l) => onLine(`stderr: ${l}`));
  }

  /** Wait for a stdout JSON line matching `pred` (checks lines already seen after `fromIndex`). */
  waitJson<T = Record<string, unknown>>(pred: (v: Record<string, unknown>) => boolean, timeoutMs = 20_000, fromIndex = 0): Promise<T> {
    const test = (l: string) => {
      try {
        const v = JSON.parse(l) as unknown;
        return typeof v === "object" && v !== null && pred(v as Record<string, unknown>);
      } catch {
        return false;
      }
    };
    const seen = this.lines.slice(fromIndex).find(test);
    if (seen) return Promise.resolve(JSON.parse(seen) as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.name}: timed out waiting for line. Output so far:\n${this.lines.slice(-40).join("\n")}`));
      }, timeoutMs);
      const exit = () => reject(new Error(`${this.name} exited early. Output:\n${this.lines.slice(-40).join("\n")}`));
      this.child.once("exit", exit);
      this.waiters.push({
        pred: test,
        resolve: (l) => {
          clearTimeout(timer);
          this.child.off("exit", exit);
          resolve(JSON.parse(l) as T);
        },
      });
    });
  }

  write(s: string): void {
    this.child.stdin!.write(s);
  }
}

export interface RelayHandle {
  url: string;
  port: number;
  proc: Proc;
  dir: string;
}

export interface RelayServiceEntry {
  id: string;
  displayName: string;
  origin: string;
  secretSha256: string;
  verification: "operator" | "unverified" | "well_known";
}

/**
 * Start the real relay binary on a free port. `services` replaces the default
 * registry (svc_demo + svc_other) — the example apps register their own.
 */
export async function startRelay(opts: { services?: RelayServiceEntry[] } = {}): Promise<RelayHandle> {
  const dir = tmp("remoteacp-relay-");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const config = {
    listen: `127.0.0.1:${port}`,
    publicUrl: url,
    database: join(dir, "relay.sqlite3"),
    services: opts.services ?? [
      {
        id: "svc_demo",
        displayName: "Acme Notes (demo)",
        origin: "http://localhost:3000",
        secretSha256: DEMO_SECRET_SHA256,
        verification: "operator",
      },
      {
        id: "svc_other",
        displayName: "Other Service",
        origin: "http://localhost:4000",
        secretSha256: sha256(OTHER_SECRET),
        verification: "unverified",
      },
    ],
  };
  const cfgPath = join(dir, "relay.json");
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  const child = spawn(RELAY_BIN, ["--config", cfgPath], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" },
  });
  const proc = new Proc(child, "relay");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`relay exited: ${proc.lines.join("\n")}`);
    if (Date.now() > deadline) throw new Error(`relay did not start: ${proc.lines.join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, port, proc, dir };
}

/**
 * Start the headless test desktop. `permissionChoice` is what it answers to
 * every local permission prompt (`allow_once`, `allow_task` or `deny`).
 */
export async function startDesktop(
  relayUrl: string,
  opts: { permissionChoice?: "allow_once" | "allow_task" | "deny"; provider?: "mock" | "codex" | "claude"; workspace?: string } = {},
): Promise<{ proc: Proc; workspace: string }> {
  const workspace = opts.workspace ?? tmp("remoteacp-ws-");
  const child = spawn(DESKTOP_BIN, [], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      RELAY_URL: relayUrl,
      WORKSPACE: workspace,
      MOCK_AGENT: MOCK_AGENT_BIN,
      PERMISSION_CHOICE: opts.permissionChoice ?? "allow_once",
      PROVIDER: opts.provider ?? "mock",
      RUST_LOG: process.env.RUST_LOG ?? "warn",
    },
  });
  const proc = new Proc(child, "desktop");
  await proc.waitJson((v) => v.event === "ready", opts.provider && opts.provider !== "mock" ? 180_000 : 20_000);
  return { proc, workspace };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Transparent TCP proxy in front of the relay that can cut exactly one
 * in-flight SSE response after a number of body bytes — a real network drop
 * for testing automatic resume.
 */
export class DroppingProxy {
  port = 0;
  drops = 0;
  eventRequests = 0;
  private armedAfterBytes: number | null = null;
  private server = createServer((client) => this.handle(client));
  private sockets = new Set<Socket>();

  constructor(private readonly upstreamPort: number) {}

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Cut the next `/events` response once it has delivered `bytes` bytes. */
  dropNextEventStreamAfter(bytes: number): void {
    this.armedAfterBytes = bytes;
  }

  private handle(client: Socket) {
    const upstream = connect(this.upstreamPort, "127.0.0.1");
    this.sockets.add(client).add(upstream);
    let target: number | null = null;
    let seen = 0;
    client.on("data", (d) => {
      const s = d.toString("latin1");
      if (/^GET \/v1\/tasks\/[^ ]+\/events /m.test(s)) {
        this.eventRequests++;
        if (this.armedAfterBytes !== null) {
          target = this.armedAfterBytes;
          this.armedAfterBytes = null;
          seen = 0;
        }
      }
      upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (target !== null) {
        seen += d.length;
        if (seen >= target) {
          // Forward a partial chunk so the client sees a truncated event, then cut.
          client.write(d.subarray(0, Math.max(0, d.length - (seen - target))));
          target = null;
          this.drops++;
          client.destroy();
          upstream.destroy();
          return;
        }
      }
      client.write(d);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("close", close).on("error", close);
    upstream.on("close", close).on("error", close);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** Feed a pairing link to a headless desktop's stdin and wait until it reports `paired`. */
export async function pairDesktop(desktop: Proc, url: string, timeoutMs = 20_000): Promise<{ connectionId: string; service: string }> {
  const from = desktop.lines.length;
  desktop.write(`${url}\n`);
  const v = await desktop.waitJson((l) => l.event === "paired" || l.event === "error", timeoutMs, from);
  if (v.event !== "paired") throw new Error(`desktop pairing failed: ${JSON.stringify(v)}`);
  return v as unknown as { connectionId: string; service: string };
}

/**
 * Start a built Node server (`node <script>`) on a free port. The script must
 * print `{"event":"listening","port":N}` on stdout (all example apps do).
 */
export async function startNodeServer(script: string, env: Record<string, string>, name = "app"): Promise<{ proc: Proc; base: string }> {
  if (!existsSync(script)) throw new Error(`${script} is missing — build the package first (pnpm -r --filter '!remote-acp-desktop' build)`);
  const child = spawn(process.execPath, [script], {
    cwd: dirname(script),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...env },
  });
  const proc = new Proc(child, name);
  const { port } = await proc.waitJson<{ port: number }>((v) => v.event === "listening", 20_000);
  return { proc, base: `http://127.0.0.1:${port}` };
}
