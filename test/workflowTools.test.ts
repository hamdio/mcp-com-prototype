import assert from "node:assert/strict";
import { test } from "node:test";
import { RPC_E_CALL_REJECTED } from "../src/errors.ts";
import { handleToolCall } from "../src/pipeline.ts";
import { request, setup } from "./helpers.ts";

const paint = { ids: ["box-1"], color: "#FF0000" };

test("10. set_element_color twice gives the same end state and reports each previous colour", async () => {
  const { model, deps } = setup();
  const first = await handleToolCall(deps, request("set_element_color", paint));
  const second = await handleToolCall(deps, request("set_element_color", paint, { correlationId: "c-2" }));
  assert.deepEqual(first, { ok: true, data: { previous: [{ id: "box-1", color: "#808080" }] } });
  assert.deepEqual(second, { ok: true, data: { previous: [{ id: "box-1", color: "#FF0000" }] } });
  assert.equal(model.elements.get("box-1")?.color, "#FF0000");
});

test("10b. set_element_color is retried on a transient error (idempotent set), and telemetry counts elements", async () => {
  const { com, telemetry, deps } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED });
  const result = await handleToolCall(deps, request("set_element_color", paint));
  assert.equal(result.ok, true);
  const [event] = telemetry.toolCalls();
  assert.equal(event?.attempts, 2);
  assert.equal(event?.elementCount, 1);
  assert.equal(event?.effect, "model");
});

test("10c. an unknown element ID changes nothing (all-or-nothing)", async () => {
  const { model, deps } = setup();
  const result = await handleToolCall(deps, request("set_element_color", { ids: ["box-1", "missing"], color: "#FF0000" }));
  assert.equal(!result.ok && result.error.code, "app_error");
  assert.equal(model.elements.get("box-1")?.color, "#808080");
});

test("11. a write without explicit IDs → invalid_input; a read-only agent → forbidden; COM untouched", async () => {
  const { com, deps } = setup();
  const noIds = await handleToolCall(deps, request("set_element_color", { color: "#FF0000" }));
  const emptyIds = await handleToolCall(deps, request("set_element_color", { ids: [], color: "#FF0000" }));
  const readOnly = await handleToolCall(deps, request("set_element_color", paint, { token: "agent-readonly-token" }));
  assert.equal(!noIds.ok && noIds.error.code, "invalid_input");
  assert.equal(!emptyIds.ok && emptyIds.error.code, "invalid_input");
  assert.equal(!readOnly.ok && readOnly.error.code, "forbidden");
  assert.equal(com.calls.length, 0);
});

test("12a. list_elements_in_view pages through every element exactly once", async () => {
  const { deps } = setup();
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const result = await handleToolCall(deps, request("list_elements_in_view", { viewId: "view-1", pageSize: 100, cursor }));
    assert.ok(result.ok);
    const data = result.data as { items: Array<{ id: string }>; nextCursor: string | null; total: number };
    assert.ok(data.items.length <= 100);
    for (const item of data.items) {
      assert.ok(!seen.has(item.id), `duplicate ${item.id}`);
      seen.add(item.id);
    }
    cursor = data.nextCursor;
    pages++;
  } while (cursor !== null);
  assert.equal(seen.size, 307); // box + 6 columns + 300 lines in view-1
  assert.equal(pages, 4);
});

test("12b. pageSize above the cap → invalid_input before COM", async () => {
  const { com, deps } = setup();
  const result = await handleToolCall(deps, request("query_elements", { pageSize: 101 }));
  assert.equal(!result.ok && result.error.code, "invalid_input");
  assert.equal(com.calls.length, 0);
});

test("12c. a result over the byte cap is withheld → result_too_large, size recorded in telemetry", async () => {
  const { telemetry, deps } = setup({ maxResultBytes: 500 });
  const result = await handleToolCall(deps, request("query_elements", { pageSize: 100 }));
  assert.equal(!result.ok && result.error.code, "result_too_large");
  const [event] = telemetry.toolCalls();
  assert.ok((event?.resultBytes ?? 0) > 500);
  assert.equal(event?.outcome, "error");
});

test("WF-5: zoom then capture returns an image and changes only the view", async () => {
  const { model, deps } = setup();
  const before = model.elements.get("box-1")?.color;
  const zoom = await handleToolCall(deps, request("zoom_to_elements", { viewId: "view-1", ids: ["box-1"] }));
  const capture = await handleToolCall(deps, request("capture_view", { viewId: "view-1" }));
  assert.equal(zoom.ok, true);
  assert.equal(capture.ok && (capture.data as { mimeType: string }).mimeType, "image/png");
  assert.deepEqual(model.zoomedTo, ["box-1"]);
  assert.equal(model.elements.get("box-1")?.color, before);
});
