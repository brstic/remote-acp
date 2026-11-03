// Mirrors crates/bridge-core/src/views.rs and providers.rs (serde camelCase).

export type ProviderState = "not_installed" | "installed" | "signed_out" | "ready" | "broken" | "unsupported";
export type AuthMode = "none" | "subscription" | "api_key";
export type RemotePolicy = "allowed" | "allowed_with_notice" | "blocked";
export type AccessLevel = "read_only" | "workspace_write";
export type GrantStatus = "active" | "paused" | "revoked";
export type TaskState =
  | "created"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "rejected"
  | "expired";

export const TERMINAL: TaskState[] = ["completed", "cancelled", "failed", "rejected", "expired"];
export const isTerminal = (s: TaskState) => TERMINAL.includes(s);

export interface ProviderView {
  id: string;
  name: string;
  description: string;
  state: ProviderState;
  cliPath: string | null;
  cliVersion: string | null;
  adapterVersion: string | null;
  adapterPinned: string | null;
  authMode: AuthMode;
  authLabel: string | null;
  policy: { remote: RemotePolicy; note: string };
  statusMessage: string;
  actions: string[];
  verified: boolean;
}

export type RelayStatus =
  | { state: "disconnected"; message: string }
  | { state: "connecting" }
  | { state: "connected"; latencyMs: number | null };

export interface CustomAgent {
  id: string;
  name: string;
  program: string;
  args: string[];
  sha256: string;
}

export interface Settings {
  relayUrl: string;
  defaultProvider: string | null;
  requireTaskApprovalDefault: boolean;
  notifications: boolean;
  launchAtLogin: boolean;
  keepInTray: boolean;
  theme: "system" | "light" | "dark";
  sessionIdleMinutes: number;
  customAgents: CustomAgent[];
  codexSubscriptionAcknowledged: boolean;
}

export interface PlanEntry {
  content: string;
  status: string;
  priority?: string | null;
}

export type TranscriptItem =
  | { type: "user"; text: string }
  | { type: "agent"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; toolCallId: string; title: string; kind: string; status: string }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "permission"; requestId: string; title: string; outcome: string | null }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

export interface TaskView {
  id: string;
  source: "remote" | "local";
  connectionId: string | null;
  serviceName: string | null;
  serviceDomain: string | null;
  providerId: string;
  workspace: string;
  state: TaskState;
  prompt: string;
  /** Website-provided system instructions for this task. */
  instructions?: string | null;
  /** Website-provided tool servers ("name (url)"). */
  tools?: string[];
  transcript: TranscriptItem[];
  createdAt: string;
  finishedAt: string | null;
  stopReason: string | null;
  error: string | null;
}

export interface PermissionView {
  requestId: string;
  taskId: string;
  title: string;
  kind: string;
  details: string | null;
  canAllowForTask: boolean;
  serviceName: string | null;
  createdAt: string;
}

export interface ServiceIdentity {
  id: string;
  displayName: string;
  origin: string;
  domain: string;
  verified: boolean;
  verification: string;
}

export interface PairingRequestView {
  pairingId: string;
  service: ServiceIdentity;
  externalUserId: string;
  scopes: string[];
  expiresAt: string;
  receivedAt: string;
}

export interface TrustedService {
  id: string;
  displayName: string;
  origin: string;
  domain: string;
  verified: boolean;
}

export interface GrantView {
  connectionId: string;
  service: TrustedService | null;
  externalUserId: string;
  providerId: string;
  workspace: string;
  scopes: string[];
  requireTaskApproval: boolean;
  access: AccessLevel;
  expiresAt: string;
  status: GrantStatus;
  expired: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  busy: boolean;
}

export interface Snapshot {
  bridge: {
    paused: boolean;
    relay: RelayStatus;
    relayUrl: string;
    desktopId: string | null;
    activity: "idle" | "working" | "waiting_for_approval";
  };
  providers: ProviderView[];
  grants: GrantView[];
  pairingRequests: PairingRequestView[];
  tasks: TaskView[];
  permissions: PermissionView[];
  settings: Settings;
}

export interface AcceptOptions {
  providerId: string;
  workspace: string;
  access: AccessLevel;
  requireTaskApproval: boolean;
  durationSecs: number;
  acknowledgeTerms: boolean;
}

export interface SessionDiag {
  key: string;
  providerId: string;
  agentName: string | null;
  agentVersion: string | null;
  protocolVersion: number;
  authMethods: string[];
  modes: string[];
  currentMode: string | null;
  sandboxEnforced: boolean;
  alive: boolean;
  stderrTail: string[];
}

export interface AuditEvent {
  id: number;
  connectionId: string | null;
  taskId: string | null;
  eventType: string;
  createdAt: string;
  metadata: unknown;
}

export interface Diagnostics {
  appVersion: string;
  os: string;
  arch: string;
  relayUrl: string;
  relay: RelayStatus;
  desktopId: string | null;
  secretBackend: string;
  secretBackendSecure: boolean;
  bridgeProtocolVersion: number;
  acpProtocolVersion: number;
  providers: ProviderView[];
  sessions: SessionDiag[];
  recentErrors: string[];
  audit: AuditEvent[];
}

export type UiEvent =
  | { type: "state_changed" }
  | { type: "task_delta"; taskId: string; text: string }
  | { type: "permission_requested"; requestId: string; taskId: string; title: string; serviceName: string | null }
  | { type: "task_approval_requested"; taskId: string; serviceName: string | null; prompt: string }
  | { type: "pairing_requested"; pairingId: string; serviceName: string }
  | { type: "error"; message: string };
