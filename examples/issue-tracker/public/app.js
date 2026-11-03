// Bugboard (EXAMPLE): browser UI. Talks only to this server's /api/*. The
// server holds the relay credentials, builds the prompts and mints the MCP
// tokens; the browser never sees either. Everything is rendered with
// textContent (no innerHTML), including agent output and comments.
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
  desktop_offline: ["Your computer is offline", "Remote ACP Bridge isn't connected right now. Open the app on your computer (and check it isn't paused), then try again."],
  connection_revoked: ["Connection removed", "This connection was revoked, here or in the Remote ACP Bridge app. Connect your desktop agent again."],
  connection_expired: ["Connection expired", "The access you granted Bugboard has expired. Connect your desktop agent again."],
  connection_paused: ["Connection paused", "You paused Bugboard in Remote ACP Bridge. Resume it in the app to run fixes."],
  not_connected: ["Not connected", "Connect your desktop agent first."],
  task_in_progress: ["Your agent is busy", "Your agent is still working on another task from Bugboard. Wait for it to finish or cancel it."],
  declined: ["You declined the task", "The fix was declined in Remote ACP Bridge, so nothing ran and nothing changed."],
  approval_timeout: ["Not approved in time", "Nobody approved the task in Remote ACP Bridge before it timed out. Nothing changed."],
  bridge_paused: ["Remote ACP Bridge is paused", "All website tasks are paused in the desktop app. Resume it there and try again."],
  policy_blocked: ["Stopped by your computer's safety checks", "Remote ACP Bridge stopped the run because the agent tried to reach outside your project folder or produced something that looks like a credential. Nothing more was sent to Bugboard."],
  tools_not_allowed: ["Bugboard's tools were refused", "Your desktop only lets a website's agent tools run on that website's own domain, and this server's tool URL is not on it. Ask the site operator to fix PUBLIC_URL."],
  missing_scope: ["Tools not allowed on this connection", "This connection doesn't let the agent use Bugboard's tools. Disconnect and connect again, then allow \"Give the agent its own tools\"."],
  provider_policy: ["Agent not allowed for websites", "The agent selected for this connection can't be used by websites. Pick another agent in Remote ACP Bridge."],
  provider_unavailable: ["Agent not ready", "The AI provider selected for this connection isn't ready on your computer. Check AI Providers in Remote ACP Bridge."],
  task_timeout: ["Took too long", "The run took longer than allowed and was stopped."],
  rate_limited: ["Slow down", "Too many requests. Wait a moment and try again."],
  signed_out: ["Signed out", "Your session ended. Sign in again."],
  relay_auth_failed: ["Server misconfigured", "Bugboard can't authenticate to the relay. Check REMOTE_ACP_SERVICE_SECRET."],
  network_error: ["Relay unreachable", "Bugboard can't reach the relay right now. Try again shortly."],
  stream_interrupted: ["Lost the live view", "The live connection to the run was interrupted. The task may still be running on your computer."],
  offline: ["Bugboard unreachable", "Can't reach the Bugboard server."],
};
const friendly = (err) => {
  const f = err && FRIENDLY[err.code];
  return f ? { title: f[0], message: f[1] } : { title: "Something went wrong", message: (err && err.message) || "Unexpected error." };
};
const friendlyText = (err) => {
  const f = friendly(err);
  return `${f.title}. ${f.message}`;
};
const RECONNECT = new Set(["connection_revoked", "connection_expired", "not_connected", "missing_scope", "connection_paused", "desktop_offline"]);

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
    throw { code: "offline", message: "Can't reach the Bugboard server." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || { code: `http_${res.status}`, message: res.statusText };
    err.status = res.status;
    if (err.code === "signed_out") showSignin();
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ small helpers

function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const labelClass = (l) => `label label-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const STATUS_LABEL = { open: "Open", in_progress: "In progress", in_review: "In review", done: "Done" };

/** Short label + tone for a run's state (list badges, history, panel). */
function runBadge(run) {
  if (!run) return null;
  if (run.state === "running") {
    if (run.phase === "awaiting_approval") return { text: "Waiting for approval", tone: "wait", spin: true };
    if (run.phase === "permission_pending") return { text: "Permission requested", tone: "wait", spin: true };
    if (run.phase === "cancelling") return { text: "Cancelling", tone: "wait", spin: true };
    return { text: "Agent working", tone: "run", spin: true };
  }
  if (run.state === "completed") return { text: "Agent finished", tone: "ok" };
  if (run.state === "cancelled") return { text: "Cancelled", tone: "muted" };
  if (run.state === "rejected") return { text: run.error?.code === "declined" ? "Declined" : "Not started", tone: "err" };
  return { text: "Run failed", tone: "err" };
}

// ------------------------------------------------------------------ theme

const THEME_KEY = "bugboard-theme";
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  /* storage unavailable */
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
  listPoll: null,
  filter: "active",
  issues: [],
  project: null,
  view: null, // "list" | "issue"
  issue: null, // { id, es, snapshot, seenComments:Set, selectedRunId }
  run: null, // the run on screen (see openRun)
  runOpening: null,
};

// ------------------------------------------------------------------ auth

function showSignin() {
  state.user = null;
  stopPairing();
  clearInterval(state.connPoll);
  clearInterval(state.listPoll);
  closeIssue();
  $("#signin").hidden = false;
  $("#app").hidden = true;
  $("#userbox").hidden = true;
  $("#conn-chip").hidden = true;
  $("#crumbs").hidden = true;
}

async function login(username) {
  $("#login-error").hidden = true;
  try {
    const r = await api("/api/login", { method: "POST", body: { username } });
    await enterApp(r.user);
  } catch (e) {
    $("#login-error").textContent = friendly(e).message;
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
  await refreshConnection();
  route();
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
    setChildren($("#conn-body"), h("div", { class: "notice notice-err" }, friendlyText(e)), h("button", { class: "btn btn-secondary btn-block", type: "button", onclick: refreshConnection }, "Retry"));
    return;
  }
  if (!state.pairing) renderConnection();
  renderChip();
  updateFixButton();
  clearInterval(state.connPoll);
  state.connPoll = setInterval(pollConnection, state.connection ? 6000 : 15000);
}

async function pollConnection() {
  if (state.pairing) return;
  try {
    const r = await api("/api/connection");
    if (JSON.stringify(r) === JSON.stringify({ connection: state.connection, latest: state.latest })) return;
    state.connection = r.connection;
    state.latest = r.latest;
    renderConnection();
    renderChip();
    updateFixButton();
  } catch {
    /* transient */
  }
}

function connTone(c) {
  if (!c) return { dot: "", text: "Not connected" };
  if (c.status === "paused") return { dot: "dot-warn", text: "Paused on your desktop" };
  return c.online ? { dot: "dot-ok", text: "Connected · online" } : { dot: "dot-err", text: "Connected · desktop offline" };
}

function renderChip() {
  const chip = $("#conn-chip");
  const t = connTone(state.connection);
  setChildren(chip, h("span", { class: `dot ${t.dot}` }), state.connection ? (state.connection.online ? "Agent online" : state.connection.status === "paused" ? "Agent paused" : "Agent offline") : "Connect agent");
  chip.hidden = false;
}

function renderConnection() {
  const c = state.connection;
  const t = connTone(c);
  if (c) {
    const paused = c.status === "paused";
    setChildren(
      $("#conn-body"),
      h("div", { class: "conn-state" }, h("span", { class: `dot ${t.dot}` }), t.text),
      h("p", { class: "muted small conn-meta" }, `Agent: ${c.provider || "unknown"} · tools: ${c.tools ? "allowed" : "not allowed"}`),
      paused ? h("div", { class: "notice notice-warn" }, FRIENDLY.connection_paused[1]) : null,
      !c.online && !paused ? h("div", { class: "notice notice-warn" }, "Open Remote ACP Bridge on your computer to run fixes.") : null,
      !c.tools ? h("div", { class: "notice notice-warn" }, FRIENDLY.missing_scope[1]) : null,
      h("div", { class: "conn-actions" }, h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: disconnect }, "Disconnect")),
    );
    return;
  }
  const prev = state.latest;
  setChildren(
    $("#conn-body"),
    h("div", { class: "conn-state" }, h("span", { class: "dot" }), "Not connected"),
    prev?.status === "revoked" ? h("div", { class: "notice notice-warn" }, "Your previous connection was revoked.") : null,
    prev?.status === "expired" ? h("div", { class: "notice notice-warn" }, "Your previous connection expired.") : null,
    h(
      "p",
      { class: "muted small conn-meta" },
      "Connect Remote ACP Bridge on this computer. In the app, pick your agent and the project folder, choose ",
      h("strong", {}, "Can edit"),
      " so it can apply fixes, and allow Bugboard's tools.",
    ),
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
    setChildren($("#conn-body"), h("div", { class: "notice notice-err" }, friendlyText(e)), h("button", { class: "btn btn-secondary btn-block", type: "button", onclick: startPairing }, "Try again"));
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
  if (!confirm("Disconnect your desktop agent from Bugboard? Running fixes stop.")) return;
  try {
    await api("/api/connection/disconnect", { method: "POST" });
  } catch (e) {
    alert(friendlyText(e));
  }
  await refreshConnection();
}

// ------------------------------------------------------------------ routing

function route() {
  if (!state.user) return;
  const m = /^#\/issues\/(BUG-\d+)$/.exec(location.hash);
  if (m) return showIssue(m[1]);
  if (location.hash !== "#/issues") history.replaceState(null, "", "#/issues");
  showList();
}

function setCrumbs(...parts) {
  const c = $("#crumbs");
  const nodes = [h("a", { href: "#/issues" }, state.project?.name || "acme-web")];
  for (const p of parts) nodes.push(h("span", { class: "sep", "aria-hidden": "true" }, "/"), h("span", { class: "here" }, p));
  setChildren(c, nodes);
  c.hidden = false;
}

// ------------------------------------------------------------------ list

async function showList() {
  closeIssue();
  state.view = "list";
  $("#view-list").hidden = false;
  $("#view-issue").hidden = true;
  $("#view-missing").hidden = true;
  setCrumbs("Issues");
  document.title = "Issues · Bugboard (Example)";
  await loadIssues();
  clearInterval(state.listPoll);
  // Badges update while agents work (runs, new comments).
  state.listPoll = setInterval(() => state.view === "list" && loadIssues(), 4000);
}

async function loadIssues() {
  let r;
  try {
    r = await api("/api/issues");
  } catch {
    return;
  }
  state.issues = r.issues;
  state.project = r.project;
  $("#project-name").textContent = r.project.name;
  $("#project-desc").textContent = r.project.description;
  const active = r.issues.filter((i) => i.status !== "done").length;
  $("#nav-count").textContent = String(active);
  if (state.view === "list") renderList();
}

function renderList() {
  const f = state.filter;
  const list = state.issues.filter((i) => (f === "all" ? true : f === "active" ? i.status !== "done" : i.status === f));
  const open = state.issues.filter((i) => i.status === "open").length;
  $("#list-sub").textContent = `${state.issues.length} issues · ${open} open · ${state.project?.description ?? ""}`;
  for (const b of document.querySelectorAll("#filters button")) b.setAttribute("aria-selected", String(b.dataset.filter === f));
  $("#list-empty").hidden = list.length > 0;
  setChildren(
    $("#issue-list"),
    list.map((i) => {
      const badge = runBadge(i.activity);
      return h(
        "li",
        {},
        h(
          "a",
          { class: "issue-row", href: `#/issues/${i.id}` },
          h("span", { class: `status-icon st-${i.status}`, title: i.statusLabel, "aria-label": i.statusLabel }),
          h(
            "span",
            {},
            h("span", { class: "issue-row-title" }, i.title),
            h(
              "span",
              { class: "issue-row-meta" },
              h("span", {}, `${i.id} · opened by ${i.reporter}`),
              i.labels.map((l) => h("span", { class: labelClass(l) }, l)),
            ),
          ),
          h(
            "span",
            { class: "issue-row-side" },
            badge ? h("span", { class: `activity activity-${badge.tone}` }, badge.spin ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, badge.text) : null,
            i.agentCommentCount ? h("span", { class: "activity activity-run", title: "Comments from your agent" }, `${i.agentCommentCount} from agent`) : null,
            h("span", { title: "Comments" }, `${i.commentCount} comment${i.commentCount === 1 ? "" : "s"}`),
            h("span", {}, ago(i.updatedAt)),
          ),
        ),
      );
    }),
  );
}

