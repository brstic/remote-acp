// Drives the REAL desktop app UI through tauri-driver (W3C WebDriver) while
// acting as a website backend against a real relay. Runs in CI on Linux
// (WebKitWebDriver under Xvfb) and Windows (msedgedriver).
//
//   node tests/desktop-webdriver/run.mjs <path-to-app-binary> <path-to-relay-binary>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [APP, RELAY_BIN] = process.argv.slice(2);
const DRIVER = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const SECRET = "webdriver-secret-0123456789abcdef";
const SVC = "svc_wd";
const AUTH = { authorization: `Bearer ${SVC}.${SECRET}`, "content-type": "application/json" };
const RELAY = "http://127.0.0.1:8798";
const ELEMENT = "element-6066-11e4-a52f-4f736e8e1e9e";
const step = (m) => console.log(`\n▶ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- relay
const work = mkdtempSync(join(tmpdir(), "rab-wd-"));
const workspace = mkdtempSync(join(tmpdir(), "rab-wd-ws-"));
writeFileSync(join(work, "relay.json"), JSON.stringify({
  listen: "127.0.0.1:8798", publicUrl: RELAY, database: join(work, "relay.sqlite3").replaceAll("\\", "/"),
  services: [{ id: SVC, displayName: "WebDriver Test Site", origin: "http://localhost:3000", secretSha256: createHash("sha256").update(SECRET).digest("hex"), verification: "operator" }],
}));
const relay = spawn(RELAY_BIN, ["--config", join(work, "relay.json")], { stdio: ["ignore", "pipe", "pipe"] });
let relayLog = "";
relay.stdout.on("data", (d) => (relayLog += d));
relay.stderr.on("data", (d) => (relayLog += d));
async function api(method, path, body) {
  const r = await fetch(RELAY + path, { method, headers: AUTH, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function events(taskId) {
  const r = await fetch(`${RELAY}/v1/tasks/${taskId}/events`, { headers: AUTH });
  const text = await r.text();
  return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
}
const textOf = (evs) => evs.filter((e) => e.payload?.type === "text_delta").map((e) => e.payload.text).join("");

// ---------------------------------------------------------------- webdriver
let sid;
async function wd(method, path, body) {
  const r = await fetch(`${DRIVER}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
}
async function find(xpath, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await wd("POST", `/session/${sid}/element`, { using: "xpath", value: xpath });
      // W3C key, legacy JSONWP key, or whatever single key the driver used.
      const id = v?.[ELEMENT] ?? v?.ELEMENT ?? (v && Object.values(v)[0]);
      if (!id) throw new Error(`no element id in ${JSON.stringify(v)}`);
      return id;
    } catch (e) {
      last = e;
      await sleep(250);
    }
  }
  throw new Error(`element not found: ${xpath} (${last?.message})`);
}
const click = async (xpath) => wd("POST", `/session/${sid}/element/${await find(xpath)}/click`, {});
const type = async (xpath, text) => wd("POST", `/session/${sid}/element/${await find(xpath)}/value`, { text });
const button = (label) => `//button[contains(normalize-space(.), "${label}")]`;
async function waitText(text, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const src = await wd("GET", `/session/${sid}/source`);
    if (src.includes(text)) return;
    await sleep(300);
  }
  throw new Error(`text not shown: ${text}`);
}
async function attr(xpath, name) {
  // DOM property (live state), not the HTML attribute.
  return wd("GET", `/session/${sid}/element/${await find(xpath)}/property/${name}`);
}

