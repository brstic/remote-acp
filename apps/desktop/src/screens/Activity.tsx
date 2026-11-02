import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, Circle, CircleDot, FolderOpen, Send, Square, Wrench, XCircle } from "lucide-react";
import { api, pickFolder } from "../lib/api";
import { useBridge } from "../lib/store";
import { isTerminal, type TaskView, type TranscriptItem } from "../lib/types";
import { Empty, Spinner, shortPath, taskStateBadge, timeAgo } from "../components/ui";

function ToolStatus({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={14} color="var(--green)" />;
  if (status === "failed") return <XCircle size={14} color="var(--red)" />;
  if (status === "in_progress") return <Spinner />;
  return <Circle size={14} className="faint" />;
}

function Item({ item, live }: { item: TranscriptItem; live: boolean }) {
  switch (item.type) {
    case "user":
      return <div className="msg-user selectable">{item.text}</div>;
    case "agent":
      return <div className={`msg-agent selectable ${live ? "cursor" : ""}`}>{item.text}</div>;
    case "thought":
      return <div className="msg-thought selectable">{item.text}</div>;
    case "tool":
      return (
        <div className="tool" title={`${item.kind} · ${item.status}`}>
          <Wrench size={13} className="faint" />
          <span className="t">{item.title}</span>
          <ToolStatus status={item.status} />
        </div>
      );
    case "plan":
      return (
        <div className="plan">
          <div className="small faint" style={{ marginBottom: 4, fontWeight: 600 }}>Plan</div>
          {item.entries.map((e, i) => (
            <div key={i} className={`plan-entry ${e.status === "completed" ? "done" : ""}`}>
              {e.status === "completed" ? <CheckCircle2 size={14} color="var(--green)" /> : e.status === "in_progress" ? <CircleDot size={14} color="var(--accent)" /> : <Circle size={14} className="faint" />}
              <span>{e.content}</span>
            </div>
          ))}
        </div>
      );
    case "permission":
      return (
        <div className="tool" style={{ borderColor: item.outcome ? undefined : "var(--amber)" }}>
          {item.outcome === "allowed" ? <CheckCircle2 size={14} color="var(--green)" /> : item.outcome ? <Ban size={14} color="var(--red)" /> : <Spinner />}
          <span className="t">Permission: {item.title}</span>
          <span className="small faint">{item.outcome ?? "waiting for you"}</span>
        </div>
      );
    case "notice":
      return <div className="notice">{item.text}</div>;
    case "error":
      return <div className="callout callout-red"><XCircle size={15} color="var(--red)" /><div>{item.text}</div></div>;
  }
}

function TaskDetail({ t }: { t: TaskView }) {
  const { run } = useBridge();
  const ref = useRef<HTMLDivElement>(null);
  const live = !isTerminal(t.state);
  const last = t.transcript[t.transcript.length - 1];
  const lastLen = t.transcript.length * 1_000_000 + (last && "text" in last ? last.text.length : 0);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [lastLen]);
  return (
    <div className="card task-detail" style={{ flex: 1 }}>
      <div className="task-head">
        <div className="grow">
          <div className="row" style={{ gap: 8 }}>
            <b>{t.source === "remote" ? t.serviceName ?? t.serviceDomain : "This computer"}</b>
            {taskStateBadge(t.state)}
          </div>
          <div className="small faint mono" title={t.workspace}>{t.providerId} · {shortPath(t.workspace)}</div>
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
      <div className="transcript" ref={ref} aria-live="polite">
        {t.transcript.map((item, i) => (
          <Item key={i} item={item} live={live && i === t.transcript.length - 1 && item.type === "agent"} />
        ))}
        {live && t.state === "running" && t.transcript[t.transcript.length - 1]?.type !== "agent" && (
          <div className="row faint small"><Spinner /> Working…</div>
        )}
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
  useEffect(() => {
    if (!provider && ready[0]) setProvider(ready[0].id);
  }, [ready, provider]);
  return (
    <form
      className="composer"
      onSubmit={async (e) => {
        e.preventDefault();
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
      <div className="grow stack" style={{ gap: 6 }}>
        <div className="row">
          <select className="select" style={{ width: 150 }} value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Agent">
            {ready.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input mono grow" placeholder="Project folder" value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Project folder" />
          <button type="button" className="btn btn-icon" aria-label="Choose folder" onClick={async () => { const f = await pickFolder(); if (f) setWorkspace(f); }}><FolderOpen size={14} /></button>
        </div>
        <textarea
          className="textarea"
          rows={2}
          placeholder="Try your agent locally… (Enter to send)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }
          }}
        />
      </div>
      <button className="btn btn-primary btn-icon" style={{ height: 36, width: 36 }} aria-label="Send" disabled={!provider || !workspace || !prompt.trim()}>
        <Send size={15} />
      </button>
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
              <span className="row" style={{ gap: 6 }}>
                <span className="small faint grow ellipsis">{t.source === "remote" ? t.serviceDomain : "Local test"}</span>
                {taskStateBadge(t.state)}
              </span>
              <span className="p">{t.prompt || "(no prompt)"}</span>
              <span className="small faint">{timeAgo(t.createdAt)}</span>
            </button>
          ))
        )}
      </div>
      <div className="stack" style={{ minHeight: 0, gap: 0 }}>
        {selected ? <TaskDetail t={selected} /> : <div className="card grow"><Empty title="Nothing selected">Choose a task, or try your agent below.</Empty></div>}
        <div className="card" style={{ marginTop: 12 }}>
          <LocalComposer onStarted={(id) => setFocusTaskId(id)} />
        </div>
      </div>
    </div>
  );
}