// ------------------------------------------------------------------ issue page

function closeIssue() {
  state.issue?.es?.close();
  state.issue = null;
  closeRun();
}

function showIssue(id) {
  clearInterval(state.listPoll);
  if (state.issue?.id === id) return;
  closeIssue();
  state.view = "issue";
  $("#view-list").hidden = true;
  $("#view-missing").hidden = true;
  $("#view-issue").hidden = true;
  $("#fix-error").hidden = true;
  $("#run-card").hidden = true;
  $("#comment-text").value = "";
  const cur = { id, es: null, snapshot: null, seenComments: null, selectedRunId: null };
  state.issue = cur;
  // Live issue: a full snapshot on connect and after every change.
  const es = new EventSource(`/api/issues/${encodeURIComponent(id)}/stream`);
  cur.es = es;
  es.addEventListener("issue", (ev) => {
    if (state.issue !== cur) return;
    renderIssue(cur, JSON.parse(ev.data));
  });
  es.addEventListener("error", async () => {
    if (state.issue !== cur || cur.snapshot) return; // EventSource retries by itself
    es.close();
    const r = await api(`/api/issues/${encodeURIComponent(id)}`).catch((e) => e);
    if (r && r.status === 404) {
      $("#view-missing").hidden = false;
      setCrumbs("Not found");
    }
  });
}

