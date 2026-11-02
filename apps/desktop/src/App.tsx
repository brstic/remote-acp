import { useEffect, useState } from "react";
import { Activity as ActivityIcon, Bot, Globe, HelpCircle, LayoutGrid, Settings as SettingsIcon } from "lucide-react";
import { BridgeProvider, useBridge, type Route } from "./lib/store";
import { Overview } from "./screens/Overview";
import { Providers } from "./screens/Providers";
import { Websites, ConnectWebsiteButton } from "./screens/Websites";
import { Activity } from "./screens/Activity";
import { Diagnostics, Help, Settings } from "./screens/Settings";
import { DecisionTray, PairingOverlay, Toasts } from "./components/Overlays";
import { ProviderLogo, Spinner, providerBadge, relayLabel } from "./components/ui";

const NAV: { id: Route; label: string; icon: typeof Globe }[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "providers", label: "AI Providers", icon: Bot },
  { id: "websites", label: "Connected Websites", icon: Globe },
  { id: "activity", label: "Activity", icon: ActivityIcon },
];
const NAV2: { id: Route; label: string; icon: typeof Globe }[] = [
  { id: "settings", label: "Settings", icon: SettingsIcon },
  { id: "help", label: "Help", icon: HelpCircle },
];
const TITLES: Record<Route, string> = {
  overview: "Overview",
  providers: "AI Providers",
  websites: "Connected Websites",
  activity: "Activity",
  settings: "Settings",
  diagnostics: "Diagnostics",
  help: "Help",
};

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M8 15.5 16 8.5" stroke="#78aaff" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="7" cy="16.5" r="4" fill="#f5f7fa" />
        <circle cx="17" cy="7.5" r="4" fill="#78aaff" />
      </svg>
    </span>
  );
}

function Sidebar() {
  const { route, navigate, snap } = useBridge();
  const pending = (snap?.permissions.length ?? 0) + (snap?.tasks.filter((t) => t.state === "awaiting_approval").length ?? 0);
  const status = snap ? relayLabel(snap.bridge.relay, snap.bridge.paused) : null;
  const item = (n: (typeof NAV)[number]) => (
    <button key={n.id} className="nav-item" aria-current={route === n.id || (n.id === "settings" && route === "diagnostics") ? "page" : undefined} onClick={() => navigate(n.id)} title={n.label}>
      <n.icon size={16} />
      <span className="l">{n.label}</span>
      {n.id === "activity" && pending > 0 && <span className="count" aria-label={`${pending} waiting`}>{pending}</span>}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <BrandMark />
        <span>Remote ACP Bridge</span>
      </div>
      <nav className="nav" aria-label="Main">{NAV.map(item)}</nav>
      <div className="nav-sep" />
      <nav className="nav" aria-label="More">{NAV2.map(item)}</nav>
      {status && (
        <div className="sidebar-foot row" style={{ gap: 7 }}>
          <span className={`dot ${status.dot}`} />
          <span>{status.text}</span>
        </div>
      )}
    </aside>
  );
}

const ONBOARD_KEY = "rab.onboarded.v1";

function Onboarding({ onDone }: { onDone: () => void }) {
  const { snap, navigate } = useBridge();
  const providers = (snap?.providers ?? []).filter((p) => p.id !== "mock");
  return (
    <div className="content" data-tauri-drag-region>
      <div className="onboard">
        <div style={{ display: "inline-block", transform: "scale(2.2)", marginTop: 10 }}><BrandMark /></div>
        <h1>Connect your AI agent to websites securely.</h1>
        <p className="muted">Use Codex or Claude Code on this computer from a website you trust. You stay in control of sign-in, files and every permission.</p>
        <div className="steps">
          {[["Choose your AI", "Use the official sign-in for Codex or Claude Code."], ["Connect a website", "Click “Connect desktop agent” on the website and approve it here."], ["Start using it", "Watch tasks live. Stop or disconnect anytime."]].map(([t, d], i) => (
            <div key={t} className="card step"><div className="n">{i + 1}</div><b>{t}</b><div className="small muted" style={{ marginTop: 4 }}>{d}</div></div>
          ))}
        </div>
        <div className="card" style={{ textAlign: "left" }}>
          {!snap && <div className="setting-row"><Spinner /> Looking for AI agents on this computer…</div>}
          {providers.map((p) => (
            <div key={p.id} className="setting-row">
              <ProviderLogo provider={p} size={30} />
              <div className="text"><div className="title">{p.name}</div><div className="desc">{p.statusMessage}</div></div>
              {providerBadge(p)}
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: "center", marginTop: 22, gap: 10 }}>
          <button className="btn btn-lg" onClick={() => { onDone(); navigate("providers"); }}>Set up AI providers</button>
          <button className="btn btn-lg btn-primary" onClick={() => { onDone(); navigate("overview"); }}>Continue</button>
        </div>
        <p className="small faint" style={{ marginTop: 18 }}>Keep the app running while you use connected websites.</p>
      </div>
    </div>
  );
}

function Shell() {
  const { route, snap, loadError } = useBridge();
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem(ONBOARD_KEY) === "1";
    } catch {
      return true;
    }
  });
  const finish = () => {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* ignore */
    }
    setOnboarded(true);
  };
  // A pairing link should never be blocked by onboarding.
  useEffect(() => {
    if (snap?.pairingRequests.length && !onboarded) finish();
  }, [snap?.pairingRequests.length, onboarded]);

  if (!onboarded) {
    return (
      <div className="main" style={{ height: "100%" }}>
        <div className="topbar" data-tauri-drag-region />
        <Onboarding onDone={finish} />
        <Toasts />
      </div>
    );
  }
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{TITLES[route]}</h1>
          <div className="spacer" data-tauri-drag-region />
          {route !== "websites" && route !== "overview" && snap && <ConnectWebsiteButton small />}
        </header>
        <div className="content" style={route === "activity" ? { overflow: "hidden" } : undefined}>
          {loadError && <div className="callout callout-red" style={{ marginBottom: 12 }}>{loadError}</div>}
          {!snap ? (
            <div className="row muted"><Spinner /> Starting…</div>
          ) : route === "overview" ? (
            <Overview />
          ) : route === "providers" ? (
            <Providers />
          ) : route === "websites" ? (
            <Websites />
          ) : route === "activity" ? (
            <Activity />
          ) : route === "settings" ? (
            <Settings />
          ) : route === "diagnostics" ? (
            <Diagnostics />
          ) : (
            <Help />
          )}
        </div>
      </main>
      <DecisionTray />
      <PairingOverlay />
      <Toasts />
    </div>
  );
}

export function App() {
  return (
    <BridgeProvider>
      <Shell />
    </BridgeProvider>
  );
}
