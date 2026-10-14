// Stable, agent-facing error taxonomy (plan.md E1) and COM failure classification (E2).

export type ErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "auth_unavailable"
  | "forbidden"
  | "unlicensed"
  | "license_unavailable"
  | "app_busy"
  | "app_unavailable"
  | "timeout"
  | "app_error"
  | "result_too_large"
  | "internal";

/** Progress recorded for telemetry, even when a call fails. */
export interface CallMeta {
  hresult?: number;
  attempts?: number;
  queueWaitMs?: number;
  comMs?: number;
  feature?: string; // which licence layer failed (L5)
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly meta: CallMeta;

  constructor(code: ErrorCode, message: string, meta: CallMeta = {}) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

/** What a ComClient throws. `message` may contain raw COM text and must never reach the agent (E6). */
export class ComError extends Error {
  readonly hresult: number;

  constructor(hresult: number, message: string) {
    super(message);
    this.hresult = hresult >>> 0;
  }
}

export const RPC_E_CALL_REJECTED = 0x80010001; // app busy, often a modal dialog
export const RPC_E_SERVERCALL_RETRYLATER = 0x8001010a;
export const RPC_E_DISCONNECTED = 0x80010108;
export const RPC_S_SERVER_UNAVAILABLE = 0x800706ba; // app process gone

export type ComErrorClass = "transient" | "session_lost" | "permanent";

/** Accepts signed or unsigned HRESULTs; COM bridges disagree on which they return. */
export function classifyComError(hresult: number): ComErrorClass {
  switch (hresult >>> 0) {
    case RPC_E_CALL_REJECTED:
    case RPC_E_SERVERCALL_RETRYLATER:
      return "transient";
    case RPC_E_DISCONNECTED:
    case RPC_S_SERVER_UNAVAILABLE:
      return "session_lost";
    default:
      return "permanent";
  }
}

const SAFE_MESSAGES: Record<ErrorCode, string> = {
  invalid_input: "The tool input is invalid.",
  unauthenticated: "The caller could not be authenticated.",
  auth_unavailable: "The authentication service is unavailable. Try again later.",
  forbidden: "This client is not permitted to use this tool.",
  unlicensed: "The user is not licensed for this feature.",
  license_unavailable: "The licensing service is unavailable. Try again later.",
  app_busy: "The desktop application is busy. Try again shortly.",
  app_unavailable: "The desktop application is not available.",
  timeout: "The operation did not complete in time.",
  app_error: "The desktop application reported an error.",
  result_too_large: "The result is too large. Request a smaller page or fewer IDs.",
  internal: "An internal error occurred.",
};

/** Agent-facing message. Only `invalid_input` keeps its specific text, because it describes the agent's own input. */
export function agentMessage(err: ToolError): string {
  return err.code === "invalid_input" ? err.message : SAFE_MESSAGES[err.code];
}
