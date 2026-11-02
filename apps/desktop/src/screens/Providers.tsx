import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, openExternal, pickFile } from "../lib/api";
import { useBridge } from "../lib/store";
import type { ProviderView } from "../lib/types";
import { ProviderLogo, Spinner, providerBadge } from "../components/ui";

const LINKS: Record<string, string> = {
  open_node_download: "https://nodejs.org/en/download",
  open_codex_install: "https://developers.openai.com/codex/cli",
};

function ProviderDetail({ p }: { p: ProviderView }) {
  const { run } = useBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [key, setKey] = useState("");

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    await run(fn, ok);
    setBusy(null);
  };

  const policyTone = p.policy.remote === "blocked" ? "callout-red" : p.policy.remote === "allowed_with_notice" ? "callout-amber" : "callout-blue";

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="card-pad row" style={{ alignItems: "flex-start" }}>
        <ProviderLogo provider={p} size={44} />
        <div className="grow">
          <div className="row" style={{ gap: 8 }}>
            <span style={{ fontWeight: 650, fontSize: 15 }}>{p.name}</span>
            {providerBadge(p)}
            {!p.verified && <span className="badge badge-amber">Not verified</span>}
          </div>
          <div className="muted small" style={{ marginTop: 2 }}>{p.description}</div>
          <div className="small" style={{ marginTop: 8 }}>{p.statusMessage}</div>
        </div>
      </div>
      <div className="setting-row">
        <dl className="kv grow" style={{ margin: 0 }}>
          {p.cliVersion && (<><dt>Installed</dt><dd className="mono">{p.cliVersion}</dd></>)}
          {p.adapterPinned && (
            <><dt>Connector</dt><dd>{p.adapterVersion ? <span className="mono">{p.adapterVersion}</span> : <span className="faint">not installed</span>} <span className="faint small">(verified version {p.adapterPinned})</span></dd></>
          )}
          <dt>Sign-in</dt>
          <dd>{p.authMode === "subscription" ? `Subscription (${p.authLabel})` : p.authMode === "api_key" ? "API key (billed to your API account)" : p.id === "mock" ? "Not needed" : "Not signed in"}</dd>
        </dl>
      </div>
      <div className="setting-row" style={{ display: "block" }}>
        <div className={`callout ${policyTone}`}>
          {p.policy.remote === "blocked" ? <AlertTriangle size={15} color="var(--red)" /> : p.policy.remote === "allowed" ? <CheckCircle2 size={15} color="var(--green)" /> : <AlertTriangle size={15} color="var(--amber)" />}
          <div>
            <b>Website use: </b>
            {p.policy.remote === "blocked" ? "Not available" : p.policy.remote === "allowed" ? "Available" : "Available with notice"}. {p.policy.note}
          </div>
        </div>
      </div>
      {p.id !== "mock" && (
        <div className="setting-row row-wrap" style={{ gap: 8 }}>
          {p.actions.includes("install_adapter") && (
            <button className={`btn ${p.state === "ready" ? "" : "btn-primary"}`} disabled={!!busy} onClick={() => act("install", () => api.installAdapter(p.id), `${p.name} connector installed`)}>
              {busy === "install" ? <Spinner /> : null}
              {p.state === "ready" ? "Reinstall connector" : p.state === "broken" ? "Repair connector" : "Install connector"}
            </button>
          )}
          {p.actions.includes("sign_in") && (
            <button className="btn btn-primary" disabled={!!busy} onClick={() => act("signin", () => api.signIn(p.id), "Finish signing in in your browser")}>
              Sign in with ChatGPT <ExternalLink size={13} />
            </button>
          )}
          {(p.actions.includes("sign_in_api_key") || p.actions.includes("set_api_key")) && (
            <button className={`btn ${p.actions.includes("set_api_key") ? "btn-primary" : ""}`} onClick={() => setKeyOpen((v) => !v)}>
              <KeyRound size={14} /> Use an API key
            </button>
          )}
          {p.actions.includes("sign_out") && (
            <button className="btn" disabled={!!busy} onClick={() => act("signout", () => api.signOut(p.id), "Signed out")}>Sign out</button>
          )}
          {p.actions.includes("remove_api_key") && (
            <button className="btn btn-danger" disabled={!!busy} onClick={() => act("signout", () => api.signOut(p.id), "API key removed")}>Remove API key</button>
          )}
          {p.actions.includes("remove_custom") && (
            <button className="btn btn-danger" onClick={() => act("rm", () => api.removeCustomAgent(p.id), "Agent removed")}><Trash2 size={14} /> Remove</button>
          )}
          {p.actions.filter((a) => LINKS[a]).map((a) => (
            <button key={a} className="btn btn-primary" onClick={() => void openExternal(LINKS[a])}>
              {a === "open_node_download" ? "Get Node.js" : "Install Codex"} <ExternalLink size={13} />
            </button>
          ))}
        </div>
      )}
      {keyOpen && (
        <div className="setting-row" style={{ display: "block" }}>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy("key");
              const ok = await run(() => api.setApiKey(p.id, key), "API key saved");
              setBusy(null);
              if (ok) {
                setKey("");
                setKeyOpen(false);
              }
            }}
          >
            <input className="input grow" type="password" autoComplete="off" placeholder={p.id === "claude" ? "sk-ant-…" : "sk-…"} value={key} onChange={(e) => setKey(e.target.value)} aria-label="API key" />
            <button className="btn btn-primary" disabled={!key || busy === "key"}>{busy === "key" ? <Spinner /> : "Save"}</button>
          </form>
          <div className="small faint" style={{ marginTop: 6 }}>
            {p.id === "claude"
              ? "Stored in your system keychain and passed only to the local Claude connector. Usage is billed to your Anthropic API account."
              : "Passed directly to the official Codex CLI (codex login --with-api-key). Usage is billed to your OpenAI API account."}
          </div>
        </div>
      )}
    </div>
  );
}

