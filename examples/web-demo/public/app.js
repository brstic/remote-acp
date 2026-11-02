// Acme Notes (DEMO) — browser UI. Talks only to the demo server's /api/*.
// No secrets here: the server holds the relay credentials.
import { renderPairing } from "/vendor/browser-helper.js";

const $ = (sel) => document.querySelector(sel);
// replaceChildren() would render null/false as text; drop them.
const setChildren = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};

// ---------------------------------------------------------------- errors

const FRIENDLY = {
  desktop_offline: "Your desktop app isn't connected right now. Open Remote ACP Bridge on your computer and try again.",
  connection_revoked: "This connection was revoked. Connect your desktop agent again to continue.",
  connection_paused: "You paused this connection in the desktop app. Resume it there to send tasks.",
  connection_expired: "This connection expired. Connect your desktop agent again.",
  task_in_progress: "A task is already running on your desktop. Wait for it to finish or cancel it.",
  not_connected: "Connect your desktop agent first.",
  declined: "You declined this task in the desktop app.",
  approval_timeout: "Nobody approved the task on the desktop in time.",
  task_timeout: "The task ran too long and was stopped.",
  bridge_paused: "Remote ACP Bridge is paused on your desktop (kill switch). Resume it there.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  prompt_too_large: "That prompt is too long.",
  empty_prompt: "Type a prompt first.",
  signed_out: "Your demo session ended. Sign in again.",
  relay_auth_failed: "The demo server can't authenticate to the relay (check REMOTE_ACP_SERVICE_SECRET).",
  network_error: "The demo server can't reach the relay.",
  stream_interrupted: "Lost the live connection to your desktop's task.",
  missing_scope: "This connection doesn't allow interactive tasks.",
};
const friendly = (err) => (err && FRIENDLY[err.code]) || (err && err.message) || "Something went wrong.";

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
    throw new ApiError(0, "offline", "Can't reach the Acme Notes demo server.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const err = new ApiError(res.status, e.code || `http_${res.status}`, e.message || res.statusText);
    if (err.code === "signed_out") showSignin();
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- state

const state = {
  user: null,
  connection: null, // active/paused connection or null
  latest: null, // newest connection of any status
  pairing: null, // { url, code, expiresAt, status }
  pairingWidget: null,
  pairPoll: null,
  connPoll: null,
  runningTask: null, // { taskId, turn, es }
};

// ---------------------------------------------------------------- auth

function showSignin() {
  state.user = null;
  stopPolling();
  $("#signin").hidden = false;
  $("#app").hidden = true;
  $("#userbox").hidden = true;
}

async function login(username) {
  const err = $("#login-error");
  err.hidden = true;
  try {
    const r = await api("/api/login", { method: "POST", body: { username } });
    await enterApp(r.user);
  } catch (e) {
    err.textContent = friendly(e);
    err.hidden = false;
  }
}

async function enterApp(user) {
  state.user = user;
  $("#signin").hidden = true;
  $("#app").hidden = false;
  $("#userbox").hidden = false;
  $("#username").textContent = user.username;
  $("#avatar").textContent = user.username.slice(0, 1);
  await refreshConnection();
}

// ---------------------------------------------------------------- connection

function stopPolling() {
  clearInterval(state.pairPoll);
  clearInterval(state.connPoll);
  state.pairPoll = state.connPoll = null;
  state.pairingWidget?.destroy();
  state.pairingWidget = null;
}

async function refreshConnection() {
  try {
    const r = await api("/api/connection");
    state.connection = r.connection;
    state.latest = r.latest;
  } catch (e) {
    renderConnError(e);
    return;
  }
  if (!state.pairing || state.connection) renderConnection();
  updateComposer();
  clearInterval(state.connPoll);
  if (state.connection) state.connPoll = setInterval(pollConnection, 8000);
}

async function pollConnection() {
  try {
    const r = await api("/api/connection");
    const changed = JSON.stringify(r.connection) !== JSON.stringify(state.connection);
    state.connection = r.connection;
    state.latest = r.latest;
    if (changed) {
      renderConnection();
      updateComposer();
      if (!state.connection) clearInterval(state.connPoll);
    }
  } catch {
    /* transient; keep polling */
  }
}

function renderConnError(e) {
  const body = $("#conn-body");
  setChildren(body, 
    h("div", { class: "notice notice-err" }, friendly(e)),
    h("button", { class: "btn btn-secondary btn-block", type: "button", onclick: refreshConnection }, "Retry"),
  );
}

function renderConnection() {
  const body = $("#conn-body");
  const c = state.connection;
  if (c) {
    const paused = c.status === "paused";
    const dot = paused ? "dot-warn" : c.online ? "dot-ok" : "dot-err";
    const label = paused ? "Connected · paused on desktop" : c.online ? "Connected · desktop online" : "Connected · desktop offline";
    setChildren(body, 
      h("div", { class: "conn-state" }, h("span", { class: `dot ${dot}` }), label),
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Agent"),
        h("dd", {}, c.provider || "Unknown"),
        h("dt", {}, "Since"),
        h("dd", {}, new Date(c.createdAt).toLocaleString()),
        h("dt", {}, "Expires"),
        h("dd", {}, new Date(c.expiresAt).toLocaleString()),
      ),
      paused ? h("div", { class: "notice notice-warn" }, FRIENDLY.connection_paused) : null,
      !c.online && !paused ? h("div", { class: "notice notice-warn" }, "Open Remote ACP Bridge on your computer to run tasks.") : null,
      h("button", { class: "btn btn-danger btn-block", type: "button", onclick: disconnect }, "Disconnect"),
      h("p", { class: "muted small" }, "Disconnecting revokes this website's access on the relay. You can also revoke it from the desktop app."),
    );
    return;
  }
  const prev = state.latest;
  setChildren(body, 
    h("div", { class: "conn-state" }, h("span", { class: "dot" }), "Not connected"),
    prev && prev.status === "revoked" ? h("div", { class: "notice notice-warn" }, "Your previous connection was revoked.") : null,
    prev && prev.status === "expired" ? h("div", { class: "notice notice-warn" }, "Your previous connection expired.") : null,
    h(
      "ol",
      { class: "steps" },
      h("li", {}, "Install and open Remote ACP Bridge on your computer."),
      h("li", {}, "Click “Connect desktop agent” below."),
      h("li", {}, "Review and allow the connection in the desktop app."),
    ),
    h("button", { class: "btn btn-primary btn-block", type: "button", id: "connect", onclick: startPairing }, "Connect desktop agent"),
  );
}