function renderIssue(cur, snap) {
  const first = !cur.snapshot;
  cur.snapshot = snap;
  const i = snap.issue;
  $("#view-issue").hidden = false;
  setCrumbs("Issues", i.id);
  document.title = `${i.id} ${i.title} · Bugboard (Example)`;

  setChildren($("#issue-title"), i.title, h("span", { class: "id" }, i.id));
  const pill = $("#issue-status");
  const prevStatus = pill.dataset.status;
  pill.className = `status-pill sp-${i.status}`;
  pill.dataset.status = i.status;
  setChildren(pill, h("span", { class: `status-icon st-${i.status}`, "aria-hidden": "true" }), i.statusLabel);
  if (!first && prevStatus && prevStatus !== i.status) flash(pill);
  $("#issue-byline").textContent = `Opened ${ago(i.createdAt)} by ${i.reporter} · ${i.assignee ? `assigned to ${i.assignee}` : "unassigned"}`;
  $("#status-select").value = i.status;

  const body = [
    h("div", { class: "labels" }, i.labels.map((l) => h("span", { class: labelClass(l) }, l))),
    h("h3", {}, "Description"),
    h("div", { class: "md" }, renderMarkdown(i.description)),
  ];
  if (i.steps.length) body.push(h("h3", {}, "Steps to reproduce"), h("ol", { class: "md" }, i.steps.map((s) => h("li", {}, renderInline(s)))));
  body.push(
    h(
      "div",
      { class: "expect-grid" },
      h("div", { class: "box-ok" }, h("h3", {}, "Expected"), h("div", { class: "md" }, renderMarkdown(i.expected || "-"))),
      h("div", { class: "box-err" }, h("h3", {}, "Actual"), h("div", { class: "md" }, renderMarkdown(i.actual || "-"))),
    ),
  );
  if (i.stackTrace) body.push(h("h3", {}, "Stack trace"), h("pre", {}, i.stackTrace));
  setChildren($("#issue-body"), body);

  renderComments(cur, i.comments, first);
  renderRunHistory(cur, snap.runs);
  updateFixButton();

  // Follow the selected run, or the newest one.
  const want = cur.selectedRunId && snap.runs.some((r) => r.id === cur.selectedRunId) ? cur.selectedRunId : snap.runs[0]?.id;
  if (want && state.run?.id !== want && state.runOpening !== want) openRun(want);
  if (state.run) {
    const summary = snap.runs.find((r) => r.id === state.run.id);
    if (summary) {
      state.run.summary = summary;
      scheduleRender(state.run);
    }
  }
}

