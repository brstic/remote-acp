/**
 * Error thrown by every SDK call.
 *
 * - Relay API errors carry the relay's `code` (e.g. `desktop_offline`,
 *   `connection_revoked`, `task_in_progress`) and HTTP `status`.
 * - Client-side failures use `status: 0` and one of the SDK codes:
 *   `network_error`, `timeout`, `aborted`, `invalid_response`,
 *   `stream_interrupted`, `resume_unavailable`, `invalid_config`.
 */
export class RemoteAcpError extends Error {
  override readonly name = "RemoteAcpError";
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.status = status;
  }

  /** True for transient failures that are reasonable to retry. */
  get retryable(): boolean {
    return (
      this.code === "network_error" ||
      this.code === "rate_limited" ||
      this.code === "stream_interrupted" ||
      this.status >= 500
    );
  }
}

/** Build a RemoteAcpError from a non-2xx relay response. */
export async function errorFromResponse(res: Response): Promise<RemoteAcpError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = body?.error?.code;
    const message = body?.error?.message;
    if (typeof code === "string") {
      return new RemoteAcpError(code, typeof message === "string" ? message : code, res.status);
    }
  } catch {
    /* not JSON */
  }
  return new RemoteAcpError(`http_${res.status}`, `Relay responded with HTTP ${res.status}`, res.status);
}

export function isAbortError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    ((e as { name: string }).name === "AbortError" || (e as { name: string }).name === "TimeoutError")
  );
}
