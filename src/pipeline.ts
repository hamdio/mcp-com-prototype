// Transport-independent request pipeline (plan.md §6).
import type { AuthClient, Principal } from "./auth.ts";
import type { ComSession } from "./comSession.ts";
import { agentMessage, ToolError, type CallMeta, type ErrorCode } from "./errors.ts";
import { BASE_LICENSE, type LicenseClient, type LicenseLease } from "./license.ts";
import { outcomeFor, pseudonymise, safeEmit, type Telemetry } from "./telemetry.ts";
import { MAX_RESULT_BYTES, type ToolDef } from "./tools.ts";

export interface PipelineDeps {
  auth: AuthClient;
  license: LicenseClient;
  session: ComSession;
  telemetry: Telemetry;
  tools: Map<string, ToolDef>;
  maxResultBytes?: number; // defaults to MAX_RESULT_BYTES
}

export interface ToolRequest {
  tool: string;
  input: unknown;
  token: string;
  correlationId: string;
  workflowId?: string;
}

export interface AgentError {
  code: ErrorCode;
  message: string;
  correlationId: string;
  detail?: { feature: string }; // which licence layer is missing (L5)
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: AgentError };

async function verify(auth: AuthClient, token: string): Promise<Principal> {
  try {
    return await auth.verify(token);
  } catch (err) {
    if (err instanceof ToolError && err.code === "unauthenticated") throw err;
    throw new ToolError("auth_unavailable", "Auth service call failed"); // fail closed (E7)
  }
}

/** Releases every lease; reports seat hold time and any failed release (LIC6, possible leak). */
async function releaseLeases(
  telemetry: Telemetry,
  correlationId: string,
  leases: LicenseLease[],
  features: string[],
  acquiredAt: number,
): Promise<void> {
  const failed: string[] = [];
  for (const [index, lease] of leases.entries()) {
    try {
      await lease.release();
    } catch {
      failed.push(features[index] ?? "unknown"); // never fails the tool call; lease expiry is the backstop
    }
  }
  if (failed.length > 0 || leases.some((lease) => lease.kind === "seat")) {
    safeEmit(telemetry, {
      type: "license_released",
      correlationId,
      features: features.slice(0, leases.length),
      seatHoldMs: Date.now() - acquiredAt,
      failed,
    });
  }
}

async function acquire(license: LicenseClient, subject: string, feature: string): Promise<LicenseLease> {
  try {
    return await license.acquire(subject, feature);
  } catch (err) {
    if (err instanceof ToolError && err.code === "unlicensed") {
      throw new ToolError("unlicensed", err.message, { feature });
    }
    throw new ToolError("license_unavailable", "Licence service call failed", { feature }); // fail closed (L6)
  }
}

export async function handleToolCall(deps: PipelineDeps, req: ToolRequest): Promise<ToolResult> {
  const startedAt = Date.now();
  const def = deps.tools.get(req.tool);
  const features = def ? [BASE_LICENSE, ...def.licenseFeatures] : [];
  const checked: string[] = [];
  const leases: LicenseLease[] = [];
  let seatsAcquiredAt = 0;
  let comSettled: Promise<void> | undefined;
  let principal: Principal | undefined;
  let args: unknown[] = [];
  let meta: CallMeta = {};
  let resultBytes: number | undefined;
  let result: ToolResult;

  try {
    if (!def) throw new ToolError("invalid_input", `Unknown tool "${req.tool}".`);
    args = def.toArgs(req.input); // validate before the remote auth round-trip
    principal = await verify(deps.auth, req.token);
    if (!principal.scopes.includes(def.scope)) throw new ToolError("forbidden", `Actor lacks scope ${def.scope}`);
    seatsAcquiredAt = Date.now();
    for (const feature of features) {
      checked.push(feature);
      leases.push(await acquire(deps.license, principal.subject, feature)); // L1, L2; before queueing (L4)
    }

    let settle!: () => void;
    comSettled = new Promise<void>((resolve) => (settle = resolve));
    const call = await deps.session.execute(def.comMethod, args, def.retrySafe, settle);
    meta = call;
    const data = def.mapResult ? def.mapResult(call.value, call) : call.value;
    resultBytes = Buffer.byteLength(JSON.stringify(data ?? null));
    if (resultBytes > (deps.maxResultBytes ?? MAX_RESULT_BYTES)) {
      throw new ToolError("result_too_large", `Result is ${resultBytes} bytes`);
    }
    result = { ok: true, data };
  } catch (err) {
    const toolError = err instanceof ToolError ? err : new ToolError("internal", "Unexpected error");
    meta = { ...meta, ...toolError.meta };
    const error: AgentError = { code: toolError.code, message: agentMessage(toolError), correlationId: req.correlationId };
    if (toolError.code === "unlicensed" && toolError.meta.feature) error.detail = { feature: toolError.meta.feature };
    result = { ok: false, error };
  }

  // Leases are released on every path (LIC3), but only once the COM work has really finished,
  // so a caller timeout doesn't free a seat the app is still using (LIC14).
  if (leases.length > 0) {
    const release = () => releaseLeases(deps.telemetry, req.correlationId, leases, checked, seatsAcquiredAt);
    if (comSettled && !result.ok && result.error.code === "timeout") void comSettled.then(release);
    else await (comSettled ?? Promise.resolve()).then(release);
  }

  // Both branches above end here, so every call emits exactly one event (T1).
  const errorCode = result.ok ? undefined : result.error.code;
  safeEmit(deps.telemetry, {
    type: "tool_call",
    tool: req.tool,
    effect: def?.effect,
    retrySafe: def?.retrySafe,
    correlationId: req.correlationId,
    workflowId: req.workflowId,
    callerType: principal?.callerType,
    actor: principal?.actor,
    subject: principal ? pseudonymise(principal.subject) : undefined,
    outcome: outcomeFor(errorCode),
    errorCode,
    hresult: meta.hresult,
    durationMs: Date.now() - startedAt,
    queueWaitMs: meta.queueWaitMs ?? 0,
    comMs: meta.comMs ?? 0,
    attempts: meta.attempts ?? 0,
    resultBytes,
    elementCount: def?.elementCount && args.length > 0 ? def.elementCount(args) : undefined,
    licenseFeatures: checked.length > 0 ? checked : undefined,
    deniedFeature: meta.feature,
    sessionId: deps.session.id,
  });
  return result;
}