function AddCustomAgent() {
  const { run } = useBridge();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        <Plus size={14} /> Add another ACP agent
      </button>
    );
  return (
    <div className="card card-pad">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Add an ACP-compatible agent</div>
      <div className="callout callout-amber" style={{ margin: "8px 0 14px" }}>
        <AlertTriangle size={15} color="var(--amber)" />
        <div>Only add agents you trust. Custom agents are not verified by Remote ACP Bridge. If the file changes on disk, the agent is blocked until you add it again.</div>
      </div>
      <div className="field">
        <label className="label" htmlFor="ca-name">Name</label>
        <input id="ca-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My agent" />
      </div>
      <div className="field">
        <label className="label" htmlFor="ca-prog">Executable</label>
        <div className="row">
          <input id="ca-prog" className="input mono grow" value={program} onChange={(e) => setProgram(e.target.value)} placeholder="/usr/local/bin/my-acp-agent" />
          <button className="btn" onClick={async () => { const f = await pickFile(); if (f) setProgram(f); }}>Choose…</button>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="ca-args">Arguments</label>
        <input id="ca-args" className="input mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--acp" />
        <div className="help">Separated by spaces. The agent must speak ACP over stdio.</div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!name || !program}
          onClick={async () => {
            if (await run(() => api.addCustomAgent(name, program, args.split(/\s+/).filter(Boolean)), "Agent added")) setOpen(false);
          }}
        >
          Add agent
        </button>
      </div>
    </div>
  );
}

export function Providers() {
  const { snap, run } = useBridge();
  const [checking, setChecking] = useState(false);
  if (!snap) return null;
  return (
    <div className="content-narrow stack" style={{ gap: 14 }}>
      <div className="row">
        <p className="muted grow" style={{ margin: 0 }}>
          Sign-in always happens in the provider's own official tool. Remote ACP Bridge never sees your password or tokens.
        </p>
        <button
          className="btn"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            await run(() => api.refreshProviders());
            setChecking(false);
          }}
        >
          {checking ? <Spinner /> : <RefreshCw size={14} />} Recheck
        </button>
      </div>
      {snap.providers.map((p) => (
        <ProviderDetail key={p.id} p={p} />
      ))}
      <AddCustomAgent />
    </div>
  );
}
