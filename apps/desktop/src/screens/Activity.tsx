import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp, Ban, Brain, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDot, FileText, FolderOpen, Globe,
  Laptop, ListChecks, Pencil, Search, ShieldAlert, ShieldCheck, Sparkles, Square, Terminal, Wrench, XCircle,
} from "lucide-react";
import { api, pickFolder } from "../lib/api";
import { useBridge } from "../lib/store";
import { isTerminal, type PlanEntry, type TaskView, type TranscriptItem } from "../lib/types";
import { Empty, ProviderLogo, Spinner, shortPath, taskStateBadge, timeAgo } from "../components/ui";
import { Markdown } from "../components/Markdown";

type Tool = Extract<TranscriptItem, { type: "tool" }>;
type Block =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tools"; items: Tool[] }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "permission"; title: string; outcome: string | null }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string };

/** Group consecutive tool calls into one timeline card. */
function toBlocks(items: TranscriptItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.type === "tool") {
      const last = out[out.length - 1];
      if (last && last.kind === "tools") last.items.push(it);
      else out.push({ kind: "tools", items: [it] });
      continue;
    }
    switch (it.type) {
      case "user": out.push({ kind: "user", text: it.text }); break;
      case "agent": out.push({ kind: "agent", text: it.text }); break;
      case "thought": out.push({ kind: "thought", text: it.text }); break;
      case "plan": out.push({ kind: "plan", entries: it.entries }); break;
      case "permission": out.push({ kind: "permission", title: it.title, outcome: it.outcome }); break;
      case "notice": out.push({ kind: "notice", text: it.text }); break;
      case "error": out.push({ kind: "error", text: it.text }); break;
    }
  }
  return out;
}

const KIND_ICON: Record<string, typeof Wrench> = {
  read: FileText, edit: Pencil, delete: XCircle, move: Pencil, search: Search, execute: Terminal, think: Brain, fetch: Globe,
};

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={14} color="var(--green)" aria-label="completed" />;
  if (status === "failed") return <XCircle size={14} color="var(--red)" aria-label="failed" />;
  if (status === "in_progress") return <Spinner />;
  return <Circle size={14} className="faint" aria-label="pending" />;
}

