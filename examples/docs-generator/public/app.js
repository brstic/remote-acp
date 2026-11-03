// Docs Generator (EXAMPLE) — browser UI. Talks only to this server's /api/*.
// Error texts come from the server (`error.title` / `error.message`, and the
// `friendly` field on failed/rejected task events) so all clients agree.
import { renderPairing } from "/vendor/browser-helper.js";

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
    throw { code: "offline", title: "Server unreachable", message: "Can't reach the Docs Generator server." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || { code: `http_${res.status}`, title: "Error", message: res.statusText };
    if (err.code === "signed_out") showSignin();
    throw err;
  }
  return data;
}

const state = {
  user: null,
  conn: { state: "none", connection: null },
  pairing: null,
  pairingWidget: null,
  pairPoll: null,
  connPoll: null,
  types: [],
  selected: "readme",
  jobs: [],
  job: null, // { id, file, es, running, permission: Map, outcome }
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
    $("#login-error").textContent = e.message;
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
  clearInterval(state.connPoll);
  state.connPoll = setInterval(() => !state.pairing && refreshConnection(), 8000);
}

// ------------------------------------------------------------------ connection

const CONN_LABEL = {
  none: ["Not connected", ""],
  online: ["Connected · online", "dot-ok"],
  offline: ["Connected · desktop offline", "dot-err"],
  paused: ["Paused in Remote ACP Bridge", "dot-warn"],
  revoked: ["Revoked", "dot-err"],
  expired: ["Expired", "dot-err"],
};

async function refreshConnection() {
  try {
    state.conn = await api("/api/connection");
  } catch (e) {
    setChildren($("#conn-body"), errorBox(e));
    return;
  }
  if (!state.pairing) renderConnection();
  updateGenerate();
}

function renderConnection() {
  const { state: s, connection: c } = state.conn;
  const [label, dot] = CONN_LABEL[s] || [s, ""];
  const live = s === "online" || s === "offline" || s === "paused";
  setChildren(
    $("#conn-body"),
    h("div", { class: "conn-state", "data-state": s }, h("span", { class: `dot ${dot}` }), label),
    c ? h("p", { class: "muted small" }, `Agent: ${c.provider || "unknown"} · since ${new Date(c.createdAt).toLocaleDateString()}`) : null,
    s === "offline" ? h("div", { class: "notice notice-warn" }, "Open Remote ACP Bridge on your computer to generate documents.") : null,
    s === "paused" ? h("div", { class: "notice notice-warn" }, "You paused this website in the desktop app. Resume it there.") : null,
    s === "revoked" ? h("div", { class: "notice notice-warn" }, "This website's access was revoked. Connect again to continue.") : null,
    s === "expired" ? h("div", { class: "notice notice-warn" }, "The access you granted has expired. Connect again to continue.") : null,
    live
      ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: disconnect }, "Disconnect")
      : h("button", { class: "btn btn-primary btn-block", type: "button", onclick: startPairing }, "Connect desktop agent"),
  );
}

function stopPairing() {
  clearInterval(state.pairPoll);
  state.pairPoll = null;
  state.pairingWidget?.destroy();
  state.pairingWidget = null;
  state.pairing = null;
}

async function startPairing() {
  stopPairing();
  try {
    const p = await api("/api/pairings", { method: "POST" });
    state.pairing = p;
    const holder = h("div");
    setChildren(
      $("#conn-body"),
      h("div", { class: "conn-state" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { id: "pair-text" }, "Open the link in Remote ACP Bridge…")),
      holder,
      h("p", { class: "muted small" }, "In the app, choose your project folder and \"Can edit\" access."),
      h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => (stopPairing(), renderConnection()) }, "Cancel"),
    );
    state.pairingWidget = renderPairing(holder, p, {
      labels: { button: "Open Remote ACP Bridge", codeHint: "Or enter this one-time code in the desktop app" },
      onExpire: pollPairing,
    });
    state.pairPoll = setInterval(pollPairing, 1500);
  } catch (e) {
    setChildren($("#conn-body"), errorBox(e));
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
  const status = r.pairing?.status;
  if (status === "claimed") $("#pair-text").textContent = "Confirm the connection in the desktop app…";
  if (!status || status === "pending" || status === "claimed") return;
  stopPairing();
  if (status === "accepted") return refreshConnection();
  setChildren(
    $("#conn-body"),
    h("div", { class: "notice notice-warn" }, status === "rejected" ? "You declined the connection in the desktop app." : "The link expired before it was approved."),
    h("button", { class: "btn btn-primary btn-block", type: "button", onclick: startPairing }, "Get a new link"),
  );
}

async function disconnect() {
  if (!confirm("Disconnect your desktop agent from Docs Generator? You can connect again later.")) return;
  try {
    state.conn = await api("/api/connection/disconnect", { method: "POST" });
  } catch (e) {
    setChildren($("#conn-body"), errorBox(e));
    return;
  }
  renderConnection();
  updateGenerate();
}

