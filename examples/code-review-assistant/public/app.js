// Code Review Assistant (EXAMPLE) — browser UI. Talks only to this server's
// /api/*; the server holds the relay credentials and builds the prompts.
import { renderPairing } from "/vendor/browser-helper.js";
import { renderMarkdown } from "/render.js";

const $ = (sel) => document.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};
const setChildren = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

// ------------------------------------------------------------------ errors

const FRIENDLY = {
  desktop_offline: "Your desktop app isn't connected right now. Open Remote ACP Bridge on your computer and try again.",
  connection_revoked: "This connection was revoked. Connect your desktop agent again.",
  connection_paused: "You paused this connection in the desktop app. Resume it there to run reviews.",
  connection_expired: "This connection expired. Connect your desktop agent again.",
  task_in_progress: "A review is already running on your desktop. Wait for it or cancel it.",
  not_connected: "Connect your desktop agent first.",
  declined: "You declined this review in the desktop app.",
  approval_timeout: "Nobody approved the review on the desktop in time.",
  policy_blocked: "Your desktop's safety checks stopped this review (it tried to reach outside the project folder or output something that looks like a credential).",
  task_timeout: "The review ran too long and was stopped.",
  bridge_paused: "Remote ACP Bridge is paused on your desktop. Resume it there.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  invalid_type: "Pick a review type.",
  signed_out: "Your session ended. Sign in again.",
  relay_auth_failed: "This server can't authenticate to the relay (check REMOTE_ACP_SERVICE_SECRET).",
  network_error: "This server can't reach the relay.",
  stream_interrupted: "Lost the live connection to the review.",
};
const friendly = (err) => (err && FRIENDLY[err.code]) || (err && err.message) || "Something went wrong.";

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw { code: "offline", message: "Can't reach the Code Review Assistant server." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || { code: `http_${res.status}`, message: res.statusText };
    if (err.code === "signed_out") showSignin();
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ state

const state = {
  user: null,
  connection: null,
  latest: null,
  pairing: null,
  pairingWidget: null,
  pairPoll: null,
  connPoll: null,
  types: [],
  selectedType: "security",
  reviews: [],
  current: null, // the report on screen (see openReview)
};

// ------------------------------------------------------------------ auth

function showSignin() {
  state.user = null;
  stopPairing();
  clearInterval(state.connPoll);
  $("#signin").hidden = false;
  $("#app").hidden = true;
  $("#userbox").hidden = true;
}

async function login(username) {
  $("#login-error").hidden = true;
  try {
    const r = await api("/api/login", { method: "POST", body: { username } });
    await enterApp(r.user);
  } catch (e) {
    $("#login-error").textContent = friendly(e);
    $("#login-error").hidden = false;
  }
}

async function enterApp(user) {
  state.user = user;
  $("#signin").hidden = true;
  $("#app").hidden = false;
  $("#userbox").hidden = false;
  $("#username").textContent = user.username;
  $("#avatar").textContent = user.username.slice(0, 1);
  await Promise.all([loadTypes(), refreshConnection(), refreshHistory()]);
}

// ------------------------------------------------------------------ connection

function stopPairing() {
  clearInterval(state.pairPoll);
  state.pairPoll = null;
  state.pairingWidget?.destroy();
  state.pairingWidget = null;
  state.pairing = null;
}

async function refreshConnection() {
  try {
    const r = await api("/api/connection");
    state.connection = r.connection;
    state.latest = r.latest;
  } catch (e) {
    setChildren($("#conn-body"), h("div", { class: "notice notice-err" }, friendly(e)), h("button", { class: "btn btn-secondary btn-block", type: "button", onclick: refreshConnection }, "Retry"));
    return;
  }
  if (!state.pairing) renderConnection();
  updateRunButton();
  clearInterval(state.connPoll);
  if (state.connection) state.connPoll = setInterval(pollConnection, 8000);
}

async function pollConnection() {
  try {
    const r = await api("/api/connection");
    if (JSON.stringify(r.connection) === JSON.stringify(state.connection)) return;
    state.connection = r.connection;
    state.latest = r.latest;
    renderConnection();
    updateRunButton();
  } catch {
    /* transient */
  }
}

function renderConnection() {
  const c = state.connection;
  if (c) {
    const paused = c.status === "paused";
    const dot = paused ? "dot-warn" : c.online ? "dot-ok" : "dot-err";
    setChildren(
      $("#conn-body"),
      h("div", { class: "conn-state" }, h("span", { class: `dot ${dot}` }), paused ? "Paused on your desktop" : c.online ? "Connected · online" : "Connected · desktop offline"),
      h("p", { class: "muted small" }, `Agent: ${c.provider || "unknown"}`),
      paused ? h("div", { class: "notice notice-warn" }, FRIENDLY.connection_paused) : null,
      !c.online && !paused ? h("div", { class: "notice notice-warn" }, "Open Remote ACP Bridge on your computer to run reviews.") : null,
      h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: disconnect }, "Disconnect"),
    );
    return;
  }
  const prev = state.latest;
  setChildren(
    $("#conn-body"),
    h("div", { class: "conn-state" }, h("span", { class: "dot" }), "Not connected"),
    prev?.status === "revoked" ? h("div", { class: "notice notice-warn" }, "Your previous connection was revoked.") : null,
    h("p", { class: "muted small" }, "Connect the Remote ACP Bridge app on this computer, then choose your project folder and Read only access."),
    h("button", { class: "btn btn-primary btn-block", type: "button", id: "connect", onclick: startPairing }, "Connect desktop agent"),
  );
}

