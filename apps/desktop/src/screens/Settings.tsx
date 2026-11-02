import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { api, openExternal } from "../lib/api";
import { useBridge } from "../lib/store";
import type { Diagnostics as Diag, Settings as S } from "../lib/types";
import { Segmented, Spinner, Switch, relayLabel } from "../components/ui";

export function Settings() {
  const { snap, run, navigate } = useBridge();
  const [relay, setRelay] = useState(snap?.settings.relayUrl ?? "");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  useEffect(() => setRelay(snap?.settings.relayUrl ?? ""), [snap?.settings.relayUrl]);
  if (!snap) return null;
  const s = snap.settings;
  const save = (patch: Partial<S>, msg?: string) => run(() => api.updateSettings({ ...s, ...patch }), msg);
  const ready = snap.providers.filter((p) => p.state === "ready");

  return (
    <div className="content-narrow stack" style={{ gap: 18 }}>
      <section>
        <div className="section-head"><h2>General</h2></div>
        <div className="card">
          <div className="setting-row">
            <div className="text"><div className="title">Launch at login</div><div className="desc">Start Remote ACP Bridge when you sign in to this computer.</div></div>
            <Switch label="Launch at login" checked={s.launchAtLogin} onChange={(v) => save({ launchAtLogin: v })} />
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Keep running when the window is closed</div><div className="desc">Websites can only reach your agent while the app runs. Use the menu bar icon to quit.</div></div>
            <Switch label="Keep running in menu bar" checked={s.keepInTray} onChange={(v) => save({ keepInTray: v })} />
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Notifications</div><div className="desc">Notify me about connection requests, task requests and permission prompts.</div></div>
            <Switch label="Notifications" checked={s.notifications} onChange={(v) => save({ notifications: v })} />
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Appearance</div></div>
            <Segmented label="Theme" value={s.theme} onChange={(v) => save({ theme: v })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          </div>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Agents</h2></div>
        <div className="card">
          <div className="setting-row">
            <div className="text"><div className="title">Default AI provider</div><div className="desc">Pre-selected when a website asks to connect.</div></div>
            <select className="select" style={{ width: 180 }} value={s.defaultProvider ?? ""} onChange={(e) => save({ defaultProvider: e.target.value || null })} aria-label="Default provider">
              <option value="">Ask each time</option>
              {ready.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Ask before each task (new connections)</div><div className="desc">Default for new websites. You can change it per website.</div></div>
            <Switch label="Ask before each task by default" checked={s.requireTaskApprovalDefault} onChange={(v) => save({ requireTaskApprovalDefault: v })} />
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Stop idle agents after</div><div className="desc">Agent processes are closed when a website has been inactive this long.</div></div>
            <select className="select" style={{ width: 120 }} value={s.sessionIdleMinutes} onChange={(e) => save({ sessionIdleMinutes: Number(e.target.value) })} aria-label="Idle timeout">
              {[5, 15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </div>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Relay</h2><span className="hint">{relayLabel(snap.bridge.relay, false).text}</span></div>
        <div className="card">
          <div className="setting-row" style={{ display: "block" }}>
            <label className="label" htmlFor="relay">Relay address</label>
            <form className="row" onSubmit={(e) => { e.preventDefault(); void save({ relayUrl: relay.trim() }, "Relay updated"); }}>
              <input id="relay" className="input mono grow" value={relay} onChange={(e) => setRelay(e.target.value)} />
              <button className="btn" disabled={relay.trim() === s.relayUrl}>Save</button>
            </form>
            <div className="small faint" style={{ marginTop: 6 }}>
              The app only makes outbound connections to this relay. Use your organization's relay or run your own (see Help). Plain http is only allowed for localhost.
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Security</h2></div>
        <div className="card">
          <div className="setting-row">
            <div className="text"><div className="title">Pause the bridge</div><div className="desc">Stops running tasks and refuses new ones until you resume.</div></div>
            <Switch label="Bridge paused" checked={snap.bridge.paused} onChange={(v) => run(() => api.setPaused(v))} />
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Disconnect all websites</div><div className="desc">Revokes every connection immediately. Websites must ask again.</div></div>
            {confirmRevoke ? (
              <button className="btn btn-danger-solid" onClick={async () => { await run(() => api.revokeAll(), "All websites disconnected"); setConfirmRevoke(false); }}>Confirm</button>
            ) : (
              <button className="btn btn-danger" onClick={() => setConfirmRevoke(true)}>Disconnect all</button>
            )}
          </div>
          <div className="setting-row">
            <div className="text"><div className="title">Diagnostics</div><div className="desc">Connection health, agent versions and the audit log.</div></div>
            <button className="btn" onClick={() => navigate("diagnostics")}>Open</button>
          </div>
        </div>
      </section>

      <section>
        <div className="section-head"><h2>About</h2></div>
        <div className="card card-pad small muted">
          Remote ACP Bridge connects AI agents on your computer to websites you approve, using the Agent Client Protocol (ACP) locally. Provider sign-in always uses the provider's own tools; your credentials never pass through the bridge or the relay. Conversations are not stored.
        </div>
      </section>
    </div>
  );
}

export function Diagnostics() {
  const { run, toast } = useBridge();
  const [d, setD] = useState<Diag | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setD(await api.diagnostics());
    } catch (e) {
      toast("error", String((e as Error).message));
    }
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);
  if (!d) return <div className="row muted"><Spinner /> Loading diagnostics…</div>;
  const json = JSON.stringify(d, null, 2);
  return (
    <div className="content-narrow stack" style={{ gap: 16 }}>
      <div className="row">
        <p className="muted grow" style={{ margin: 0 }}>For troubleshooting. Contains no tokens, prompts or file contents.</p>
        <button className="btn" onClick={() => void load()} disabled={loading}>{loading ? <Spinner /> : <RefreshCw size={14} />} Refresh</button>
        <button className="btn" onClick={async () => { await navigator.clipboard.writeText(json); toast("success", "Diagnostics copied"); }}><Copy size={14} /> Copy report</button>
        <button className="btn btn-danger" onClick={async () => { await run(() => api.clearDiagnostics(), "Diagnostics cleared"); void load(); }}><Trash2 size={14} /> Clear</button>
      </div>
      {!d.secretBackendSecure && (
        <div className="callout callout-amber"><AlertTriangle size={15} color="var(--amber)" /><div>No system keychain is available. The relay credential is kept in memory only and this computer will re-register after restart.</div></div>
      )}
      <div className="card">
        <div className="setting-row"><dl className="kv grow" style={{ margin: 0 }}>
          <dt>App</dt><dd className="mono">{d.appVersion} · {d.os}/{d.arch}</dd>
          <dt>Relay</dt><dd className="mono">{d.relayUrl} · {d.relay.state}{d.relay.state === "connected" && d.relay.latencyMs != null ? ` · ${d.relay.latencyMs} ms` : ""}</dd>
          <dt>Desktop id</dt><dd className="mono">{d.desktopId ?? "not registered"}</dd>
          <dt>Secret storage</dt><dd>{d.secretBackend}</dd>
          <dt>Protocols</dt><dd className="mono">bridge v{d.bridgeProtocolVersion} · ACP v{d.acpProtocolVersion}</dd>
        </dl></div>
      </div>
      <section>
        <div className="section-head"><h2>Providers</h2></div>
        <div className="card">
          {d.providers.map((p) => (
            <div className="setting-row" key={p.id}>
              <dl className="kv grow" style={{ margin: 0 }}>
                <dt>{p.name}</dt><dd className="mono small">{p.state} · cli {p.cliVersion ?? "–"} · adapter {p.adapterVersion ?? "–"}{p.adapterPinned ? ` (pinned ${p.adapterPinned})` : ""} · auth {p.authMode}</dd>
                {p.cliPath && (<><dt>Path</dt><dd className="mono small">{p.cliPath}</dd></>)}
              </dl>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="section-head"><h2>Agent sessions</h2><span className="hint">{d.sessions.length} running</span></div>
        <div className="card">
          {d.sessions.length === 0 && <div className="setting-row faint small">No agent processes running.</div>}
          {d.sessions.map((s) => (
            <div className="setting-row" key={s.key} style={{ display: "block" }}>
              <dl className="kv" style={{ margin: 0 }}>
                <dt>Agent</dt><dd className="mono small">{s.agentName} {s.agentVersion} · ACP v{s.protocolVersion} · {s.alive ? "running" : "exited"}</dd>
                <dt>Mode</dt><dd className="small">{s.currentMode ?? "–"} {s.sandboxEnforced ? <span className="badge badge-green">restricted</span> : <span className="badge badge-amber">agent default</span>} <span className="faint">available: {s.modes.join(", ") || "none"}</span></dd>
                <dt>Auth methods</dt><dd className="mono small">{s.authMethods.join(", ") || "–"}</dd>
              </dl>
              {s.stderrTail.length > 0 && <pre className="mono small selectable" style={{ maxHeight: 140, overflow: "auto", background: "var(--surface-2)", padding: 8, borderRadius: 6 }}>{s.stderrTail.join("\n")}</pre>}
            </div>
          ))}
        </div>
      </section>
      {d.recentErrors.length > 0 && (
        <section>
          <div className="section-head"><h2>Recent errors</h2></div>
          <div className="card card-pad"><pre className="mono small selectable" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{d.recentErrors.join("\n")}</pre></div>
        </section>
      )}
      <section>
        <div className="section-head"><h2>Audit log</h2><span className="hint">Who connected, what ran, what was allowed</span></div>
        <div className="card" style={{ overflow: "auto" }}>
          <table className="log">
            <thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead>
            <tbody>
              {d.audit.map((a) => (
                <tr key={a.id}>
                  <td className="faint" style={{ whiteSpace: "nowrap" }}>{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="mono">{a.eventType}</td>
                  <td className="mono faint selectable" style={{ wordBreak: "break-all" }}>{a.metadata && Object.keys(a.metadata as object).length ? JSON.stringify(a.metadata) : ""}{a.connectionId ? ` ${a.connectionId}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function Help() {
  return (
    <div className="content-narrow stack" style={{ gap: 14 }}>
      <div className="card card-pad stack">
        <b>How it works</b>
        <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Set up an AI provider (Codex or Claude Code) using its official sign-in.</li>
          <li>On a website that supports Remote ACP Bridge, click <b>Connect desktop agent</b> and approve the request here.</li>
          <li>When the website starts a task, you see it live here. You can stop it or disconnect at any time.</li>
        </ol>
      </div>
      <div className="card card-pad stack">
        <b>What websites can and can't do</b>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>They can send prompts to the agent you chose and see its replies and progress.</li>
          <li>They can't run commands, read files outside the project folder, see your provider sign-in, or approve permission prompts.</li>
          <li>The app must be running for websites to reach your agent.</li>
        </ul>
      </div>
      <div className="card card-pad stack">
        <b>Provider rules</b>
        <div className="muted small">
          Claude subscription sign-in can't be used for website connections under Anthropic's terms; use an Anthropic API key instead. Codex website tasks use your ChatGPT plan's limits when you sign in with ChatGPT.
        </div>
      </div>
      <div className="row">
        <button className="btn" onClick={() => void openExternal("https://agentclientprotocol.com")}>About ACP <ExternalLink size={13} /></button>
      </div>
    </div>
  );
}