function renderInline(text) {
  const frag = renderMarkdown(text);
  const p = frag.firstChild;
  return p && p.nodeName === "P" ? [...p.childNodes] : frag;
}

function flash(node) {
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

function renderComments(cur, comments, first) {
  const seen = cur.seenComments ?? new Set();
  const items = comments.map((c) => {
    const fresh = !first && !seen.has(c.id);
    seen.add(c.id);
    if (c.authorKind === "system") {
      return h(
        "li",
        { class: "comment system" },
        h("span", { class: "sys-dot", "aria-hidden": "true" }),
        h("span", {}, h("strong", {}, c.author), ` ${c.body} · ${ago(c.createdAt)}`),
      );
    }
    const agent = c.authorKind === "agent";
    const li = h(
      "li",
      { class: `comment${agent ? " agent" : ""}` },
      h("span", { class: `avatar sm${agent ? " agent" : ""}`, "aria-hidden": "true" }, agent ? "AI" : c.author.slice(0, 1)),
      h(
        "div",
        { class: "comment-card" },
        h(
          "div",
          { class: "comment-head" },
          h("strong", {}, c.author),
          agent ? h("span", { class: "tag" }, "Agent") : null,
          h("span", { class: "muted" }, `commented ${ago(c.createdAt)}`),
        ),
        h("div", { class: "comment-body md" }, renderMarkdown(c.body)),
      ),
    );
    if (fresh) li.classList.add("flash");
    return li;
  });
  cur.seenComments = seen;
  setChildren($("#comments"), items);
}

function renderRunHistory(cur, runs) {
  $("#run-history-empty").hidden = runs.length > 0;
  setChildren(
    $("#run-history"),
    runs.map((r) => {
      const b = runBadge(r);
      return h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: `run-item${state.run?.id === r.id ? " active" : ""}`,
            onclick: () => {
              cur.selectedRunId = r.id;
              openRun(r.id);
              renderRunHistory(cur, cur.snapshot.runs);
            },
          },
          h("span", {}, new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })),
          h("span", { class: `activity activity-${b.tone}` }, b.text),
          h("span", { class: "meta" }, r.error ? friendly(r.error).title : r.toolCalls.length ? `${r.toolCalls.length} Bugboard tool call${r.toolCalls.length === 1 ? "" : "s"}` : r.preview.slice(0, 80) || "No output"),
        ),
      );
    }),
  );
}

