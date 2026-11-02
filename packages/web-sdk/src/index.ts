export { RemoteAcp } from "./client.js";
export type {
  FetchLike,
  RemoteAcpOptions,
  StartTaskInput,
  StreamEventsOptions,
  StreamItem,
  WaitForPairingOptions,
} from "./client.js";
export { RemoteAcpError } from "./errors.js";
export { SseParser, parseSseStream } from "./sse.js";
export type { SseMessage } from "./sse.js";
export type {
  CancelTaskResponse,
  ConnectionInfo,
  ConnectionStatus,
  CreatePairingRequest,
  CreatePairingResponse,
  PairingStatus,
  PairingStatusResponse,
  PermissionOutcome,
  PlanEntry,
  RelayTaskState,
  Scope,
  StreamErrorEvent,
  TaskEvent,
  TaskState,
  TaskStreamEvent,
  TaskStreamKind,
  TaskSummary,
} from "@remote-acp/protocol-types";
