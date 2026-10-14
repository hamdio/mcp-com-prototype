import assert from "node:assert/strict";
import { test } from "node:test";
import { ComSession, type SessionConfig } from "../src/comSession.ts";
import { ERROR_NOT_FOUND, RPC_E_CALL_REJECTED, RPC_S_SERVER_UNAVAILABLE, ToolError, type ErrorCode } from "../src/errors.ts";
import { FakeComClient, RecordingTelemetry } from "../src/fakes.ts";

const config: SessionConfig = { maxPending: 10, deadlineMs: 200, retryAttempts: 3, retryBaseMs: 5 };

function setup(overrides: Partial<SessionConfig> = {}) {
  const com = new FakeComClient();
  const telemetry = new RecordingTelemetry();
  const session = new ComSession(com, telemetry, { ...config, ...overrides });
  return { com, telemetry, session };
}

function isCode(code: ErrorCode) {
  return (e: unknown) => e instanceof ToolError && e.code === code;
}

test("connects lazily on the first call and reports state changes", async () => {
  const { com, telemetry, session } = setup();
  assert.equal(session.currentState, "disconnected");
  assert.equal(com.connects, 0);
  const result = await session.execute("M", [1], true);
  assert.deepEqual(result.value, { method: "M", args: [1] });
  assert.equal(result.attempts, 1);
  assert.equal(session.currentState, "ready");
  assert.deepEqual(telemetry.sessionStates().map((e) => e.to), ["connecting", "ready"]);
});

test("parallel calls never overlap inside the COM client and run in order", async () => {
  const { com, session } = setup();
  com.enqueue({ ok: "a", delayMs: 20 }, { ok: "b", delayMs: 5 }, { ok: "c" });
  const results = await Promise.all([
    session.execute("A", [], true),
    session.execute("B", [], true),
    session.execute("C", [], true),
  ]);
  assert.deepEqual(results.map((r) => r.value), ["a", "b", "c"]);
  assert.deepEqual(com.calls.map((c) => c.method), ["A", "B", "C"]);
  assert.equal(com.maxInFlight, 1);
  assert.ok((results[2]?.queueWaitMs ?? 0) >= 20);
});

test("rejects immediately with app_busy when the queue is full", async () => {
  const { com, session } = setup({ maxPending: 2 });
  com.enqueue({ ok: 1, delayMs: 30 }, { ok: 2 });
  const first = session.execute("A", [], true);
  const second = session.execute("B", [], true);
  await assert.rejects(session.execute("C", [], true), (e) => isCode("app_busy")(e) && (e as ToolError).meta.attempts === 0);
  await Promise.all([first, second]);
  assert.equal(com.calls.length, 2);
});

test("cannot connect → app_unavailable, and the next call tries again", async () => {
  const { com, session } = setup();
  com.failNextConnects(1);
  await assert.rejects(session.execute("A", [], true), isCode("app_unavailable"));
  assert.equal(session.currentState, "faulted");
  await session.execute("A", [], true);
  assert.equal(com.connects, 2);
  assert.equal(session.currentState, "ready");
});

test("transient busy then success → retried, attempts 2", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED }, { ok: "done" });
  const result = await session.execute("A", [], true);
  assert.equal(result.value, "done");
  assert.equal(result.attempts, 2);
  assert.equal(result.reconnected, false); // a busy rejection never ran, so this is not a reconnect
});

test("transient errors stop after retryAttempts → app_busy", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED }, { hresult: RPC_E_CALL_REJECTED }, { hresult: RPC_E_CALL_REJECTED }, { ok: "late" });
  await assert.rejects(session.execute("A", [], true), (e) => isCode("app_busy")(e) && (e as ToolError).meta.attempts === 3);
  assert.equal(com.calls.length, 3);
});

test("non-retry-safe calls are never retried", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED }, { ok: "should not run" });
  await assert.rejects(session.execute("W", [], false), (e) => isCode("app_busy")(e) && (e as ToolError).meta.attempts === 1);
  assert.equal(com.calls.length, 1);
});

test("busy past the deadline → timeout, with no attempt started after the deadline", async () => {
  const { com, session } = setup({ deadlineMs: 50, retryBaseMs: 40 });
  com.enqueue({ hresult: RPC_E_CALL_REJECTED, delayMs: 20 }, { ok: "too late" });
  await assert.rejects(session.execute("A", [], true), isCode("timeout"));
  assert.equal(com.calls.length, 1);
});

test("a hung call times out its caller, and queued calls time out without reaching COM", async () => {
  const { com, session } = setup({ deadlineMs: 30 });
  com.enqueue({ ok: "hung", delayMs: 80 });
  const hung = session.execute("A", [], true);
  const queued = session.execute("B", [], true);
  await assert.rejects(hung, isCode("timeout"));
  await assert.rejects(queued, (e) => isCode("timeout")(e) && (e as ToolError).meta.attempts === 0);
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the hung call finish
  assert.deepEqual(com.calls.map((c) => c.method), ["A"]);
});

test("app gone → one reconnect and one retry", async () => {
  const { com, telemetry, session } = setup();
  await session.execute("warm-up", [], true);
  com.enqueue({ hresult: RPC_S_SERVER_UNAVAILABLE }, { ok: "after reconnect" });
  const result = await session.execute("A", [], true);
  assert.equal(result.value, "after reconnect");
  assert.equal(result.attempts, 2);
  assert.equal(result.reconnected, true);
  assert.equal(com.connects, 2);
  assert.deepEqual(telemetry.sessionStates().map((e) => e.to), ["connecting", "ready", "faulted", "reconnecting", "ready"]);
});

test("app gone twice → app_unavailable", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_S_SERVER_UNAVAILABLE }, { hresult: RPC_S_SERVER_UNAVAILABLE });
  await assert.rejects(session.execute("A", [], true), isCode("app_unavailable"));
  assert.equal(com.calls.length, 2);
});

test("permanent COM error → app_error with the HRESULT kept for telemetry", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: 0x80004005 });
  await assert.rejects(session.execute("A", [], true), (e) => isCode("app_error")(e) && (e as ToolError).meta.hresult === 0x80004005);
});

test("a non-COM throw from the adapter → internal, not retried", async () => {
  const { com, session } = setup();
  com.enqueue({ throws: new TypeError("bug in adapter") }, { ok: "unused" });
  await assert.rejects(session.execute("A", [], true), isCode("internal"));
  assert.equal(com.calls.length, 1);
});

test("not-found HRESULT → not_found, not retried (E1)", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: ERROR_NOT_FOUND }, { ok: "unused" });
  await assert.rejects(session.execute("A", [], true), (e) => isCode("not_found")(e) && (e as ToolError).meta.attempts === 1);
  assert.equal(com.calls.length, 1);
});

test("onSettled fires once when COM finishes, once on admission rejection, and only after a hung call ends (LIC14)", async () => {
  const { com, session } = setup({ maxPending: 1, deadlineMs: 30 });
  const settled: string[] = [];
  com.enqueue({ ok: "slow", delayMs: 80 });
  const hung = session.execute("A", [], true, () => settled.push("A"));
  const rejected = session.execute("B", [], true, () => settled.push("B"));
  await assert.rejects(rejected, isCode("app_busy"));
  assert.deepEqual(settled, ["B"]);
  await assert.rejects(hung, isCode("timeout"));
  assert.deepEqual(settled, ["B"]); // caller has timed out, but COM is still running
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(settled, ["B", "A"]);
});
