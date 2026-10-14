import assert from "node:assert/strict";
import { test } from "node:test";
import { computeKpis, p95, type Expectations } from "../src/kpi.ts";
import type { ToolCallEvent } from "../src/telemetry.ts";

function call(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call", tool: "get_app_info", effect: "read", retrySafe: true, correlationId: id, callerType: "agent",
    outcome: "success", durationMs: 10, queueWaitMs: 2, comMs: 7, attempts: 1, sessionId: "s", ...overrides,
  };
}

function expectIds(ids: string[], callerType: "agent" | "app" = "agent"): Expectations {
  return { correlationIds: ids, callerTypes: new Map(ids.map((id) => [id, callerType])) };
}

const failing = (report: ReturnType<typeof computeKpis>) => report.gates.filter((g) => !g.pass).map((g) => g.name);

test("p95 picks the 95th percentile value", () => {
  assert.equal(p95([]), 0);
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
});

test("clean telemetry passes every gate", () => {
  const report = computeKpis([call("a"), call("b")], expectIds(["a", "b"]));
  assert.deepEqual(failing(report), []);
  assert.equal(report.metrics.overheadP95, 1);
});

test("a missing or duplicated event fails the exactly-once gate", () => {
  assert.deepEqual(failing(computeKpis([call("a")], expectIds(["a", "b"]))), ["tool calls with exactly one telemetry event"]);
  assert.deepEqual(failing(computeKpis([call("a"), call("a")], expectIds(["a"]))), ["tool calls with exactly one telemetry event"]);
});

test("a denied call that reached COM fails the gate", () => {
  const report = computeKpis([call("a", { outcome: "denied", errorCode: "forbidden", attempts: 1 })], expectIds(["a"]));
  assert.ok(failing(report).includes("blocked calls that reached COM"));
});

test("a retried non-retry-safe call fails the gate; a retried idempotent write does not", () => {
  const unsafe = computeKpis([call("a", { effect: "model", retrySafe: false, attempts: 2 })], expectIds(["a"]));
  const safe = computeKpis([call("a", { effect: "model", retrySafe: true, attempts: 2 })], expectIds(["a"]));
  assert.ok(failing(unsafe).includes("non-retry-safe calls retried"));
  assert.deepEqual(failing(safe), []);
});

test("a successful response over the size cap fails the gate", () => {
  const report = computeKpis([call("a", { resultBytes: 200_000 })], expectIds(["a"]));
  assert.ok(failing(report).includes("responses over the size cap"));
});

test("wrong caller type fails the gate", () => {
  const report = computeKpis([call("a", { callerType: "app" })], expectIds(["a"], "agent"));
  assert.ok(failing(report).includes("calls with wrong caller type"));
});

test("non-user error rate counts app/timeout/internal but not denials", () => {
  const events = [
    call("a", { outcome: "error", errorCode: "timeout" }),
    call("b", { outcome: "denied", errorCode: "forbidden", attempts: 0 }),
    call("c"),
    call("d"),
  ];
  assert.equal(computeKpis(events, expectIds(["a", "b", "c", "d"])).metrics.nonUserErrorRate, 0.25);
});

test("not_found and result_too_large are agent-side, so they don't count as non-user errors", () => {
  const events = [
    call("a", { outcome: "error", errorCode: "not_found" }),
    call("b", { outcome: "error", errorCode: "result_too_large" }),
  ];
  assert.equal(computeKpis(events, expectIds(["a", "b"])).metrics.nonUserErrorRate, 0);
});