function issueHasActiveRun() {
  return !!state.issue?.snapshot?.runs.some((r) => r.state === "running");
}

function updateFixButton() {
  const btn = $("#fix");
  const c = state.connection;
  const busy = issueHasActiveRun();
  btn.disabled = !c || c.status !== "active" || busy;
  btn.textContent = busy ? "Your agent is on it…" : "Fix with my agent";
  const hint = $("#fix-hint");
  if (!c) hint.textContent = "Connect your desktop agent first (left).";
  else if (c.status === "paused") hint.textContent = "Resume Bugboard in Remote ACP Bridge to run fixes.";
  else if (!c.online) hint.textContent = "Your desktop app looks offline. Open Remote ACP Bridge on your computer.";
  else if (!c.tools) hint.textContent = "This connection can't use Bugboard's tools. Reconnect and allow them.";
  else hint.textContent = `Runs with ${c.provider || "your agent"}. You'll approve it in Remote ACP Bridge.`;
}

async function fixIssue() {
  const cur = state.issue;
  if (!cur) return;
  $("#fix-error").hidden = true;
  $("#fix").disabled = true;
  try {
    const run = await api(`/api/issues/${encodeURIComponent(cur.id)}/fix`, { method: "POST", body: { idempotencyKey: crypto.randomUUID() } });
    cur.selectedRunId = run.id;
    openRun(run.id);
  } catch (err) {
    const f = friendly(err);
    setChildren($("#fix-error"), h("strong", {}, f.title), f.message);
    $("#fix-error").hidden = false;
    if (RECONNECT.has(err.code)) refreshConnection();
    updateFixButton();
  }
}

