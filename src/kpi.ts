// Computes plan.md §3 KPIs from telemetry alone (T5), so the same code can run on production events.
import type { CallerType } from "./auth.ts";
import type { ErrorCode } from "./errors.ts";
import type { TelemetryEvent, ToolCallEvent } from "./telemetry.ts";
import { MAX_RESULT_BYTES } from "./tools.ts";

export interface KpiLimits {
  maxOverheadP95Ms: number;
  maxQueueWaitP95Ms: number;
  maxNonUserErrorRate: number;
  maxResultBytes: number;
}

/** (proposed) values from plan.md §3.2; placeholders until baselined on real COM. */
export const DEFAULT_LIMITS: KpiLimits = {
  maxOverheadP95Ms: 50,
  maxQueueWaitP95Ms: 1000,
  maxNonUserErrorRate: 0.01,
  maxResultBytes: MAX_RESULT_BYTES,
};

/** Ground truth known to whoever generated the calls (the validation runner, or a test). */
export interface Expectations {
  correlationIds: string[];
  callerTypes: Map<string, CallerType>;
}

export interface Gate {
  name: string;
  actual: number;
  limit: number;
  comparison: "<=" | ">=";
  pass: boolean;
}

export interface KpiReport {
  metrics: Record<string, number>;
  gates: Gate[];
  pass: boolean;
}

const NON_USER_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "app_busy",
  "app_unavailable",
  "timeout",
  "app_error",
  "internal",
]);

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

export function gate(name: string, actual: number, comparison: "<=" | ">=", limit: number): Gate {
  return { name, actual, limit, comparison, pass: comparison === "<=" ? actual <= limit : actual >= limit };
}

export function computeKpis(events: TelemetryEvent[], expect: Expectations, limits: KpiLimits = DEFAULT_LIMITS): KpiReport {
  const calls = events.filter((e): e is ToolCallEvent => e.type === "tool_call");
  const perId = new Map<string, number>();
  for (const call of calls) perId.set(call.correlationId, (perId.get(call.correlationId) ?? 0) + 1);

  const expected = new Set(expect.correlationIds);
  const exactlyOnce = expect.correlationIds.filter((id) => perId.get(id) === 1).length;
  const unexpected = calls.filter((c) => !expected.has(c.correlationId)).length;
  const telemetryExactlyOnceRate =
    expect.correlationIds.length === 0 ? 1 : (exactlyOnce - unexpected) / expect.correlationIds.length;

  const blockedButReachedCom = calls.filter(
    (c) => (c.outcome === "denied" || c.outcome === "invalid") && c.attempts > 0,
  ).length;
  // The gate is about retry safety, not R/W: an idempotent write (W1) may be retried.
  const unsafeRetried = calls.filter((c) => c.retrySafe === false && c.attempts > 1).length;
  const oversizedResponses = calls.filter(
    (c) => c.outcome === "success" && (c.resultBytes ?? 0) > limits.maxResultBytes,
  ).length;
  const wrongCallerType = calls.filter((c) => {
    const want = expect.callerTypes.get(c.correlationId);
    return want !== undefined && c.callerType !== undefined && c.callerType !== want;
  }).length;

  // Overhead = time not spent waiting in the queue or inside COM. Single-attempt successes only,
  // so retry backoff doesn't count as pipeline overhead.
  const overheadP95 = p95(
    calls.filter((c) => c.outcome === "success" && c.attempts === 1).map((c) => c.durationMs - c.queueWaitMs - c.comMs),
  );
  const queueWaitP95 = p95(calls.filter((c) => c.attempts > 0).map((c) => c.queueWaitMs));
  const nonUserErrors = calls.filter((c) => c.errorCode !== undefined && NON_USER_ERRORS.has(c.errorCode)).length;
  const nonUserErrorRate = calls.length === 0 ? 0 : nonUserErrors / calls.length;
  const retryRecovered = calls.filter((c) => c.outcome === "success" && c.attempts > 1).length;

  const gates = [
    gate("blocked calls that reached COM", blockedButReachedCom, "<=", 0),
    gate("tool calls with exactly one telemetry event", telemetryExactlyOnceRate, ">=", 1),
    gate("non-retry-safe calls retried", unsafeRetried, "<=", 0),
    gate("responses over the size cap", oversizedResponses, "<=", 0),
    gate("calls with wrong caller type", wrongCallerType, "<=", 0),
    gate("MCP overhead p95 (ms)", overheadP95, "<=", limits.maxOverheadP95Ms),
    gate("queue wait p95 (ms)", queueWaitP95, "<=", limits.maxQueueWaitP95Ms),
    gate("non-user error rate", nonUserErrorRate, "<=", limits.maxNonUserErrorRate),
  ];

  return {
    metrics: {
      toolCalls: calls.length,
      telemetryExactlyOnceRate,
      blockedButReachedCom,
      unsafeRetried,
      oversizedResponses,
      wrongCallerType,
      overheadP95,
      queueWaitP95,
      nonUserErrorRate,
      retryRecovered,
    },
    gates,
    pass: gates.every((g) => g.pass),
  };
}
