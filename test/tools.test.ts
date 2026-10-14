import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolError } from "../src/errors.ts";
import { outcomeFor, pseudonymise } from "../src/telemetry.ts";
import { ALL_TOOLS, createRegistry, pageArgs, requireColor, requireIds, requireString } from "../src/tools.ts";

test("requireString accepts a non-empty string", () => {
  assert.equal(requireString({ id: "a" }, "id"), "a");
});

test("requireString rejects missing, empty, wrong-type and non-object input", () => {
  for (const input of [{}, { id: "" }, { id: "  " }, { id: 5 }, null, "id", ["id"]]) {
    assert.throws(() => requireString(input, "id"), (e) => e instanceof ToolError && e.code === "invalid_input");
  }
});

test("registry rejects duplicate tool names", () => {
  const [first] = ALL_TOOLS;
  assert.ok(first);
  assert.throws(() => createRegistry([first, first]), /Duplicate tool name/);
});

test("every registered tool accepts its own example input", () => {
  for (const def of ALL_TOOLS) assert.doesNotThrow(() => def.toArgs(def.example), def.name);
});

test("tool names are unique and only reads, views and idempotent writes are retry-safe", () => {
  assert.equal(createRegistry(ALL_TOOLS).size, 8);
  for (const def of ALL_TOOLS) assert.equal(def.retrySafe, true, def.name); // MVP: undo_last_change would be false
});

test("requireIds rejects empty, oversized and non-string lists", () => {
  for (const ids of [[], Array.from({ length: 101 }, (_, i) => `e${i}`), [1], [""], "box-1"]) {
    assert.throws(() => requireIds({ ids }, "ids"), (e) => e instanceof ToolError && e.code === "invalid_input");
  }
});

test("pageArgs defaults, bounds and cursor type", () => {
  assert.deepEqual(pageArgs({}), [50, null]);
  assert.deepEqual(pageArgs({ pageSize: 100, cursor: "50" }), [100, "50"]);
  for (const input of [{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { cursor: 5 }]) {
    assert.throws(() => pageArgs(input), (e) => e instanceof ToolError && e.code === "invalid_input");
  }
});

test("requireColor normalises #rrggbb and rejects other forms", () => {
  assert.equal(requireColor({ color: "#ff0000" }, "color"), "#FF0000");
  for (const color of ["red", "#F00", "FF0000"]) {
    assert.throws(() => requireColor({ color }, "color"), (e) => e instanceof ToolError && e.code === "invalid_input");
  }
});

test("outcome mapping groups error codes", () => {
  assert.equal(outcomeFor(undefined), "success");
  assert.equal(outcomeFor("invalid_input"), "invalid");
  assert.equal(outcomeFor("forbidden"), "denied");
  assert.equal(outcomeFor("auth_unavailable"), "denied");
  assert.equal(outcomeFor("timeout"), "error");
});

test("pseudonymise is stable and does not contain the subject", () => {
  assert.equal(pseudonymise("user-123"), pseudonymise("user-123"));
  assert.notEqual(pseudonymise("user-123"), pseudonymise("user-456"));
  assert.ok(!pseudonymise("user-123").includes("user-123"));
});
