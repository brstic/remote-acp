import { Activity, Globe, Pause, Play, Plus, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { useBridge } from "../lib/store";
import { Empty, ProviderLogo, providerBadge, relayLabel, timeAgo } from "../components/ui";
import { ConnectWebsiteButton } from "./Websites";

export function Overview() {
  const { snap, run, navigate, setFocusTaskId } = useBridge();
  if (!snap) return null;
  const { bridge } = snap;
  const status = relayLabel(bridge.relay, bridge.paused);
  const providers = snap.providers.filter((p) => p.id !== "mock" || p.state === "ready");
  const grants = snap.grants.filter((g) => g.status !== "revoked" && !g.expired);
  const active = snap.tasks.find((t) => !["completed", "cancelled", "failed", "rejected", "expired"].includes(t.state));
  const activityText =
    bridge.activity === "waiting_for_approval" ? "Waiting for your approval" : bridge.activity === "working" ? "An agent is working" : "Idle";

  return (
    <div className="content-narrow">
      <div className="card hero">
        <div className="hero-icon" style={{ background: bridge.paused ? "var(--amber-soft)" : bridge.relay.state === "connected" ? "var(--green-soft)" : "var(--red-soft)" }}>
          <span className={`dot ${status.dot}`} style={{ width: 12, height: 12 }} />
        </div>
        <div className="grow">
          <div className="state">{status.text}</div>
          <div className="sub">{status.sub}</div>
        </div>
        <div className="row">
          {bridge.relay.state === "connected" && bridge.relay.latencyMs != null && (
            <span className="badge" title="Round-trip to relay, measured on this computer">{bridge.relay.latencyMs} ms</span>
          )}
          <button
            className="btn"
            onClick={() => run(() => api.setPaused(!bridge.paused), bridge.paused ? "Bridge resumed" : "Bridge paused. Running tasks were stopped.")}
          >
            {bridge.paused ? <Play size={14} /> : <Pause size={14} />}
            {bridge.paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>AI providers</h2>
          <span className="hint">The agents on this computer</span>
          <button className="btn btn-ghost btn-sm right" onClick={() => navigate("providers")}>Manage</button>
        </div>
        <div className="grid-2">
          {providers.map((p) => (
            <div key={p.id} className="card provider-card">
              <div className="row">
                <ProviderLogo provider={p} />
                <div className="grow">
                  <div className="name">{p.name}</div>
                  <div className="small faint ellipsis">{p.state === "ready" && p.authLabel ? `Signed in · ${p.authLabel}` : p.statusMessage}</div>
                </div>
                {providerBadge(p)}
              </div>
              <div className="actions">
                {p.state === "ready" ? (
                  <button className="btn btn-sm" onClick={() => navigate("providers")}>Manage</button>
                ) : (
                  <button className="btn btn-sm btn-primary" onClick={() => navigate("providers")}>
                    {p.actions.includes("sign_in") || p.actions.includes("set_api_key") ? "Sign in" : p.actions.includes("install_adapter") ? "Set up" : "Details"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Connected websites</h2>
          <span className="hint">{grants.length ? `${grants.length} connected` : "None yet"}</span>
          <div className="right"><ConnectWebsiteButton small /></div>
        </div>
        <div className="card">
          {grants.length === 0 ? (
            <Empty title="No websites connected" action={<ConnectWebsiteButton />}>
              When a website offers “Connect desktop agent”, click it and approve the request here.
            </Empty>
          ) : (
            grants.map((g) => (
              <button key={g.connectionId} className="site" style={{ width: "100%", border: 0, background: "none", textAlign: "left" }} onClick={() => navigate("websites")}>
                <div className="site-favicon">{(g.service?.domain ?? "?").slice(0, 1)}</div>
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <span style={{ fontWeight: 600 }}>{g.service?.displayName ?? g.service?.domain}</span>
                    {g.service?.verified ? <ShieldCheck size={13} color="var(--green)" aria-label="Verified" /> : <span className="badge badge-amber">Unverified</span>}
                  </div>
                  <div className="small faint">{g.service?.domain} · last active {timeAgo(g.lastActiveAt)}</div>
                </div>
                {g.busy ? <span className="badge badge-blue">Working</span> : g.status === "paused" ? <span className="badge badge-amber">Paused</span> : <span className="dot dot-green" />}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>Activity</h2>
          <span className="hint">{activityText}</span>
        </div>
        <div className="card card-pad row">
          <Activity size={16} className="faint" />
          <div className="grow">
            {active ? (
              <span>
                <b>{active.serviceName ?? "This computer"}</b>: {active.prompt.slice(0, 90)}
              </span>
            ) : (
              <span className="muted">No tasks running.</span>
            )}
          </div>
          <button
            className="btn btn-sm"
            onClick={() => {
              if (active) setFocusTaskId(active.id);
              navigate("activity");
            }}
          >
            {active ? "Open" : "View activity"}
          </button>
        </div>
      </div>

      <p className="small faint" style={{ marginTop: 26, display: "flex", gap: 6, alignItems: "center" }}>
        <Globe size={13} /> Everything runs on your computer. You approve what websites can access.
      </p>
      {grants.length === 0 && providers.every((p) => p.state !== "ready") && (
        <div className="callout callout-blue" style={{ marginTop: 10 }}>
          <Plus size={15} />
          <div>Start by setting up an AI provider, then connect a website.</div>
        </div>
      )}
    </div>
  );
}