async function startPairing() {
  const btn = $("#connect");
  if (btn) btn.disabled = true;
  stopPolling();
  try {
    const p = await api("/api/pairings", { method: "POST" });
    state.pairing = { ...p, status: "pending" };
    renderPairingState();
    state.pairPoll = setInterval(pollPairing, 1500);
  } catch (e) {
    renderConnError(e);
  }
}

function renderPairingState(connection) {
  const body = $("#conn-body");
  const p = state.pairing;
  if (p.status === "pending" || p.status === "claimed") {
    if (!state.pairingWidget) {
      const statusLine = h("div", { class: "conn-state", id: "pair-status" });
      const holder = h("div");
      setChildren(body, 
        statusLine,
        holder,
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: cancelPairing }, "Cancel"),
      );
      state.pairingWidget = renderPairing(holder, p, {
        labels: { button: "Open Remote ACP Bridge", codeHint: "Or enter this one-time code in the desktop app" },
        onExpire: () => pollPairing(),
        onNotOpened: () => {
          const s = $("#pair-status");
          if (s && state.pairing?.status === "pending") s.lastChild.textContent = "Didn't open? Make sure the desktop app is installed, or enter the code.";
        },
      });
    }
    const s = $("#pair-status");
    setChildren(s, 
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h(
        "span",
        {},
        p.status === "claimed" ? "Confirm the connection in the desktop app…" : "Waiting for you to open the link on this computer…",
      ),
    );
    return;
  }
  stopPolling();
  if (p.status === "accepted") {
    state.pairing = null;
    state.connection = connection;
    refreshConnection();
    return;
  }
  const msg =
    p.status === "rejected"
      ? ["You declined the connection in the desktop app.", "Try again"]
      : ["The pairing link expired before it was approved.", "Get a new link"];
  setChildren(body, 
    h("div", { class: "conn-state" }, h("span", { class: "dot dot-err" }), p.status === "rejected" ? "Declined" : "Link expired"),
    h("div", { class: "notice notice-warn" }, msg[0]),
    h("button", { class: "btn btn-primary btn-block", type: "button", onclick: startPairing }, msg[1]),
  );
  state.pairing = null;
}

async function pollPairing() {
  if (!state.pairing) return;
  try {
    const r = await api("/api/pairings/current");
    if (!r.pairing || !state.pairing) return;
    const prev = state.pairing.status;
    state.pairing.status = r.pairing.status;
    if (prev !== r.pairing.status || r.pairing.status !== "pending") renderPairingState(r.connection);
  } catch {
    /* keep polling */
  }
}

function cancelPairing() {
  stopPolling();
  state.pairing = null;
  renderConnection();
}

async function disconnect() {
  if (!confirm("Disconnect your desktop agent from Acme Notes?")) return;
  try {
    await api("/api/connection/disconnect", { method: "POST" });
  } catch (e) {
    renderConnError(e);
    return;
  }
  await refreshConnection();
}