async function startPairing() {
  stopPairing();
  try {
    const p = await api("/api/pairings", { method: "POST" });
    state.pairing = { ...p, status: "pending" };
    const line = h("div", { class: "conn-state" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { id: "pair-text" }, "Open the link in Remote ACP Bridge…"));
    const holder = h("div");
    setChildren($("#conn-body"), line, holder, h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => (stopPairing(), renderConnection()) }, "Cancel"));
    state.pairingWidget = renderPairing(holder, p, {
      labels: { button: "Open Remote ACP Bridge", codeHint: "Or enter this one-time code in the desktop app" },
      onExpire: pollPairing,
    });
    state.pairPoll = setInterval(pollPairing, 1500);
  } catch (e) {
    setChildren($("#conn-body"), h("div", { class: "notice notice-err" }, friendly(e)), h("button", { class: "btn btn-secondary btn-block", type: "button", onclick: startPairing }, "Try again"));
  }
}

async function pollPairing() {
  if (!state.pairing) return;
  let r;
  try {
    r = await api("/api/pairings/current");
  } catch {
    return;
  }
  if (!r.pairing || !state.pairing) return;
  const status = r.pairing.status;
  if (status === "claimed") $("#pair-text").textContent = "Confirm the connection in the desktop app…";
  if (status === "pending" || status === "claimed") return;
  stopPairing();
  if (status === "accepted") return refreshConnection();
  setChildren(
    $("#conn-body"),
    h("div", { class: "notice notice-warn" }, status === "rejected" ? "You declined the connection in the desktop app." : "The link expired before it was approved."),
    h("button", { class: "btn btn-primary btn-block", type: "button", onclick: startPairing }, "Get a new link"),
  );
}

async function disconnect() {
  if (!confirm("Disconnect your desktop agent from Code Review Assistant?")) return;
  try {
    await api("/api/connection/disconnect", { method: "POST" });
  } catch (e) {
    alert(friendly(e));
  }
  await refreshConnection();
}

// ------------------------------------------------------------------ review types

async function loadTypes() {
  const { types } = await api("/api/review-types");
  state.types = types;
  setChildren(
    $("#types"),
    h("legend", { class: "sr-only" }, "Review type"),
    types.map((t) =>
      h(
        "label",
        { class: "type" },
        h("input", { type: "radio", name: "type", value: t.id, checked: t.id === state.selectedType, onchange: () => (state.selectedType = t.id) }),
        h("span", { class: "type-body" }, h("span", { class: "type-title" }, t.title), h("span", { class: "type-desc" }, t.description)),
      ),
    ),
  );
}

function running() {
  return state.reviews.some((r) => r.state === "running");
}

function updateRunButton() {
  const c = state.connection;
  const ok = !!c && c.status === "active" && !running();
  $("#run").disabled = !ok;
  $("#run").textContent = running() ? "A review is running…" : "Run review on my computer";
}

// ------------------------------------------------------------------ history

async function refreshHistory() {
  try {
    state.reviews = (await api("/api/reviews")).reviews;
  } catch {
    return;
  }
  $("#history-empty").hidden = state.reviews.length > 0;
  setChildren(
    $("#history"),
    state.reviews.map((r) =>
      h(
        "li",
        {},
        h(
          "button",
          { type: "button", class: `history-item${state.current?.id === r.id ? " active" : ""}`, onclick: () => openReview(r.id) },
          h("span", { class: "history-title" }, r.title),
          h("span", { class: `pill pill-${r.state}` }, STATE_LABEL[r.state] || r.state),
          h("span", { class: "history-meta" }, new Date(r.createdAt).toLocaleTimeString(), r.focus ? ` · ${r.focus.slice(0, 60)}` : ""),
        ),
      ),
    ),
  );
  updateRunButton();
}

