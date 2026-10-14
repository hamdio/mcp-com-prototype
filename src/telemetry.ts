// Telemetry events (plan.md T1-T5). Fields are chosen so every KPI in §3 can be computed from them.
import { createHash } from "node:crypto";
import type { CallerType } from "./auth.ts";
import type { ErrorCode } from "./errors.ts";

export type Outcome = "success" | "denied" | "invalid" | "error";

export interface ToolCallEvent {
  type: "tool_call";
  tool: string;
  effect?: "read" | "view" | "model" | "heavy";
  retrySafe?: boolean;
  correlationId: string;
  workflowId?: string;
  callerType?: CallerType;
  actor?: string;
  subject?: string; // pseudonymised
  outcome: Outcome;
  errorCode?: ErrorCode;
  hresult?: number;
  durationMs: number;
  queueWaitMs: number;
  comMs: number;
  attempts: number; // 0 means COM was never called
  resultBytes?: number; // size of the successful result, for the response-size KPI
  elementCount?: number; // writes only (W5)
  licenseFeatures?: string[]; // layers checked, including "base" (L8)
  deniedFeature?: string;
  seatHoldMs?: number;
  sessionId: string;
}

export type SessionState = "disconnected" | "connecting" | "ready" | "faulted" | "reconnecting";

export interface SessionStateEvent {
  type: "session_state";
  sessionId: string;
  from: SessionState;
  to: SessionState;
  reason: string;
}

export type TelemetryEvent = ToolCallEvent | SessionStateEvent;

export interface Telemetry {
  emit(event: TelemetryEvent): void;
}

/** A telemetry failure never fails a tool call (T3). */
export function safeEmit(telemetry: Telemetry, event: TelemetryEvent): void {
  try {
    telemetry.emit(event);
  } catch {
    // Deliberately swallowed; a real sink would count drops.
  }
}

export function outcomeFor(code: ErrorCode | undefined): Outcome {
  switch (code) {
    case undefined:
      return "success";
    case "invalid_input":
      return "invalid";
    case "unauthenticated":
    case "auth_unavailable":
    case "forbidden":
    case "unlicensed":
    case "license_unavailable":
      return "denied";
    default:
      return "error";
  }
}

/** Prototype only: production should use a keyed HMAC so the IDs can't be brute-forced. */
export function pseudonymise(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}