// ---------------------------------------------------------------- tasks

function updateComposer() {
  const c = state.connection;
  const canSend = !!c && c.status === "active" && !state.runningTask;
  $("#prompt").disabled = !c || c.status !== "active";
  $("#send").disabled = !canSend;
  $("#prompt").placeholder = !c
    ? "Connect your desktop agent to start…"
    : c.status === "paused"
      ? "Connection is paused on your desktop"
      : state.runningTask
        ? "Waiting for the current task to finish…"
        : "Ask your desktop agent… (Enter to send, Shift+Enter for a new line)";
  document.querySelectorAll(".chip-btn").forEach((b) => (b.disabled = !canSend));
}

const STATUS = {
  sending: ["Sending…", "status-run"],
  pending: ["Sent to your desktop…", "status-run"],
  awaiting_approval: ["Waiting for approval on your desktop", "status-wait"],
  running: ["Running on your desktop", "status-run"],
  permission: ["Permission requested on your desktop", "status-wait"],
  cancelling: ["Cancelling…", "status-wait"],
  completed: ["Completed", "status-ok"],
  cancelled: ["Cancelled", ""],
  failed: ["Failed", "status-err"],
  rejected: ["Declined on desktop", "status-err"],
};

function createTurn(prompt) {
  $("#empty")?.remove();
  const statusEl = h("span", { class: "status" });
  const cancelBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", hidden: true }, "Cancel");
  const thoughtsBody = h("div");
  const thoughts = h("details", { class: "thoughts", hidden: true }, h("summary", {}, "Thinking"), thoughtsBody);
  const plan = h("ul", { class: "plan", hidden: true });
  const tools = h("div", { class: "tools", hidden: true });
  const perms = h("div");
  const text = h("div", { class: "agent-text" });
  const error = h("div", { class: "turn-error", role: "alert", hidden: true });
  const turn = h(
    "div",
    { class: "turn" },
    h("div", { class: "bubble bubble-user" }, prompt),
    h("div", { class: "bubble bubble-agent" }, h("div", { class: "agent-meta" }, statusEl, cancelBtn), thoughts, plan, tools, perms, text, error),
  );
  $("#transcript").append(turn);
  const scroll = () => ($("#transcript").scrollTop = $("#transcript").scrollHeight);
  const toolEls = new Map();
  const permEls = new Map();
  const t = {
    cancelBtn,
    setStatus(key, extra) {
      const [label, cls] = STATUS[key] || [key, ""];
      statusEl.className = `status ${cls}`;
      setChildren(statusEl, 
        ["sending", "pending", "awaiting_approval", "running", "permission", "cancelling"].includes(key)
          ? h("span", { class: "spinner", "aria-hidden": "true" })
          : "",
        extra ? `${label}: ${extra}` : label,
      );
    },
    appendText(s) {
      text.append(s);
      scroll();
    },
    appendThought(s) {
      thoughts.hidden = false;
      thoughtsBody.append(s);
    },
    setPlan(entries) {
      plan.hidden = entries.length === 0;
      setChildren(plan, ...entries.map((e) => h("li", { class: e.status }, e.content)));
    },
    tool(id, title, status) {
      tools.hidden = false;
      let el = toolEls.get(id);
      if (!el) {
        el = h("span", { class: "tool" });
        toolEls.set(id, el);
        tools.append(el);
      }
      if (title) el.dataset.title = title;
      if (status) el.dataset.status = status;
      el.textContent = `${el.dataset.title || id} · ${(el.dataset.status || "").replace("_", " ")}`;
    },
    permission(id, title, outcome) {
      let el = permEls.get(id);
      if (!el) {
        el = h("div", { class: "perm" });
        permEls.set(id, el);
        perms.append(el);
      }
      if (title) el.dataset.title = title;
      if (outcome) {
        el.className = "perm perm-done";
        el.textContent = `Permission ${outcome} on your desktop: ${el.dataset.title || ""}`;
      } else {
        el.textContent = `Permission requested on your desktop: “${el.dataset.title}”. Answer it in the Remote ACP Bridge app — this website can't approve it.`;
      }
      scroll();
    },
    pendingPermissions() {
      return [...permEls.values()].filter((e) => !e.classList.contains("perm-done")).length;
    },
    fail(msg) {
      error.hidden = false;
      error.textContent = msg;
    },
  };
  scroll();
  return t;
}