// ------------------------------------------------------------------ run + report

async function runReview(e) {
  e.preventDefault();
  $("#run-error").hidden = true;
  $("#run").disabled = true;
  try {
    const r = await api("/api/reviews", {
      method: "POST",
      body: { type: state.selectedType, focus: $("#focus").value, idempotencyKey: crypto.randomUUID() },
    });
    await refreshHistory();
    openReview(r.id);
  } catch (err) {
    $("#run-error").textContent = friendly(err);
    $("#run-error").hidden = false;
    if (["connection_revoked", "connection_expired", "connection_paused", "not_connected", "desktop_offline"].includes(err.code)) refreshConnection();
    updateRunButton();
  }
}

const STATE_LABEL = { running: "Running", completed: "Completed", cancelled: "Cancelled", failed: "Failed", rejected: "Declined" };

async function openReview(id) {
  state.current?.es?.close();
  const meta = await api(`/api/reviews/${encodeURIComponent(id)}`).catch(() => null);
  if (!meta) return;
  const cur = { id, meta, text: "", plan: [], tools: new Map(), timeline: [], status: "Sent to your desktop…", tone: "run", done: false, es: null, raf: 0 };
  state.current = cur;
  $("#report-empty").hidden = true;
  $("#report-view").hidden = false;
  $("#report-title").textContent = meta.title;
  $("#report-meta").textContent = `${new Date(meta.createdAt).toLocaleString()}${meta.focus ? ` · Focus: ${meta.focus}` : ""}`;
  $("#prompt-text").textContent = meta.prompt;
  $("#report-notice").hidden = true;
  $("#cancel").hidden = meta.state !== "running";
  $("#cancel").disabled = false;
  addTimeline(cur, "Review sent to your desktop agent");
  renderReport(cur);
  refreshHistory();

  // Server replays everything it kept, then follows live; EventSource resumes with Last-Event-ID.
  const es = new EventSource(`/api/reviews/${encodeURIComponent(id)}/events`);
  cur.es = es;
  const data = (ev) => JSON.parse(ev.data);
  const mine = () => state.current === cur;

  es.addEventListener("task.accepted", () => {
    setStatus(cur, "Running on your computer…", "run");
    addTimeline(cur, "Approved on your desktop; agent started");
  });
  es.addEventListener("task.event", (ev) => {
    if (!mine()) return;
    const p = data(ev).payload;
    switch (p.type) {
      case "status":
        if (p.state === "awaiting_approval") {
          setStatus(cur, "Waiting for your approval in Remote ACP Bridge", "wait");
          addTimeline(cur, "Waiting for you to approve the review on your desktop");
        } else if (p.state === "cancelling") setStatus(cur, "Cancelling…", "wait");
        break;
      case "text_delta":
        cur.text += p.text;
        break;
      case "plan":
        cur.plan = p.entries;
        break;
      case "tool_call": {
        const item = { kind: "tool", title: p.title, status: p.status, toolKind: p.kind, at: new Date() };
        cur.tools.set(p.toolCallId, item);
        cur.timeline.push(item);
        break;
      }
      case "tool_call_update": {
        const item = cur.tools.get(p.toolCallId);
        if (item) {
          if (p.title) item.title = p.title;
          if (p.status) item.status = p.status;
        }
        break;
      }
      case "permission_pending":
        setStatus(cur, "Waiting for your approval in Remote ACP Bridge", "wait");
        addTimeline(cur, `Permission requested on your desktop: ${p.title}`);
        break;
      case "permission_resolved":
        setStatus(cur, "Running on your computer…", "run");
        addTimeline(cur, `Permission ${p.outcome} on your desktop`);
        break;
    }
    scheduleRender(cur);
  });
  es.addEventListener("task.completed", (ev) => {
    const reason = data(ev).payload.stopReason;
    finish(cur, reason === "cancelled" ? "Cancelled" : "Completed", reason === "cancelled" ? "muted" : "ok", reason === "cancelled" ? "Review cancelled" : `Finished (${reason})`);
  });
  for (const kind of ["task.failed", "task.rejected"]) {
    es.addEventListener(kind, (ev) => {
      const p = data(ev).payload;
      finish(cur, kind === "task.rejected" ? "Declined" : "Failed", "err", friendly(p));
      showNotice(cur, friendly(p), "err");
    });
  }
  es.addEventListener("notice", (ev) => {
    const p = data(ev);
    if (p.code === "truncated" || p.code === "resume_unavailable") showNotice(cur, "Part of this report is no longer available.", "warn");
  });
  es.addEventListener("end", (ev) => {
    es.close();
    const p = data(ev);
    if (!cur.done) {
      // The server's collector ended without a terminal relay event (e.g. stream lost).
      finish(cur, STATE_LABEL[p.state] || "Finished", p.state === "failed" ? "err" : "muted", p.error ? friendly(p.error) : "Stream ended");
      if (p.error) showNotice(cur, friendly(p.error), "err");
    }
    refreshHistory();
  });
}