async function setStatus(e) {
  const cur = state.issue;
  if (!cur) return;
  try {
    await api(`/api/issues/${encodeURIComponent(cur.id)}/status`, { method: "POST", body: { status: e.target.value } });
  } catch (err) {
    alert(friendlyText(err));
    if (cur.snapshot) e.target.value = cur.snapshot.issue.status;
  }
}

async function addComment(e) {
  e.preventDefault();
  const cur = state.issue;
  const text = $("#comment-text").value;
  if (!cur || !text.trim()) return;
  $("#comment-error").hidden = true;
  try {
    await api(`/api/issues/${encodeURIComponent(cur.id)}/comments`, { method: "POST", body: { body: text } });
    $("#comment-text").value = "";
  } catch (err) {
    $("#comment-error").textContent = friendly(err).message;
    $("#comment-error").hidden = false;
  }
}

// ------------------------------------------------------------------ agent run panel

function closeRun() {
  state.runOpening = null;
  state.run?.es?.close();
  state.run = null;
}

const RUN_STATE = {
  starting: ["Sent to your desktop…", "Remote ACP Bridge is receiving the task.", "run"],
  awaiting_approval: ["Waiting for your approval on your desktop", "Open Remote ACP Bridge and approve the task. Bugboard can't approve it for you.", "wait"],
  running: ["Running on your computer", "Your agent is working in your project folder.", "run"],
  permission_pending: ["Permission requested on your desktop", "Your agent asked to do something sensitive. Answer in Remote ACP Bridge; Bugboard can only watch.", "wait"],
  cancelling: ["Cancelling…", "Asking your agent to stop.", "wait"],
};