// ------------------------------------------------------------------ generate

async function loadTypes() {
  const { types } = await api("/api/doc-types");
  state.types = types;
  setChildren(
    $("#doc-types"),
    h("legend", { class: "sr-only" }, "Document"),
    types.map((t) =>
      h(
        "label",
        { class: "type" },
        h("input", { type: "radio", name: "doc", value: t.id, checked: t.id === state.selected, onchange: () => (state.selected = t.id) }),
        h("span", { class: "type-body" }, h("span", { class: "type-title" }, t.file), h("span", { class: "type-desc" }, t.description)),
      ),
    ),
  );
}

function updateGenerate() {
  const running = !!state.job?.running;
  $("#generate").disabled = running || !["online", "offline", "paused"].includes(state.conn.state);
  $("#generate").textContent = running ? "Working…" : "Generate on my computer";
}

async function refreshHistory() {
  try {
    state.jobs = (await api("/api/jobs")).jobs;
  } catch {
    return;
  }
  $("#history-empty").hidden = state.jobs.length > 0;
  setChildren(
    $("#history"),
    state.jobs.map((j) => h("li", {}, h("span", { class: "history-title" }, j.file), h("span", { class: "history-meta" }, new Date(j.createdAt).toLocaleTimeString()))),
  );
}

function errorBox(e) {
  return h(
    "div",
    { class: "callout callout-err" },
    h("div", {}, h("strong", {}, e.title || "Something went wrong"), h("p", {}, e.message || ""), e.code ? h("p", { class: "muted small" }, `Code: ${e.code}`) : null),
  );
}

async function generate(ev) {
  ev.preventDefault();
  const type = state.types.find((t) => t.id === state.selected);
  resetJobView(type);
  state.job = { id: null, file: type.file, running: true, permissions: new Map(), outcome: null, tools: new Map() };
  updateGenerate();
  let job;
  try {
    job = await api("/api/jobs", { method: "POST", body: { doc: type.id, notes: $("#notes").value, idempotencyKey: crypto.randomUUID() } });
  } catch (e) {
    showJobError(e);
    finishJob("Not started", "err");
    if (e.reconnect || ["desktop_offline", "connection_paused"].includes(e.code)) refreshConnection();
    return;
  }
  state.job.id = job.id;
  step("sent", "done");
  step("approve", "active");
  setStatus("Sent — approve the task in Remote ACP Bridge", "wait");
  $("#cancel").hidden = false;
  $("#cancel").disabled = false;
  api(`/api/jobs/${encodeURIComponent(job.id)}`).then((d) => ($("#prompt-text").textContent = d.prompt)).catch(() => {});
  refreshHistory();
  follow(job.id);
}

function resetJobView(type) {
  $("#job").hidden = false;
  $("#job-title").textContent = `Generating ${type.file}`;
  for (const li of document.querySelectorAll("#steps li")) li.className = "";
  for (const id of ["#perm-wait", "#perm-outcome", "#job-error", "#job-done"]) $(id).hidden = true;
  $("#agent-text").textContent = "";
  setChildren($("#tools"));
  $("#tools-empty").hidden = false;
  $("#prompt-text").textContent = "";
  setStatus("Sending…", "run");
}

function step(name, cls) {
  const li = document.querySelector(`#steps li[data-step="${name}"]`);
  if (li && !(li.className === "done" && cls === "active")) li.className = cls;
}

function setStatus(text, tone) {
  const s = $("#job-status");
  s.className = `status status-${tone}`;
  setChildren(s, tone === "run" || tone === "wait" ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, text);
}

function showJobError(e) {
  const box = $("#job-error");
  setChildren(
    box,
    h("div", {}, h("strong", {}, e.title || "Something went wrong"), h("p", {}, e.message || ""), e.code ? h("p", { class: "muted small" }, `Code: ${e.code}`) : null),
    e.reconnect ? h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: startPairing }, "Connect again") : null,
  );
  box.hidden = false;
}