function finish(cur, label, tone, timelineText) {
  if (cur.done) return;
  cur.done = true;
  setStatus(cur, label, tone);
  addTimeline(cur, timelineText);
  if (state.current === cur) $("#cancel").hidden = true;
  scheduleRender(cur);
  refreshHistory();
}

function setStatus(cur, text, tone) {
  cur.status = text;
  cur.tone = tone;
  scheduleRender(cur);
}

function addTimeline(cur, text) {
  cur.timeline.push({ kind: "note", title: text, at: new Date() });
  scheduleRender(cur);
}

function showNotice(cur, text, tone) {
  if (state.current !== cur) return;
  const n = $("#report-notice");
  n.className = `notice notice-${tone}`;
  n.textContent = text;
  n.hidden = false;
}

function scheduleRender(cur) {
  if (cur.raf) return;
  cur.raf = requestAnimationFrame(() => {
    cur.raf = 0;
    if (state.current === cur) renderReport(cur);
  });
}

function renderReport(cur) {
  const status = $("#report-status");
  status.className = `status status-${cur.tone}`;
  setChildren(status, cur.tone === "run" || cur.tone === "wait" ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, cur.status);

  const body = $("#report-body");
  if (cur.text) body.replaceChildren(renderMarkdown(cur.text));
  else body.replaceChildren(h("p", { class: "muted" }, cur.done ? "The agent returned no text." : "The report will stream in here…"));

  $("#plan-empty").hidden = cur.plan.length > 0;
  setChildren(
    $("#plan"),
    cur.plan.map((e) => h("li", { class: `plan-${e.status}` }, h("span", { class: "check", "aria-hidden": "true" }, e.status === "completed" ? "✓" : e.status === "in_progress" ? "◐" : ""), h("span", {}, e.content), h("span", { class: "sr-only" }, ` (${e.status})`))),
  );

  setChildren(
    $("#timeline"),
    cur.timeline.map((t) =>
      h(
        "li",
        { class: t.kind === "tool" ? `tl-tool tl-${t.status}` : "tl-note" },
        h("time", {}, t.at.toLocaleTimeString()),
        h("span", {}, t.kind === "tool" ? `${t.toolKind || "tool"}: ${t.title}` : t.title),
        t.kind === "tool" ? h("span", { class: `pill pill-tool-${t.status}` }, (t.status || "").replace("_", " ")) : null,
      ),
    ),
  );
}

function reportMarkdown(cur) {
  const lines = [`> ${cur.meta.title} · ${new Date(cur.meta.createdAt).toLocaleString()} · generated on your computer via Remote ACP Bridge`, "", cur.text.trim() || "_No report text._", ""];
  if (cur.plan.length) lines.push("## Agent plan", ...cur.plan.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`), "");
  const tools = [...cur.tools.values()];
  if (tools.length) lines.push("## Tool calls", ...tools.map((t) => `- ${t.toolKind}: ${t.title} (${t.status})`), "");
  lines.push(`Status: ${cur.status}`);
  return lines.join("\n");
}

async function copyReport() {
  const cur = state.current;
  if (!cur) return;
  const text = reportMarkdown(cur);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { class: "sr-only" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  $("#copy").textContent = "Copied";
  setTimeout(() => ($("#copy").textContent = "Copy report"), 1500);
}

async function cancelCurrent() {
  const cur = state.current;
  if (!cur) return;
  $("#cancel").disabled = true;
  setStatus(cur, "Cancelling…", "wait");
  try {
    await api(`/api/reviews/${encodeURIComponent(cur.id)}/cancel`, { method: "POST" });
  } catch (e) {
    showNotice(cur, friendly(e), "err");
    $("#cancel").disabled = false;
  }
}

// ------------------------------------------------------------------ wiring

document.addEventListener("DOMContentLoaded", async () => {
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("#login-name").value);
  });
  $("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => undefined);
    location.reload();
  });
  $("#review-form").addEventListener("submit", runReview);
  $("#copy").addEventListener("click", copyReport);
  $("#cancel").addEventListener("click", cancelCurrent);
  try {
    const me = await api("/api/me");
    if (me.user) await enterApp(me.user);
    else showSignin();
  } catch {
    showSignin();
  }
});