let failed = false;
let app;
try {
  for (let i = 0; i < 50; i++) {
    if ((await fetch(`${RELAY}/healthz`).catch(() => null))?.ok) break;
    await sleep(200);
  }
  if (!existsSync(APP)) throw new Error(`app binary missing: ${APP}`);
  if (process.env.ATTACH_WEBVIEW2) {
    // Windows: start the app ourselves with WebView2 remote debugging and attach
    // msedgedriver to it (more reliable than letting the driver launch it).
    step("launch the desktop app (WebView2 debugging) and attach msedgedriver");
    app = spawn(APP, [], { stdio: "ignore", env: { ...process.env, REMOTE_ACP_WEBDRIVER_PORT: "9222" } });
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) {
      ok = !!(await fetch("http://127.0.0.1:9222/json/version").catch(() => null))?.ok;
      if (!ok) await sleep(500);
    }
    if (!ok) throw new Error("WebView2 debugging port never opened");
    const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "MicrosoftEdge", "ms:edgeOptions": { debuggerAddress: "127.0.0.1:9222" } } } });
    sid = session.sessionId;
  } else {
    step("launch the desktop app through tauri-driver");
    const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: APP } } } });
    sid = session.sessionId;
  }

  step("onboarding screen → Continue");
  await waitText("Connect your AI agent to websites securely.");
  await click(button("Continue"));
  await waitText("Bridge is on", 40000);

  step("website creates a pairing; user enters the code in Connect a website");
  const pairing = await api("POST", "/v1/pairings", { externalUserId: "wd-user", expiresInSeconds: 300 });
  await click(button("Connect a website"));
  await type('//*[@id="pair-input"]', pairing.body.code);
  await click('//div[@role="dialog"]' + button("Continue"));

  step("consent sheet: verified identity, choose folder, Allow connection");
  await waitText("WebDriver Test Site wants to connect");
  await waitText("Verified domain");
  await type('//*[@id="ws"]', workspace);
  await click(button("Allow connection"));
  await waitText("WebDriver Test Site connected");
  const p = await api("GET", `/v1/pairings/${pairing.body.pairingId}`);
  if (p.body.status !== "accepted") throw new Error(`pairing not accepted: ${JSON.stringify(p.body)}`);
  const connectionId = p.body.connectionId;
  for (let i = 0; i < 40; i++) {
    if ((await api("GET", `/v1/connections/${connectionId}`)).body.online) break;
    await sleep(250);
  }

  step("website starts a task; user clicks Allow task, then Allow once on the permission prompt");
  const task = await api("POST", "/v1/tasks", { connectionId, externalUserId: "wd-user", prompt: "permission please", idempotencyKey: `wd-${Date.now()}` });
  if (task.status !== 201) throw new Error(`startTask ${task.status} ${JSON.stringify(task.body)}`);
  const evPromise = events(task.body.taskId);
  await waitText("wants to start a task");
  await click(button("Allow task"));
  await waitText("Permission needed");
  await click(button("Allow once"));
  const ev = await evPromise;
  const fin = ev.find((e) => ["task.completed", "task.failed", "task.rejected"].includes(e.kind));
  console.log("  website saw:", JSON.stringify(textOf(ev)), fin?.kind);
  if (!textOf(ev).includes("PERMISSION_GRANTED") || fin?.kind !== "task.completed") throw new Error("permission flow failed");
  if (!existsSync(join(workspace, "mock-output.txt"))) throw new Error("file was not written after approval");

  step("Activity shows the transcript");
  await click('//nav//button[contains(., "Activity")]');
  await waitText("PERMISSION_GRANTED file written.");
  await waitText("Permission: Write mock-output.txt");

  step("local task from the Activity composer");
  await type('//input[@aria-label="Project folder"]', workspace);
  await type("//textarea", "hello from webdriver");
  await click('//button[@aria-label="Send"]');
  await waitText("You said: hello from webdriver", 30000);

  step("Settings: toggle notifications and theme");
  await click('//nav//button[contains(., "Settings")]');
  const before = await attr('//input[@aria-label="Notifications"]', "checked");
  await click('//input[@aria-label="Notifications"]');
  await sleep(600);
  const after = await attr('//input[@aria-label="Notifications"]', "checked");
  if (String(before) === String(after)) throw new Error("notifications toggle did not change");
  await click(button("Light"));
  await sleep(300);
  if ((await wd("GET", `/session/${sid}/source`)).includes('data-theme="light"') === false) throw new Error("theme not applied");

  step("Diagnostics opens and shows the relay and audit log");
  await click(button("Open"));
  await waitText("Audit log");
  await waitText("connection_granted");

  step("Connected Websites → Disconnect → Confirm; relay reports revoked");
  await click('//nav//button[contains(., "Connected Websites")]');
  await click(button("Disconnect"));
  await click(button("Confirm disconnect"));
  await waitText("Website disconnected");
  const c = await api("GET", `/v1/connections/${connectionId}`);
  if (c.body.status !== "revoked") throw new Error(`connection not revoked: ${JSON.stringify(c.body)}`);
  const again = await api("POST", "/v1/tasks", { connectionId, externalUserId: "wd-user", prompt: "hi", idempotencyKey: `wd2-${Date.now()}` });
  if (again.body?.error?.code !== "connection_revoked") throw new Error("revoked connection still accepted tasks");

  console.log("\nDESKTOP UI E2E OK: every step passed through the real app UI");
} catch (e) {
  failed = true;
  console.error("\nDESKTOP UI E2E FAILED:", e.message);
  try {
    const src = await wd("GET", `/session/${sid}/source`);
    console.error("--- page text:", src.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000));
  } catch {}
  console.error("--- relay log:", relayLog.slice(-1500));
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  relay.kill();
  if (app) app.kill();
  process.exit(failed ? 1 : 0);
}