async function openRun(id) {
  closeRun();
  state.runOpening = id;
  const meta = await api(`/api/runs/${encodeURIComponent(id)}`).catch(() => null);
  if (state.runOpening !== id) return; // another run was opened meanwhile
  state.runOpening = null;
  if (!meta || state.issue?.id !== meta.issueId) return;
  const cur = { id, meta, summary: meta, text: "", plan: [], tools: new Map(), timeline: [], phase: meta.phase, done: false, final: null, es: null, raf: 0, notice: null };
  state.run = cur;
  $("#run-card").hidden = false;
  $("#prompt-text").textContent = meta.prompt;
  $("#cancel").disabled = false;
  addTimeline(cur, "Sent to your desktop agent", meta.createdAt);
  renderRun(cur);
  if (state.issue?.snapshot) renderRunHistory(state.issue, state.issue.snapshot.runs);

  // The server replays everything it kept, then follows live; EventSource resumes with Last-Event-ID.
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  cur.es = es;
  const data = (ev) => JSON.parse(ev.data);
  // `at` is when Bugboard received the event (kept across replays).
  const atOf = (d) => (d.at ? new Date(d.at) : new Date());
  es.addEventListener("task.accepted", (ev) => {
    cur.phase = "running";
    addTimeline(cur, "Approved on your desktop; the agent started", atOf(data(ev)));
  });
  es.addEventListener("task.event", (ev) => {
    const d = data(ev);
    const p = d.payload;
    const at = atOf(d);
    switch (p.type) {
      case "status":
        if (p.state === "awaiting_approval") {
          cur.phase = "awaiting_approval";
          addTimeline(cur, "Waiting for you to approve the task on your desktop", at);
        } else if (p.state === "running") cur.phase = "running";
        else if (p.state === "cancelling") cur.phase = "cancelling";
        break;
      case "text_delta":
        cur.text += p.text;
        break;
      case "plan":
        cur.plan = p.entries;
        break;
      case "tool_call": {
        const item = { kind: "tool", title: p.title, status: p.status, toolKind: p.kind, at };
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
        cur.phase = "permission_pending";
        addTimeline(cur, `Permission requested on your desktop: ${p.title}`, at);
        break;
      case "permission_resolved":
        cur.phase = "running";
        addTimeline(cur, `Permission ${p.outcome} on your desktop`, at);
        break;
    }
    scheduleRender(cur);
  });
  es.addEventListener("task.completed", (ev) => {
    const d = data(ev);
    const reason = d.payload.stopReason;
    cur.finishedAt = atOf(d);
    finish(cur, reason === "cancelled" ? { label: "Cancelled", sub: "The run was stopped. Changes the agent already made stay in your folder.", tone: "muted" } : { label: "Completed", sub: `Your agent finished (${reason}).`, tone: "ok" }, reason === "cancelled" ? "Run cancelled" : "Finished");
  });
  for (const kind of ["task.failed", "task.rejected"]) {
    es.addEventListener(kind, (ev) => {
      const d = data(ev);
      const p = d.payload;
      const f = friendly(p);
      cur.finishedAt = atOf(d);
      finish(cur, { label: kind === "task.rejected" && p.code === "declined" ? "Declined" : "Failed", sub: `${f.title}. ${f.message}`, tone: "err", code: p.code }, f.title);
    });
  }
  es.addEventListener("notice", (ev) => {
    const p = data(ev);
    if (p.code === "truncated" || p.code === "resume_unavailable") {
      cur.notice = "Part of this run's output is no longer available.";
      scheduleRender(cur);
    }
  });
  es.addEventListener("end", (ev) => {
    es.close();
    const p = data(ev);
    if (!cur.done) {
      const f = p.error ? friendly(p.error) : null;
      finish(cur, { label: p.state === "failed" ? "Failed" : "Finished", sub: f ? `${f.title}. ${f.message}` : "Stream ended.", tone: p.state === "failed" ? "err" : "muted" }, f ? f.title : "Stream ended");
    }
  });
}

function finish(cur, final, timelineText) {
  if (cur.done) return;
  cur.done = true;
  cur.final = final;
  addTimeline(cur, timelineText, cur.finishedAt);
  if (final.code && RECONNECT.has(final.code)) refreshConnection();
  scheduleRender(cur);
}

function addTimeline(cur, text, at) {
  cur.timeline.push({ kind: "note", title: text, at: at ? new Date(at) : new Date(), seq: cur.timeline.length });
  scheduleRender(cur);
}

function scheduleRender(cur) {
  if (cur.raf) return;
  cur.raf = requestAnimationFrame(() => {
    cur.raf = 0;
    if (state.run === cur) renderRun(cur);
  });
}

function renderRun(cur) {
  const live = !cur.done;
  const [label, sub, tone] = live ? RUN_STATE[cur.phase] || RUN_STATE.running : [cur.final.label, cur.final.sub, cur.final.tone];
  const box = $("#run-state");
  box.className = `run-state rs-${tone}`;
  setChildren(box, live ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, h("span", {}, label, h("span", { class: "sub" }, sub)));
  $("#cancel").hidden = !live;
  updateFixButton();

  const n = $("#run-notice");
  n.hidden = !cur.notice;
  n.className = "notice notice-warn";
  n.textContent = cur.notice || "";

  $("#plan-empty").hidden = cur.plan.length > 0;
  setChildren(
    $("#plan"),
    cur.plan.map((e) => h("li", { class: `plan-${e.status}` }, h("span", { class: "check", "aria-hidden": "true" }, e.status === "completed" ? "✓" : e.status === "in_progress" ? "•" : ""), h("span", {}, e.content), h("span", { class: "sr-only" }, ` (${e.status})`))),
  );

  // Agent-side steps from the relay, merged with the calls Bugboard's MCP endpoint received.
  const site = (cur.summary?.toolCalls || []).map((t) => ({ kind: "site", title: t.summary, ok: t.ok, tool: t.tool, at: new Date(t.at) }));
  const items = [...cur.timeline, ...site].map((t, i) => ({ t, i })).sort((a, b) => a.t.at - b.t.at || a.i - b.i).map((x) => x.t);
  setChildren(
    $("#timeline"),
    items.map((t) =>
      h(
        "li",
        { class: t.kind === "site" ? "tl-site" : t.kind === "tool" ? `tl-tool tl-${t.status}` : "tl-note" },
        h("time", {}, timeOf(t.at)),
        h("span", { class: "tl-text" }, t.kind === "tool" ? `${t.toolKind || "tool"}: ${t.title}` : t.kind === "site" ? `${t.tool}: ${t.title}` : t.title),
        t.kind === "tool"
          ? h("span", { class: `pill pill-${t.status}` }, (t.status || "").replace("_", " "))
          : t.kind === "site"
            ? h("span", { class: `pill pill-${t.ok ? "ok" : "error"}` }, t.ok ? "ok" : "error")
            : null,
      ),
    ),
  );

  const out = $("#output");
  if (cur.text) out.replaceChildren(renderMarkdown(cur.text));
  else out.replaceChildren(h("p", { class: "muted" }, cur.done ? "The agent returned no text." : "Your agent's messages will stream in here…"));
}

async function cancelRun() {
  const cur = state.run;
  if (!cur) return;
  $("#cancel").disabled = true;
  cur.phase = "cancelling";
  scheduleRender(cur);
  try {
    await api(`/api/runs/${encodeURIComponent(cur.id)}/cancel`, { method: "POST" });
  } catch (e) {
    cur.notice = friendlyText(e);
    $("#cancel").disabled = false;
    scheduleRender(cur);
  }
}

// ------------------------------------------------------------------ wiring

document.addEventListener("DOMContentLoaded", async () => {
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("#login-name").value);
  });
  for (const b of document.querySelectorAll("#quick-names [data-name]")) b.addEventListener("click", () => login(b.dataset.name));
  $("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => undefined);
    location.hash = "";
    location.reload();
  });
  $("#theme").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable */
    }
  });
  $("#conn-chip").addEventListener("click", () => {
    $("#conn-card").scrollIntoView({ behavior: "smooth", block: "center" });
    flash($("#conn-card"));
  });
  for (const b of document.querySelectorAll("#filters button")) {
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      renderList();
    });
  }
  $("#fix").addEventListener("click", fixIssue);
  $("#cancel").addEventListener("click", cancelRun);
  $("#status-select").addEventListener("change", setStatus);
  $("#comment-form").addEventListener("submit", addComment);
  $("#comment-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment(e);
  });
  window.addEventListener("hashchange", route);
  try {
    const me = await api("/api/me");
    if (me.user) await enterApp(me.user);
    else showSignin();
  } catch {
    showSignin();
  }
});
