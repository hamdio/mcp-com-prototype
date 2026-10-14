import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TOOLS, handleToolCall, M1_TOOLS } from "../src/solution.ts";

test("public entry exports the pipeline and tools", () => {
  assert.equal(typeof handleToolCall, "function");
  assert.deepEqual(M1_TOOLS.map((t) => t.name), ["get_app_info", "query_elements"]);
  assert.equal(ALL_TOOLS.length, 8);
});
