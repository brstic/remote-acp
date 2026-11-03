// EXAMPLE — browser side of the minimal integration. Zero build, no secrets:
// this page only talks to our own server (/api/*), never to the relay.
import { renderPairing } from "/vendor/browser-helper.js";

const $ = (id) => document.getElementById(id);

// Relay error codes -> human text. Unknown codes fall back to the server's message.
const FRIENDLY = {
  desktop_offline: "Your desktop app is offline. Open Remote ACP Bridge on your computer and try again.",
  connection_revoked: "This connection was revoked. Click Connect again.",
  connection_paused: "You paused this connection in the desktop app. Resume it there.",
  task_in_progress: "Another task is still running on your desktop.",
  declined: "You declined the task in the desktop app.",
  not_connected: "Connect your desktop agent first.",
};
const explain = (err) => FRIENDLY[err?.code] ?? err?.message ?? "Something went wrong.";

async function call(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data.error ?? { message: res.statusText };
  return data;
}

// ---- Step 1: Connect -> show link/code -> wait for approval on the desktop.
async function connect() {
  $("connect").disabled = true;
  $("conn-status").textContent = "Open the link (or enter the code) in Remote ACP Bridge, then approve…";
  try {
    const pairing = await call("/api/connect", "POST"); // { url, code, expiresAt }
    const widget = renderPairing($("pairing"), pairing, { labels: { button: "Open Remote ACP Bridge" } });
    const { status } = await call("/api/connect/wait"); // resolves when accepted / rejected / expired
    widget.destroy();
    if (status === "accepted") return showConnected();
    $("conn-status").textContent = status === "rejected" ? "You declined the connection." : "The link expired. Try again.";
  } catch (e) {
    $("conn-status").textContent = explain(e);
  }
  $("connect").disabled = false;
}

async function showConnected() {
  const s = await call("/api/status");
  if (!s.connected) return;
  $("conn-status").textContent = `Connected to ${s.provider || "your agent"} · desktop ${s.online ? "online" : "offline"}.`;
  $("connect").hidden = true;
  $("ask-step").hidden = false;
}

// ---- Step 2: Ask -> stream the answer -> optional Cancel.
async function ask(event) {
  event.preventDefault();
  const answer = $("answer");
  answer.textContent = "";
  setBusy(true, "Sent. Approve the task in the desktop app if it asks…");
  let taskId;
  try {
    ({ taskId } = await call("/api/ask", "POST", { prompt: $("prompt").value }));
  } catch (e) {
    if (e.code === "connection_revoked" || e.code === "connection_expired") $("connect").hidden = false; // offer to reconnect
    return setBusy(false, explain(e));
  }
  $("cancel").onclick = () => call(`/api/tasks/${taskId}/cancel`, "POST").catch(() => {});

  // EventSource reconnects by itself and sends Last-Event-ID; the server resumes.
  const es = new EventSource(`/api/tasks/${taskId}/events`);
  const payload = (ev) => JSON.parse(ev.data).payload;
  es.addEventListener("task.accepted", () => setBusy(true, "Running on your computer…"));
  es.addEventListener("task.event", (ev) => {
    const p = payload(ev);
    // textContent only: agent output is untrusted and never parsed as HTML.
    if (p.type === "text_delta") answer.textContent += p.text;
    if (p.type === "permission_pending") setBusy(true, `Waiting for your approval in Remote ACP Bridge: ${p.title}`);
    if (p.type === "permission_resolved") setBusy(true, `Permission ${p.outcome}. Running…`);
  });
  es.addEventListener("task.completed", (ev) => setBusy(false, payload(ev).stopReason === "cancelled" ? "Cancelled." : "Done."));
  es.addEventListener("task.failed", (ev) => setBusy(false, `Failed: ${explain(payload(ev))}`));
  es.addEventListener("task.rejected", (ev) => setBusy(false, explain(payload(ev))));
  es.addEventListener("end", (ev) => {
    es.close();
    const err = JSON.parse(ev.data).error;
    if (err) setBusy(false, explain(err));
  });
}

function setBusy(busy, status) {
  $("ask").disabled = busy;
  $("cancel").hidden = !busy;
  $("task-status").textContent = status;
}

$("connect").addEventListener("click", connect);
$("ask-form").addEventListener("submit", ask);
showConnected().catch(() => {}); // already connected (e.g. after a reload)?