function follow(id) {
  const job = state.job;
  const es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  job.es = es;
  const data = (e) => JSON.parse(e.data);

  es.addEventListener("task.accepted", () => {
    step("approve", "done");
    step("work", "active");
    setStatus("Agent is working on your computer…", "run");
  });
  es.addEventListener("task.event", (e) => {
    const p = data(e).payload;
    switch (p.type) {
      case "status":
        if (p.state === "awaiting_approval") setStatus("Waiting for you to approve the task in Remote ACP Bridge", "wait");
        if (p.state === "cancelling") setStatus("Cancelling…", "wait");
        break;
      case "text_delta":
        $("#agent-text").textContent += p.text; // textContent: agent output is never HTML
        break;
      case "tool_call":
      case "tool_call_update":
        tool(p);
        break;
      case "permission_pending":
        // The prompt is on the user's desktop. We can only show that it is waiting.
        job.permissions.set(p.requestId, p.title);
        step("work", "done");
        step("permission", "active");
        $("#perm-wait-title").textContent = p.title;
        $("#perm-wait").hidden = false;
        $("#perm-outcome").hidden = true;
        setStatus("Waiting for your approval in Remote ACP Bridge", "wait");
        break;
      case "permission_resolved":
        showPermissionOutcome(p.outcome, job.permissions.get(p.requestId) || "the requested action");
        break;
    }
  });
  es.addEventListener("task.completed", (e) => {
    const reason = data(e).payload.stopReason;
    if (reason === "cancelled") {
      finishJob("Cancelled", "muted");
      showDone("Cancelled. Nothing more will be done by the agent for this request.", "muted");
      return;
    }
    finishJob("Completed", "ok");
    if (job.outcome === "allowed") showDone(`Done. You allowed the write — check ${job.file} in your project folder.`, "ok");
    else if (job.outcome === "denied") showDone("Finished without writing: you denied the permission, so nothing was changed.", "muted");
    else showDone("The agent finished without requesting to write a file. See its messages above.", "muted");
  });
  for (const kind of ["task.failed", "task.rejected"]) {
    es.addEventListener(kind, (e) => {
      const d = data(e);
      showJobError({ code: d.payload.code, ...(d.friendly || { title: "Failed", message: d.payload.message }) });
      finishJob(kind === "task.rejected" ? "Declined" : "Failed", "err");
      if (d.friendly?.reconnect) refreshConnection();
    });
  }
  es.addEventListener("proxy_error", (e) => {
    showJobError(data(e));
    finishJob("Failed", "err");
  });
  es.addEventListener("end", () => {
    es.close();
    if (job.running) finishJob("Finished", "muted");
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && job.running) {
      showJobError({ title: "Lost the live view", message: "The connection to this server was interrupted." });
      finishJob("Unknown", "err");
    }
  };
}

function showPermissionOutcome(outcome, title) {
  const job = state.job;
  job.outcome = outcome;
  $("#perm-wait").hidden = true;
  const box = $("#perm-outcome");
  const text =
    outcome === "allowed"
      ? ["You allowed it in Remote ACP Bridge", `“${title}” was approved on your computer.`, "callout-ok"]
      : outcome === "denied"
        ? ["You denied it in Remote ACP Bridge", `“${title}” was refused on your computer. Nothing was written.`, "callout-muted"]
        : ["The request was cancelled", `“${title}” was not answered (the task stopped).`, "callout-muted"];
  box.className = `callout ${text[2]}`;
  box.dataset.outcome = outcome;
  setChildren(box, h("div", {}, h("strong", {}, text[0]), h("p", {}, text[1])));
  box.hidden = false;
  step("permission", "done");
  setStatus("Agent is working on your computer…", "run");
}

function tool(p) {
  const job = state.job;
  let el = job.tools.get(p.toolCallId);
  if (!el) {
    el = h("li", {});
    job.tools.set(p.toolCallId, el);
    $("#tools").append(el);
    $("#tools-empty").hidden = true;
  }
  if (p.title) el.dataset.title = p.title;
  if (p.kind) el.dataset.kind = p.kind;
  if (p.status) el.dataset.status = p.status;
  setChildren(el, h("span", {}, `${el.dataset.kind || "tool"}: ${el.dataset.title || p.toolCallId}`), h("span", { class: `pill pill-tool-${el.dataset.status}` }, (el.dataset.status || "").replace("_", " ")));
}

function showDone(text, tone) {
  const box = $("#job-done");
  box.className = `callout callout-${tone}`;
  box.textContent = text;
  box.hidden = false;
}

function finishJob(label, tone) {
  const job = state.job;
  if (!job || !job.running) return;
  job.running = false;
  job.es?.close();
  $("#perm-wait").hidden = true;
  $("#cancel").hidden = true;
  for (const li of document.querySelectorAll("#steps li.active")) li.className = tone === "ok" ? "done" : "skipped";
  step("done", tone === "ok" ? "done" : tone === "err" ? "failed" : "skipped");
  setStatus(label, tone);
  updateGenerate();
}

async function cancelJob() {
  const job = state.job;
  if (!job?.id) return;
  $("#cancel").disabled = true;
  setStatus("Cancelling…", "wait");
  try {
    await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
  } catch (e) {
    showJobError(e);
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
  $("#gen-form").addEventListener("submit", generate);
  $("#cancel").addEventListener("click", cancelJob);
  $("#conn-refresh").addEventListener("click", refreshConnection);
  try {
    const me = await api("/api/me");
    if (me.user) await enterApp(me.user);
    else showSignin();
  } catch {
    showSignin();
  }
});