async function sendPrompt(prompt) {
  const errBox = $("#composer-error");
  errBox.hidden = true;
  if (!prompt.trim() || state.runningTask) return;
  const turn = createTurn(prompt);
  turn.setStatus("sending");
  state.runningTask = { turn };
  updateComposer();
  let task;
  try {
    task = await api("/api/tasks", { method: "POST", body: { prompt, idempotencyKey: crypto.randomUUID() } });
  } catch (e) {
    turn.setStatus("failed");
    turn.fail(friendly(e));
    state.runningTask = null;
    updateComposer();
    if (["connection_revoked", "connection_expired", "connection_paused", "not_connected", "desktop_offline"].includes(e.code)) refreshConnection();
    return;
  }
  state.runningTask = { turn, taskId: task.taskId };
  $("#prompt").value = "";
  turn.setStatus(task.state === "pending" ? "pending" : task.state);
  turn.cancelBtn.hidden = false;
  turn.cancelBtn.onclick = async () => {
    turn.cancelBtn.disabled = true;
    turn.setStatus("cancelling");
    try {
      await api(`/api/tasks/${task.taskId}/cancel`, { method: "POST" });
    } catch (e) {
      turn.fail(friendly(e));
      turn.cancelBtn.disabled = false;
    }
  };
  streamTask(task.taskId, turn);
}

function finishTask(turn) {
  turn.cancelBtn.hidden = true;
  state.runningTask?.es?.close();
  state.runningTask = null;
  updateComposer();
  $("#prompt").focus();
}

function streamTask(taskId, turn) {
  // EventSource reconnects by itself and sends Last-Event-ID; the demo server
  // forwards it to the relay so nothing is lost or duplicated.
  const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
  state.runningTask.es = es;
  let done = false;
  const data = (ev) => JSON.parse(ev.data);

  es.addEventListener("task.accepted", () => turn.setStatus("running"));
  es.addEventListener("task.event", (ev) => {
    const p = data(ev).payload;
    switch (p.type) {
      case "status":
        if (p.state === "awaiting_approval") turn.setStatus("awaiting_approval");
        else if (p.state === "running") turn.setStatus("running");
        else if (p.state === "cancelling") turn.setStatus("cancelling");
        break;
      case "text_delta":
        turn.appendText(p.text);
        break;
      case "thought_delta":
        turn.appendThought(p.text);
        break;
      case "plan":
        turn.setPlan(p.entries);
        break;
      case "tool_call":
        turn.tool(p.toolCallId, p.title, p.status);
        break;
      case "tool_call_update":
        turn.tool(p.toolCallId, p.title, p.status);
        break;
      case "permission_pending":
        turn.permission(p.requestId, p.title);
        turn.setStatus("permission", p.title);
        break;
      case "permission_resolved":
        turn.permission(p.requestId, null, p.outcome);
        if (turn.pendingPermissions() === 0) turn.setStatus("running");
        break;
    }
  });
  es.addEventListener("task.completed", (ev) => {
    done = true;
    const reason = data(ev).payload.stopReason;
    turn.setStatus(reason === "cancelled" ? "cancelled" : "completed", reason === "end_turn" || reason === "cancelled" ? "" : reason);
    finishTask(turn);
  });
  for (const kind of ["task.failed", "task.rejected"]) {
    es.addEventListener(kind, (ev) => {
      done = true;
      const p = data(ev).payload;
      turn.setStatus(kind === "task.rejected" ? "rejected" : "failed");
      turn.fail(friendly(p));
      finishTask(turn);
      if (p.code === "connection_revoked") refreshConnection();
    });
  }
  es.addEventListener("notice", (ev) => {
    const p = data(ev);
    if (p.code === "resume_unavailable") turn.fail("Some earlier output is no longer available; showing what's left.");
  });
  es.addEventListener("proxy_error", (ev) => {
    done = true;
    turn.setStatus("failed");
    turn.fail(friendly(data(ev)));
    finishTask(turn);
  });
  es.addEventListener("end", () => {
    if (!done) finishTask(turn);
    es.close();
  });
  es.onerror = () => {
    // CLOSED means the browser gave up (e.g. 404/401); CONNECTING means it will retry.
    if (es.readyState === EventSource.CLOSED && !done) {
      turn.setStatus("failed");
      turn.fail("Lost the live connection to this task.");
      finishTask(turn);
    }
  };
}

// ---------------------------------------------------------------- wiring

document.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll("[data-user]").forEach((b) => b.addEventListener("click", () => login(b.dataset.user)));
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("#login-name").value);
  });
  $("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => undefined);
    location.reload();
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendPrompt($("#prompt").value);
  });
  $("#prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt($("#prompt").value);
    }
  });
  document.querySelectorAll(".chip-btn").forEach((b) => b.addEventListener("click", () => sendPrompt(b.dataset.prompt)));

  try {
    const me = await api("/api/me");
    if (me.user) await enterApp(me.user);
    else showSignin();
  } catch {
    showSignin();
  }
});
