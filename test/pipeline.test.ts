import assert from "node:assert/strict";
import { test } from "node:test";
import { RPC_E_CALL_REJECTED } from "../src/errors.ts";
import { rawComText } from "../src/fakes.ts";
import { handleToolCall } from "../src/pipeline.ts";
import { pseudonymise } from "../src/telemetry.ts";
import { GET_APP_INFO, type ToolDef } from "../src/tools.ts";
import { request, setup } from "./helpers.ts";

const appInfo = (overrides = {}) => request("get_app_info", {}, overrides);

test("1. happy path: COM gets mapped args, result returned, one success event", async () => {
  const { com, telemetry, deps } = setup();
  const result = await handleToolCall(deps, request("query_elements", { type: "column", level: "L2", pageSize: 2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(com.calls, [
    { method: "Model.QueryElements", args: [{ type: "column", level: "L2", layer: null }, 2, null] },
  ]);
  const [event, ...rest] = telemetry.toolCalls();
  assert.equal(rest.length, 0);
  assert.equal(event?.outcome, "success");
  assert.equal(event?.callerType, "agent");
  assert.equal(event?.actor, "assistant-agent");
  assert.equal(event?.subject, pseudonymise("user-123"));
  assert.equal(event?.attempts, 1);
  assert.deepEqual(event?.licenseFeatures, ["base"]);
  assert.ok((event?.resultBytes ?? 0) > 0);
});

test("2. caller type comes from the token, not from client input", async () => {
  const { telemetry, deps } = setup();
  await handleToolCall(deps, request("get_app_info", { callerType: "agent" }, { token: "app-token" }));
  await handleToolCall(deps, appInfo({ correlationId: "c-2" }));
  assert.deepEqual(telemetry.toolCalls().map((e) => e.callerType), ["app", "agent"]);
});

test("3. agent lacks scope while the user is entitled → forbidden, COM and licensing not called", async () => {
  const { com, license, telemetry, deps } = setup();
  const result = await handleToolCall(deps, appInfo({ token: "agent-noscope-token" }));
  assert.equal(!result.ok && result.error.code, "forbidden");
  assert.equal(com.calls.length, 0);
  assert.equal(license.checks.length, 0);
  assert.equal(telemetry.toolCalls()[0]?.outcome, "denied");
});

test("4. bad token → unauthenticated; auth outage → auth_unavailable; both denied without COM", async () => {
  const { com, auth, telemetry, deps } = setup();
  const bad = await handleToolCall(deps, appInfo({ token: "nope" }));
  auth.down = true;
  const down = await handleToolCall(deps, appInfo({ correlationId: "c-2" }));
  assert.equal(!bad.ok && bad.error.code, "unauthenticated");
  assert.equal(!down.ok && down.error.code, "auth_unavailable");
  assert.equal(com.calls.length, 0);
  assert.deepEqual(telemetry.toolCalls().map((e) => e.outcome), ["denied", "denied"]);
});

test("invalid input → invalid_input with a helpful message, before any auth call", async () => {
  const { auth, deps } = setup();
  const result = await handleToolCall(deps, request("query_elements", { pageSize: 0 }));
  assert.deepEqual(!result.ok && result.error, {
    code: "invalid_input",
    message: '"pageSize" must be an integer from 1 to 100.',
    correlationId: "c-1",
  });
  assert.equal(auth.verifyCalls, 0);
});

test("unknown tool → invalid_input, one invalid event", async () => {
  const { telemetry, deps } = setup();
  const result = await handleToolCall(deps, request("delete_everything", {}));
  assert.equal(!result.ok && result.error.code, "invalid_input");
  assert.equal(telemetry.toolCalls()[0]?.outcome, "invalid");
});

test("9. raw COM error text never reaches the agent; HRESULT goes to telemetry only", async () => {
  const { com, telemetry, deps } = setup();
  com.enqueue({ hresult: 0x80004005 });
  const result = await handleToolCall(deps, appInfo());
  const body = JSON.stringify(result);
  assert.ok(!body.includes("core.dll") && !body.includes("80004005"), body);
  assert.ok(!body.includes(rawComText(0x80004005)));
  assert.equal(telemetry.toolCalls()[0]?.hresult, 0x80004005);
});

test("retry metadata reaches telemetry", async () => {
  const { com, telemetry, deps } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED });
  await handleToolCall(deps, appInfo());
  assert.equal(telemetry.toolCalls()[0]?.attempts, 2);
});

test("a throwing telemetry sink never fails the tool call", async () => {
  const { deps } = setup({ telemetry: { emit: () => { throw new Error("sink down"); } } });
  const result = await handleToolCall(deps, appInfo());
  assert.equal(result.ok, true);
});

test("a buggy toArgs that throws a plain Error → internal, COM not called", async () => {
  const broken: ToolDef = { ...GET_APP_INFO, name: "broken", toArgs: () => { throw new Error("oops"); } };
  const { com, deps } = setup({ tools: [broken] });
  const result = await handleToolCall(deps, request("broken", {}));
  assert.equal(!result.ok && result.error.code, "internal");
  assert.equal(com.calls.length, 0);
});
