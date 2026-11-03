import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FolderOpen, Link2, Pause, Play, Plug, ShieldAlert, ShieldCheck, Trash2, Unplug } from "lucide-react";
import { api, pickFolder } from "../lib/api";
import { useBridge } from "../lib/store";
import type { AccessLevel, GrantView, PairingRequestView } from "../lib/types";
import { Empty, ProviderLogo, Segmented, Spinner, Switch, shortPath, timeAgo, timeUntil } from "../components/ui";

export function ConnectWebsiteButton({ small }: { small?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn ${small ? "btn-sm" : "btn-primary"}`} onClick={() => setOpen(true)}>
        <Plug size={small ? 13 : 14} /> Connect a website
      </button>
      {open && <ConnectSheet onClose={() => setOpen(false)} />}
    </>
  );
}

function ConnectSheet({ onClose }: { onClose: () => void }) {
  const { run } = useBridge();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="connect-title">
        <div className="sheet-head">
          <h2 id="connect-title">Connect a website</h2>
          <div className="muted">
            On the website, click <b>Connect desktop agent</b>. Your browser will open this app automatically. You can also paste the link or the code it shows.
          </div>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await run(() => api.beginPairing(value));
            setBusy(false);
            if (ok) onClose();
          }}
        >
          <div className="sheet-body">
            <label className="label" htmlFor="pair-input">Pairing link or code</label>
            <input id="pair-input" autoFocus className="input mono" placeholder="remoteacp://pair?… or ABCDE-12345" value={value} onChange={(e) => setValue(e.target.value)} />
            <div className="small faint" style={{ marginTop: 6 }}>Nothing is shared until you review and approve the request.</div>
          </div>
          <div className="sheet-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!value.trim() || busy}>{busy ? <Spinner /> : null} Continue</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const DURATIONS = [
  { value: String(3600), label: "1 hour" },
  { value: String(86400), label: "24 hours" },
  { value: String(7 * 86400), label: "7 days" },
  { value: String(30 * 86400), label: "30 days" },
];

/** Consent screen for a pending pairing request. Rendered globally. */
export function PairingConsent({ req }: { req: PairingRequestView }) {
  const { snap, run } = useBridge();
  const usable = useMemo(() => (snap?.providers ?? []).filter((p) => p.state === "ready" && p.policy.remote !== "blocked"), [snap?.providers]);
  const blocked = (snap?.providers ?? []).filter((p) => p.state === "ready" && p.policy.remote === "blocked");
  const [provider, setProvider] = useState<string>(snap?.settings.defaultProvider && usable.some((p) => p.id === snap.settings.defaultProvider) ? snap.settings.defaultProvider : usable[0]?.id ?? "");
  const [workspace, setWorkspace] = useState("");
  const [access, setAccess] = useState<AccessLevel>("read_only");
  const [approval, setApproval] = useState(snap?.settings.requireTaskApprovalDefault ?? true);
  const [duration, setDuration] = useState(String(86400));
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(iv);
  }, []);
  useEffect(() => {
    if (!provider && usable[0]) setProvider(usable[0].id);
  }, [usable, provider]);
  const chosen = usable.find((p) => p.id === provider);
  const needsAck = chosen?.policy.remote === "allowed_with_notice";
  const expired = new Date(req.expiresAt).getTime() <= Date.now();

  return (
    <div className="backdrop">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="consent-title" style={{ width: "min(580px,100%)" }}>
        <div className="sheet-head">
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="site-favicon" style={{ width: 40, height: 40, fontSize: 17 }}>{req.service.domain.slice(0, 1)}</div>
            <div className="grow">
              <h2 id="consent-title">{req.service.displayName} wants to connect</h2>
              <div className="row" style={{ gap: 6 }}>
                {req.service.verified ? (
                  <span className="badge badge-green"><ShieldCheck size={12} /> Verified domain</span>
                ) : (
                  <span className="badge badge-red"><ShieldAlert size={12} /> Unverified</span>
                )}
                <span className="mono small">{req.service.origin}</span>
              </div>
            </div>
          </div>
          {!req.service.verified && (
            <div className="callout callout-red" style={{ marginBottom: 6 }}>
              <AlertTriangle size={15} color="var(--red)" />
              <div>The relay could not verify that this request really comes from <b>{req.service.domain}</b>. Only continue if you started this connection yourself on that website.</div>
            </div>
          )}
        </div>
        <div className="sheet-body">
          <dl className="kv" style={{ marginBottom: 16 }}>
            <dt>Requested</dt>
            <dd>Start interactive AI tasks that you can watch here</dd>
            <dt>Website account</dt>
            <dd className="mono small">{req.externalUserId}</dd>
            <dt>Request expires</dt>
            <dd>{timeUntil(req.expiresAt)}</dd>
            {req.scopes.includes("agent.tools") && (
              <>
                <dt>Also requested</dt>
                <dd>Give the agent its own tools (MCP servers on {req.service.domain})</dd>
              </>
            )}
          </dl>

          <div className="field">
            <label className="label">AI provider</label>
            {usable.length === 0 ? (
              <div className="callout callout-amber"><AlertTriangle size={15} color="var(--amber)" /><div>No AI provider is ready for website use. Set one up in AI Providers first.{blocked.length > 0 && ` (${blocked.map((b) => b.name).join(", ")} can't be used for websites with the current sign-in.)`}</div></div>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {usable.map((p) => (
                  <label key={p.id} className="row card" style={{ padding: "8px 12px", borderColor: provider === p.id ? "var(--accent)" : undefined }}>
                    <input type="radio" name="provider" checked={provider === p.id} onChange={() => { setProvider(p.id); setAck(false); }} />
                    <ProviderLogo provider={p} size={26} />
                    <div className="grow">
                      <div style={{ fontWeight: 550 }}>{p.name}</div>
                      <div className="small faint">{p.authLabel ? `Signed in · ${p.authLabel}` : p.statusMessage}</div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="field">
            <label className="label" htmlFor="ws">Project folder</label>
            <div className="row">
              <input id="ws" className="input mono grow" placeholder="Choose the only folder the agent may use" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
              <button className="btn" onClick={async () => { const f = await pickFolder(); if (f) setWorkspace(f); }}><FolderOpen size={14} /> Choose…</button>
            </div>
            <div className="help">The agent can't read or change files outside this folder through the bridge.</div>
          </div>

          <div className="field row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <div className="label">What the agent may do</div>
              <div className="help" style={{ marginTop: 0 }}>{access === "read_only" ? "Read files. Asks you before any change or network access." : "Edit files in this folder. Asks you before anything else."}</div>
            </div>
            <Segmented<AccessLevel> label="Access" value={access} onChange={setAccess} options={[{ value: "read_only", label: "Read only" }, { value: "workspace_write", label: "Can edit" }]} />
          </div>

          <div className="field row">
            <div className="grow">
              <div className="label">Ask me before each task</div>
              <div className="help" style={{ marginTop: 0 }}>Recommended. You'll see each request before it starts.</div>
            </div>
            <Switch label="Ask before each task" checked={approval} onChange={setApproval} />
          </div>

          <div className="field row">
            <div className="grow"><div className="label">Allow for</div></div>
            <select className="select" style={{ width: 140 }} value={duration} onChange={(e) => setDuration(e.target.value)} aria-label="Duration">
              {DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>

          {needsAck && chosen && (
            <label className="callout callout-amber" style={{ cursor: "default" }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
              <div>{chosen.policy.note}</div>
            </label>
          )}
        </div>
        <div className="sheet-foot">
          <button className="btn" disabled={!!busy} onClick={async () => { setBusy("reject"); await run(() => api.rejectPairing(req.pairingId), "Request declined"); setBusy(null); }}>
            Decline
          </button>
          <button
            className="btn btn-primary"
            disabled={!!busy || expired || !provider || !workspace.trim() || (needsAck && !ack)}
            onClick={async () => {
              setBusy("accept");
              await run(
                () => api.acceptPairing(req.pairingId, { providerId: provider, workspace, access, requireTaskApproval: approval, durationSecs: Number(duration), acknowledgeTerms: ack }),
                `${req.service.displayName} connected`,
              );
              setBusy(null);
            }}
          >
            {busy === "accept" ? <Spinner /> : null}
            {expired ? "Request expired" : "Allow connection"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GrantCard({ g }: { g: GrantView }) {
  const { run, snap } = useBridge();
  const [confirm, setConfirm] = useState(false);
  const provider = snap?.providers.find((p) => p.id === g.providerId);
  const revoked = g.status === "revoked";
  const dead = revoked || g.expired;
  return (
    <div className="card" style={{ opacity: dead ? 0.75 : 1 }}>
      <div className="card-pad row">
        <div className="site-favicon" style={{ width: 38, height: 38 }}>{(g.service?.domain ?? "?").slice(0, 1)}</div>
        <div className="grow">
          <div className="row" style={{ gap: 6 }}>
            <span style={{ fontWeight: 650 }}>{g.service?.displayName ?? g.service?.domain ?? "Website"}</span>
            {g.service?.verified ? <span className="badge badge-green"><ShieldCheck size={12} /> Verified</span> : <span className="badge badge-amber">Unverified</span>}
            {revoked ? <span className="badge">Disconnected</span> : g.expired ? <span className="badge">Expired</span> : g.status === "paused" ? <span className="badge badge-amber">Paused</span> : g.busy ? <span className="badge badge-blue">Working</span> : <span className="badge badge-green">Connected</span>}
          </div>
          <div className="small faint mono">{g.service?.origin}</div>
        </div>
        {!dead && (
          <div className="row">
            <button className="btn btn-sm" onClick={() => run(() => api.setGrantPaused(g.connectionId, g.status !== "paused"), g.status === "paused" ? "Connection resumed" : "Connection paused")}>
              {g.status === "paused" ? <Play size={13} /> : <Pause size={13} />} {g.status === "paused" ? "Resume" : "Pause"}
            </button>
            {confirm ? (
              <button className="btn btn-sm btn-danger-solid" onClick={() => run(() => api.revokeGrant(g.connectionId), "Website disconnected")}>Confirm disconnect</button>
            ) : (
              <button className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}><Unplug size={13} /> Disconnect</button>
            )}
          </div>
        )}
        {dead && (
          <button className="btn btn-sm btn-ghost" onClick={() => run(() => api.forgetGrant(g.connectionId))} aria-label="Remove from list"><Trash2 size={13} /> Remove</button>
        )}
      </div>
      <div className="setting-row">
        <dl className="kv grow" style={{ margin: 0 }}>
          <dt>AI provider</dt>
          <dd className="row" style={{ gap: 6 }}>{provider && <ProviderLogo provider={provider} size={18} />}{provider?.name ?? g.providerId}</dd>
          <dt>Project folder</dt>
          <dd className="mono small" title={g.workspace}>{shortPath(g.workspace)}</dd>
          <dt>Website account</dt>
          <dd className="mono small">{g.externalUserId}</dd>
          <dt>Last active</dt>
          <dd>{timeAgo(g.lastActiveAt)}</dd>
          <dt>{g.expired ? "Expired" : "Expires"}</dt>
          <dd>{g.expired ? new Date(g.expiresAt).toLocaleString() : timeUntil(g.expiresAt)}</dd>
        </dl>
      </div>
      {!dead && (
        <>
          <div className="setting-row">
            <div className="text">
              <div className="title">Ask before each task</div>
              <div className="desc">Every request from this website waits for your OK.</div>
            </div>
            <Switch label="Ask before each task" checked={g.requireTaskApproval} onChange={(v) => run(() => api.updateGrant(g.connectionId, v, g.access))} />
          </div>
          <div className="setting-row">
            <div className="text">
              <div className="title">Agent access</div>
              <div className="desc">{g.access === "read_only" ? "Read only; asks before changes" : "Can edit files in the project folder"}</div>
            </div>
            <Segmented<AccessLevel> label="Access" value={g.access} onChange={(v) => run(() => api.updateGrant(g.connectionId, g.requireTaskApproval, v))} options={[{ value: "read_only", label: "Read only" }, { value: "workspace_write", label: "Can edit" }]} />
          </div>
        </>
      )}
    </div>
  );
}

export function Websites() {
  const { snap, run } = useBridge();
  if (!snap) return null;
  const live = snap.grants.filter((g) => g.status !== "revoked" && !g.expired);
  const old = snap.grants.filter((g) => g.status === "revoked" || g.expired);
  return (
    <div className="content-narrow stack" style={{ gap: 14 }}>
      <div className="row">
        <p className="muted grow" style={{ margin: 0 }}>Websites you allowed to start AI tasks on this computer.</p>
        <ConnectWebsiteButton />
      </div>
      {live.length === 0 ? (
        <div className="card">
          <Empty title="No websites connected">
            <Link2 size={14} style={{ verticalAlign: -2 }} /> Click “Connect desktop agent” on a website that supports Remote ACP Bridge.
          </Empty>
        </div>
      ) : (
        live.map((g) => <GrantCard key={g.connectionId} g={g} />)
      )}
      {live.length > 1 && (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-danger" onClick={() => run(() => api.revokeAll(), "All websites disconnected")}>Disconnect all</button>
        </div>
      )}
      {old.length > 0 && (
        <div className="section">
          <div className="section-head"><h2>Previously connected</h2></div>
          <div className="stack">{old.map((g) => <GrantCard key={g.connectionId} g={g} />)}</div>
        </div>
      )}
    </div>
  );
}
