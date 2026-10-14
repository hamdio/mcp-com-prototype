import assert from "node:assert/strict";
import { test } from "node:test";
import { handleToolCall } from "../src/pipeline.ts";
import { CAPTURE_VIEW, GET_APP_INFO, type ToolDef } from "../src/tools.ts";
import { request, setup } from "./helpers.ts";

// Test-only tool: rendering is an example licence layer, not an MVP tool (plan.md §4a).
const RENDER_VIEW: ToolDef = { ...CAPTURE_VIEW, name: "render_view", comMethod: "View.Capture", licenseFeatures: ["rendering"] };
const tools = [GET_APP_INFO, RENDER_VIEW];

test("13a. base licence missing → unlicensed{feature: base}, COM not called", async () => {
  const { com, deps } = setup({ tools });
  const result = await handleToolCall(deps, request("get_app_info", {}, { token: "agent-unlicensed-token" }));
  assert.deepEqual(!result.ok && result.error.detail, { feature: "base" });
  assert.equal(com.calls.length, 0);
});

test("13b. base but not rendering → unlicensed{feature: rendering}, COM not called", async () => {
  const { com, license, deps } = setup({ tools });
  const result = await handleToolCall(deps, request("render_view", { viewId: "view-1" }, { token: "agent-baseonly-token" }));
  assert.deepEqual(!result.ok && result.error.detail, { feature: "rendering" });
  assert.deepEqual(license.checks.map((c) => c.feature), ["base", "rendering"]);
  assert.equal(com.calls.length, 0);
});

test("13c. base-only tools never call the feature check", async () => {
  const { license, deps } = setup({ tools });
  await handleToolCall(deps, request("get_app_info", {}));
  assert.deepEqual(license.checks.map((c) => c.feature), ["base"]);
});

test("13d. licence service down → license_unavailable (fail closed), COM not called", async () => {
  const { com, license, telemetry, deps } = setup({ tools });
  license.down = true;
  const result = await handleToolCall(deps, request("get_app_info", {}));
  assert.equal(!result.ok && result.error.code, "license_unavailable");
  assert.equal(com.calls.length, 0);
  assert.equal(telemetry.toolCalls()[0]?.outcome, "denied");
});

test("14a. a rendering seat is released after success and after a COM failure", async () => {
  const { com, license, telemetry, deps } = setup({ tools, seatFeatures: ["rendering"] });
  const ok = await handleToolCall(deps, request("render_view", { viewId: "view-1" }));
  assert.equal(ok.ok, true);
  assert.equal(license.seatsHeld, 0);

  com.enqueue({ hresult: 0x80004005 });
  const failed = await handleToolCall(deps, request("render_view", { viewId: "view-1" }, { correlationId: "c-2" }));
  assert.equal(!failed.ok && failed.error.code, "app_error");
  assert.equal(license.seatsHeld, 0);

  assert.deepEqual(telemetry.toolCalls()[0]?.licenseFeatures, ["base", "rendering"]);
  const releases = telemetry.licenseReleases();
  assert.deepEqual(releases.map((e) => [e.correlationId, e.failed]), [["c-1", []], ["c-2", []]]);
  assert.ok(releases.every((e) => e.features.includes("rendering") && e.seatHoldMs >= 0));
});

test("14b. on caller timeout the seat stays held until COM really finishes, then is released (LIC14)", async () => {
  const { com, license, telemetry, deps } = setup({ tools, seatFeatures: ["rendering"], session: { deadlineMs: 30 } });
  com.enqueue({ ok: "slow", delayMs: 80 });
  const timedOut = await handleToolCall(deps, request("render_view", { viewId: "view-1" }));
  assert.equal(!timedOut.ok && timedOut.error.code, "timeout");
  assert.equal(license.seatsHeld, 1); // the app is still rendering
  assert.equal(telemetry.licenseReleases().length, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(license.seatsHeld, 0);
  assert.ok((telemetry.licenseReleases()[0]?.seatHoldMs ?? 0) >= 70);
});

test("14c. a seat that fails to release is reported in telemetry and doesn't change the result", async () => {
  const { license, telemetry, deps } = setup({ tools, seatFeatures: ["rendering"] });
  license.failReleases = true;
  const result = await handleToolCall(deps, request("render_view", { viewId: "view-1" }));
  assert.equal(result.ok, true);
  assert.deepEqual(telemetry.licenseReleases()[0]?.failed, ["rendering"]);
});

test("14d. entitlement-only calls emit no licence release event", async () => {
  const { telemetry, deps } = setup({ tools });
  await handleToolCall(deps, request("get_app_info", {}));
  assert.equal(telemetry.licenseReleases().length, 0);
});