function ToolTimeline({ items }: { items: Tool[] }) {
  const [open, setOpen] = useState(items.length <= 4);
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <div className="chat-card">
      <button className="chat-card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Wrench size={14} />
        <span>{items.length === 1 ? "1 step" : `${items.length} steps`}</span>
        <span className="faint small">{done}/{items.length} done</span>
        <span className="grow" />
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="timeline">
          {items.map((t) => {
            const Icon = KIND_ICON[t.kind] ?? Wrench;
            return (
              <div key={t.toolCallId} className="timeline-row" title={`${t.kind} · ${t.status}`}>
                <span className="timeline-icon"><Icon size={13} /></span>
                <span className="t">{t.title}</span>
                <StatusIcon status={t.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="chat-card">
      <div className="chat-card-head static">
        <ListChecks size={14} />
        <span>Plan</span>
        <span className="faint small">{done}/{entries.length}</span>
        <span className="grow" />
        <span className="progress" aria-hidden><span style={{ width: `${entries.length ? (done / entries.length) * 100 : 0}%` }} /></span>
      </div>
      <div className="plan-body">
        {entries.map((e, i) => (
          <div key={i} className={`plan-entry ${e.status === "completed" ? "done" : ""}`}>
            {e.status === "completed" ? <CheckCircle2 size={14} color="var(--green)" /> : e.status === "in_progress" ? <CircleDot size={14} color="var(--accent)" /> : <Circle size={14} className="faint" />}
            <span>{e.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought">
      <button className="thought-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Brain size={13} /> Thinking {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && <div className="thought-body selectable">{text}</div>}
    </div>
  );
}

function SiteSetup({ t }: { t: TaskView }) {
  const [open, setOpen] = useState(false);
  if (!t.instructions && !(t.tools && t.tools.length)) return null;
  return (
    <div className="site-setup">
      <button className="chat-card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Sparkles size={14} color="var(--accent)" />
        <span>Customized by {t.serviceName ?? "the website"}</span>
        <span className="faint small">
          {[t.instructions ? "instructions" : null, t.tools?.length ? `${t.tools.length} tool server${t.tools.length > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")}
        </span>
        <span className="grow" />
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="site-setup-body">
          {t.instructions && (
            <>
              <div className="label">Instructions</div>
              <pre className="selectable">{t.instructions}</pre>
            </>
          )}
          {t.tools && t.tools.length > 0 && (
            <>
              <div className="label">Tools</div>
              <ul className="md-list">{t.tools.map((x) => <li key={x} className="mono small">{x}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Message({ b, t, live }: { b: Block; t: TaskView; live: boolean }) {
  const { snap } = useBridge();
  const provider = snap?.providers.find((p) => p.id === t.providerId);
  switch (b.kind) {
    case "user":
      return (
        <div className="msg-row msg-row-user">
          <div className="msg-meta">{t.source === "remote" ? t.serviceName ?? t.serviceDomain : "You"}</div>
          <div className="bubble-user selectable">{b.text}</div>
        </div>
      );
    case "agent":
      return (
        <div className="msg-row">
          <div className="avatar">{provider ? <ProviderLogo provider={provider} size={26} /> : <Laptop size={16} />}</div>
          <div className="msg-col">
            <div className="msg-meta">{provider?.name ?? t.providerId}</div>
            <div className="bubble-agent"><Markdown text={b.text} streaming={live} /></div>
          </div>
        </div>
      );
    case "thought":
      return <div className="msg-indent"><Thought text={b.text} /></div>;
    case "tools":
      return <div className="msg-indent"><ToolTimeline items={b.items} /></div>;
    case "plan":
      return <div className="msg-indent"><PlanCard entries={b.entries} /></div>;
    case "permission":
      return (
        <div className="msg-indent">
          <div className={`perm-chip ${b.outcome === "allowed" ? "ok" : b.outcome ? "no" : "wait"}`}>
            {b.outcome === "allowed" ? <ShieldCheck size={14} /> : b.outcome ? <Ban size={14} /> : <ShieldAlert size={14} />}
            <span className="t">Permission: {b.title}</span>
            <span className="small">{b.outcome ?? "waiting for you"}</span>
          </div>
        </div>
      );
    case "notice":
      return <div className="notice">{b.text}</div>;
    case "error":
      return <div className="msg-indent"><div className="callout callout-red"><XCircle size={15} color="var(--red)" /><div>{b.text}</div></div></div>;
  }
}

function TaskDetail({ t }: { t: TaskView }) {
  const { run, snap } = useBridge();
  const ref = useRef<HTMLDivElement>(null);
  const live = !isTerminal(t.state);
  const blocks = useMemo(() => toBlocks(t.transcript), [t.transcript]);
  const last = t.transcript[t.transcript.length - 1];
  const lastLen = t.transcript.length * 1_000_000 + (last && "text" in last ? last.text.length : 0);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [lastLen]);
  const provider = snap?.providers.find((p) => p.id === t.providerId);
  const lastBlock = blocks[blocks.length - 1];
  const showTyping = live && t.state === "running" && lastBlock?.kind !== "agent";
  return (
    <div className="card task-detail chat">
      <div className="task-head">
        <div className="site-favicon" aria-hidden>{t.source === "remote" ? (t.serviceDomain ?? "?").slice(0, 1) : <Laptop size={15} />}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b className="ellipsis">{t.source === "remote" ? t.serviceName ?? t.serviceDomain : "This computer"}</b>
            {taskStateBadge(t.state)}
          </div>
          <div className="row small faint" style={{ gap: 10, marginTop: 2 }}>
            <span className="row" style={{ gap: 4 }}>{provider && <ProviderLogo provider={provider} size={14} />}{provider?.name ?? t.providerId}</span>
            <span className="row mono" style={{ gap: 4 }} title={t.workspace}><FolderOpen size={12} />{shortPath(t.workspace)}</span>
            <span>{timeAgo(t.createdAt)}</span>
          </div>
        </div>
        {t.state === "awaiting_approval" && (
          <>
            <button className="btn btn-sm" onClick={() => run(() => api.approveTask(t.id, false))}>Decline</button>
            <button className="btn btn-sm btn-primary" onClick={() => run(() => api.approveTask(t.id, true))}>Allow task</button>
          </>
        )}
        {live && t.state !== "awaiting_approval" && (
          <button className="btn btn-sm btn-danger" onClick={() => run(() => api.cancelTask(t.id))} disabled={t.state === "cancelling"}>
            <Square size={12} /> {t.state === "cancelling" ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      <div className="transcript chat-body" ref={ref} aria-live="polite">
        <SiteSetup t={t} />
        {blocks.map((b, i) => (
          <Message key={i} b={b} t={t} live={live && i === blocks.length - 1 && b.kind === "agent"} />
        ))}
        {showTyping && (
          <div className="msg-row">
            <div className="avatar">{provider ? <ProviderLogo provider={provider} size={26} /> : <Laptop size={16} />}</div>
            <div className="typing" aria-label="Working"><span /><span /><span /></div>
          </div>
        )}
        {t.state === "awaiting_approval" && <div className="notice">Waiting for you to allow this task</div>}
        {!live && t.stopReason && t.stopReason !== "end_turn" && <div className="notice">Stopped ({t.stopReason.replace("_", " ")})</div>}
      </div>
    </div>
  );
}

function LocalComposer({ onStarted }: { onStarted: (id: string) => void }) {
  const { snap, run } = useBridge();
  const ready = (snap?.providers ?? []).filter((p) => p.state === "ready");
  const [provider, setProvider] = useState(ready[0]?.id ?? "");
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!provider && ready[0]) setProvider(ready[0].id);
  }, [ready, provider]);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [prompt]);
  const canSend = !!provider && !!workspace && !!prompt.trim();
  return (
    <form
      className="composer chat-composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSend) return;
        let id = "";
        const ok = await run(async () => {
          id = await api.startLocalTask(provider, workspace, prompt);
        });
        if (ok) {
          setPrompt("");
          onStarted(id);
        }
      }}
    >
      <textarea
        ref={taRef}
        className="composer-input"
        rows={1}
        placeholder="Try your agent locally… (Enter to send, Shift+Enter for a new line)"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }
        }}
      />
      <div className="composer-bar">
        <select className="chip-select" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Agent">
          {ready.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="chip-input">
          <FolderOpen size={13} />
          <input className="mono" placeholder="Project folder" value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Project folder" />
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Choose folder" onClick={async () => { const f = await pickFolder(); if (f) setWorkspace(f); }}>Choose…</button>
        </div>
        <span className="grow" />
        <button className="send-btn" aria-label="Send" disabled={!canSend}><ArrowUp size={16} /></button>
      </div>
    </form>
  );
}

export function Activity() {
  const { snap, focusTaskId, setFocusTaskId } = useBridge();
  const tasks = snap?.tasks ?? [];
  const selected = tasks.find((t) => t.id === focusTaskId) ?? tasks[0];
  return (
    <div className="activity">
      <div className="card task-list" aria-label="Tasks">
        {tasks.length === 0 ? (
          <Empty title="No tasks yet">Tasks from websites and local tests appear here.</Empty>
        ) : (
          tasks.map((t) => (
            <button key={t.id} className="task-item" aria-current={selected?.id === t.id} onClick={() => setFocusTaskId(t.id)}>
              <span className="row" style={{ gap: 8 }}>
                <span className={`dot ${t.state === "running" ? "dot-green dot-pulse" : t.state === "awaiting_approval" ? "dot-amber" : t.state === "failed" ? "dot-red" : ""}`} />
                <span className="small faint grow ellipsis">{t.source === "remote" ? t.serviceDomain : "Local test"}</span>
                {taskStateBadge(t.state)}
              </span>
              <span className="p">{t.prompt || "(no prompt)"}</span>
              <span className="small faint">{timeAgo(t.createdAt)}</span>
            </button>
          ))
        )}
      </div>
      <div className="chat-col">
        {selected ? <TaskDetail t={selected} /> : <div className="card grow"><Empty title="Nothing selected">Choose a task, or try your agent below.</Empty></div>}
        <LocalComposer onStarted={(id) => setFocusTaskId(id)} />
      </div>
    </div>
  );
}
