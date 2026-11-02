import type { ReactNode } from "react";
import type { ProviderView, RelayStatus, TaskState } from "../lib/types";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />;
}

const PROVIDER_COLORS: Record<string, string> = {
  codex: "linear-gradient(150deg,#2b2b2f,#0d0d10)",
  claude: "linear-gradient(150deg,#c8714f,#a2522f)",
  mock: "linear-gradient(150deg,#6b7b99,#4a5670)",
};

/** Plain-text marks only: no third-party logo assets are shipped. */
export function ProviderLogo({ provider, size = 38 }: { provider: Pick<ProviderView, "id" | "name">; size?: number }) {
  const initials = provider.id === "mock" ? "T" : provider.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);
  return (
    <div
      className="provider-logo"
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.37, background: PROVIDER_COLORS[provider.id] ?? "linear-gradient(150deg,#5a6b8c,#3a4560)" }}
    >
      {initials}
    </div>
  );
}

export function providerBadge(p: ProviderView): ReactNode {
  switch (p.state) {
    case "ready":
      return <span className="badge badge-green">Ready</span>;
    case "signed_out":
      return <span className="badge badge-amber">Sign in needed</span>;
    case "installed":
      return <span className="badge badge-amber">Setup needed</span>;
    case "not_installed":
      return <span className="badge">Not installed</span>;
    case "broken":
      return <span className="badge badge-red">Needs repair</span>;
    default:
      return <span className="badge badge-red">Unavailable</span>;
  }
}

export function relayLabel(r: RelayStatus, paused: boolean): { text: string; dot: string; sub: string } {
  if (paused) return { text: "Bridge is paused", dot: "dot-amber", sub: "Websites can't start tasks until you resume." };
  switch (r.state) {
    case "connected":
      return { text: "Bridge is on", dot: "dot-green", sub: "Connected websites can request tasks." };
    case "connecting":
      return { text: "Connecting…", dot: "dot-amber dot-pulse", sub: "Reaching the relay." };
    default:
      return { text: "Offline", dot: "dot-red", sub: r.message || "Can't reach the relay." };
  }
}

export function taskStateBadge(s: TaskState): ReactNode {
  const map: Record<TaskState, [string, string]> = {
    created: ["", "Received"],
    awaiting_approval: ["badge-amber", "Waiting for you"],
    queued: ["badge-blue", "Starting"],
    running: ["badge-blue", "Working"],
    cancelling: ["badge-amber", "Stopping"],
    completed: ["badge-green", "Done"],
    cancelled: ["", "Stopped"],
    failed: ["badge-red", "Failed"],
    rejected: ["", "Declined"],
    expired: ["", "Expired"],
  };
  const [cls, label] = map[s];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function timeUntil(iso: string): string {
  const d = (new Date(iso).getTime() - Date.now()) / 1000;
  if (d <= 0) return "expired";
  if (d < 90) return `in ${Math.round(d)} s`;
  if (d < 5400) return `in ${Math.round(d / 60)} min`;
  if (d < 172800) return `in ${Math.round(d / 3600)} hours`;
  return `in ${Math.round(d / 86400)} days`;
}

export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {children && <div className="small">{children}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
