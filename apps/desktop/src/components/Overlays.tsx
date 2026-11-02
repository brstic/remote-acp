import { useState } from "react";
import { AlertCircle, CheckCircle2, Info, ShieldQuestion, X } from "lucide-react";
import { api } from "../lib/api";
import { useBridge } from "../lib/store";
import { PairingConsent } from "../screens/Websites";
import { Spinner } from "./ui";

/** Floating tray for anything that needs the user's decision right now. */
export function DecisionTray() {
  const { snap, run, navigate, setFocusTaskId } = useBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState<string | null>(null);
  if (!snap) return null;
  const approvals = snap.tasks.filter((t) => t.state === "awaiting_approval");
  const perms = snap.permissions;
  if (!approvals.length && !perms.length) return null;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    await run(fn);
    setBusy(null);
  };

  return (
    <div className="tray" role="region" aria-label="Requests waiting for you">
      {approvals.map((t) => (
        <div key={t.id} className="tray-card">
          <div className="h"><ShieldQuestion size={16} color="var(--accent)" /> {t.serviceName ?? t.serviceDomain} wants to start a task</div>
          <div className="small muted" style={{ margin: "6px 0 2px" }}>Prompt from the website:</div>
          <pre className="selectable">{t.prompt}</pre>
          <div className="small faint" style={{ marginTop: 6 }}>Runs with {t.providerId} in {t.workspace.split(/[\\/]/).pop()}</div>
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button className="btn btn-sm btn-ghost" onClick={() => { setFocusTaskId(t.id); navigate("activity"); }}>View</button>
            <button className="btn btn-sm" disabled={!!busy} onClick={() => act(t.id + "n", () => api.approveTask(t.id, false))}>Decline</button>
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(t.id + "y", () => api.approveTask(t.id, true))}>
              {busy === t.id + "y" ? <Spinner /> : null} Allow task
            </button>
          </div>
        </div>
      ))}
      {perms.map((p) => (
        <div key={p.requestId} className="tray-card" style={{ borderColor: "var(--amber)" }}>
          <div className="h"><AlertCircle size={16} color="var(--amber)" /> Permission needed</div>
          <div style={{ margin: "6px 0" }}>{p.title}</div>
          <div className="small faint">
            Requested by the agent during a task{p.serviceName ? ` from ${p.serviceName}` : ""}. The website cannot answer this for you.
          </div>
          {p.details && (
            <>
              <button className="btn btn-sm btn-ghost" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => setShowDetails(showDetails === p.requestId ? null : p.requestId)}>
                {showDetails === p.requestId ? "Hide details" : "Show details"}
              </button>
              {showDetails === p.requestId && <pre className="selectable mono">{p.details}</pre>}
            </>
          )}
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
            <button className="btn btn-sm" disabled={!!busy} onClick={() => act(p.requestId, () => api.respondPermission(p.requestId, "deny"))}>Deny</button>
            {p.canAllowForTask && (
              <button className="btn btn-sm" disabled={!!busy} onClick={() => act(p.requestId, () => api.respondPermission(p.requestId, "allow_task"))}>Allow for this task</button>
            )}
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act(p.requestId, () => api.respondPermission(p.requestId, "allow_once"))}>Allow once</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PairingOverlay() {
  const { snap } = useBridge();
  const req = snap?.pairingRequests[0];
  if (!req) return null;
  return <PairingConsent key={req.pairingId} req={req} />;
}

export function Toasts() {
  const { toasts, dismissToast } = useBridge();
  return (
    <div className="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "toast-error" : ""}`} role={t.kind === "error" ? "alert" : "status"}>
          {t.kind === "error" ? <AlertCircle size={15} /> : t.kind === "success" ? <CheckCircle2 size={15} /> : <Info size={15} />}
          <span className="grow selectable">{t.text}</span>
          <button className="btn btn-ghost btn-sm btn-icon" style={{ color: "inherit", height: 20, width: 20 }} aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
