import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isPreview, previewSnapshot } from "./preview";
import type {
  AcceptOptions,
  AccessLevel,
  Diagnostics,
  GrantView,
  PairingRequestView,
  ProviderView,
  Settings,
  Snapshot,
  UiEvent,
} from "./types";

export class ApiError extends Error {}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isPreview()) {
    // Browser preview with sample data (never inside the app).
    return (cmd === "get_snapshot" ? previewSnapshot : undefined) as T;
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const msg =
      typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
    throw new ApiError(msg);
  }
}

export const api = {
  snapshot: () => call<Snapshot>("get_snapshot"),
  refreshProviders: () => call<ProviderView[]>("refresh_providers"),
  installAdapter: (provider: string) => call<string>("install_adapter", { provider }),
  signIn: (provider: string) => call<void>("provider_sign_in", { provider }),
  signOut: (provider: string) => call<void>("provider_sign_out", { provider }),
  addCustomAgent: (name: string, program: string, args: string[]) =>
    call<void>("add_custom_agent", { name, program, args }),
  removeCustomAgent: (id: string) => call<void>("remove_custom_agent", { id }),
  beginPairing: (input: string) => call<PairingRequestView>("begin_pairing", { input }),
  acceptPairing: (pairingId: string, opts: AcceptOptions) => call<GrantView>("accept_pairing", { pairingId, opts }),
  rejectPairing: (pairingId: string) => call<void>("reject_pairing", { pairingId }),
  revokeGrant: (connectionId: string) => call<void>("revoke_grant", { connectionId }),
  revokeAll: () => call<void>("revoke_all"),
  forgetGrant: (connectionId: string) => call<void>("forget_grant", { connectionId }),
  setGrantPaused: (connectionId: string, paused: boolean) => call<void>("set_grant_paused", { connectionId, paused }),
  updateGrant: (connectionId: string, requireTaskApproval: boolean, access: AccessLevel) =>
    call<void>("update_grant", { connectionId, requireTaskApproval, access }),
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
  approveTask: (taskId: string, approve: boolean) => call<void>("approve_task", { taskId, approve }),
  cancelTask: (taskId: string) => call<void>("cancel_task", { taskId }),
  respondPermission: (requestId: string, choice: "allow_once" | "allow_task" | "deny") =>
    call<void>("respond_permission", { requestId, choice }),
  startLocalTask: (provider: string, workspace: string, prompt: string) =>
    call<string>("start_local_task", { provider, workspace, prompt }),
  updateSettings: (settings: Settings) => call<Settings>("update_settings", { settings }),
  diagnostics: () => call<Diagnostics>("get_diagnostics"),
  clearDiagnostics: () => call<void>("clear_diagnostics"),
};

export function onBridgeEvent(cb: (e: UiEvent) => void): Promise<UnlistenFn> {
  if (isPreview()) return Promise.resolve(() => {});
  return listen<UiEvent>("bridge://event", (ev) => cb(ev.payload));
}

export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title: "Choose a project folder" });
  return typeof r === "string" ? r : null;
}

export async function pickFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: false, multiple: false, title: "Choose the agent executable" });
  return typeof r === "string" ? r : null;
}

export async function openExternal(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
