/**
 * Friendly, user-facing explanations for Remote ACP Bridge error codes.
 *
 * Codes come from three places and are all handled the same way:
 * - relay REST errors when starting a task (RemoteAcpError.code):
 *   desktop_offline, connection_revoked, connection_paused, task_in_progress, ...
 * - `task.rejected` events from the desktop (payload.code): declined, approval_timeout, bridge_paused, ...
 * - `task.failed` events (payload.code): policy_blocked, connection_revoked, desktop_offline, ...
 */

export interface FriendlyError {
  /** Short headline for the UI. */
  title: string;
  /** What happened and what the user can do. */
  message: string;
  /** True if the connection is gone and the user must connect again. */
  reconnect?: boolean;
}

const MESSAGES: Record<string, FriendlyError> = {
  desktop_offline: {
    title: "Your computer is offline",
    message: "Remote ACP Bridge isn't connected right now. Open the app on your computer (and check it isn't paused), then try again.",
  },
  connection_revoked: {
    title: "Connection removed",
    message: "This website's access was revoked, either here (Disconnect) or in the Remote ACP Bridge app. Connect again to continue.",
    reconnect: true,
  },
  connection_expired: {
    title: "Connection expired",
    message: "The access you granted this website has expired. Connect again to continue.",
    reconnect: true,
  },
  connection_paused: {
    title: "Connection paused",
    message: "You paused this website in Remote ACP Bridge. Resume it in the app to generate documents.",
  },
  task_in_progress: {
    title: "Already working",
    message: "Your agent is still busy with another task from this website. Wait for it to finish or cancel it.",
  },
  declined: {
    title: "You declined the task",
    message: "The request was declined in Remote ACP Bridge, so nothing ran and nothing was changed.",
  },
  approval_timeout: {
    title: "Not approved in time",
    message: "Nobody approved the task in Remote ACP Bridge before it timed out. Nothing was changed.",
  },
  bridge_paused: {
    title: "Remote ACP Bridge is paused",
    message: "All website tasks are paused in the desktop app. Resume it there and try again.",
  },
  policy_blocked: {
    title: "Stopped by your computer's safety checks",
    message:
      "Remote ACP Bridge stopped the task because the agent tried to reach outside your project folder or produced something that looks like a credential. Nothing more was sent to this website.",
  },
  provider_policy: {
    title: "Agent not allowed for websites",
    message: "The agent selected for this connection can't be used by websites. Pick another agent in Remote ACP Bridge.",
  },
  task_timeout: { title: "Took too long", message: "The task ran longer than allowed and was stopped." },
  missing_scope: { title: "Not allowed", message: "This connection doesn't allow interactive tasks. Connect again." , reconnect: true },
  rate_limited: { title: "Slow down", message: "Too many requests. Wait a moment and try again." },
  not_connected: { title: "Not connected", message: "Connect your desktop agent first.", reconnect: true },
  relay_auth_failed: { title: "Server misconfigured", message: "This website can't authenticate to the relay. Check REMOTE_ACP_SERVICE_SECRET." },
  network_error: { title: "Relay unreachable", message: "This website can't reach the relay right now. Try again shortly." },
  stream_interrupted: { title: "Lost the live view", message: "The live connection to the task was interrupted. The task may still be running on your computer." },
};

export function friendlyError(code: string, fallbackMessage?: string): FriendlyError {
  return MESSAGES[code] ?? { title: "Something went wrong", message: fallbackMessage || `Error: ${code}` };
}
