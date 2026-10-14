import assert from "node:assert/strict";
import { test } from "node:test";
import { solve } from "../src/solution.ts";

test("smoke test: local TS runtime works", () => {
  assert.equal(solve({ values: [1, 2, 3] }), 6);
});

test("edge case: empty input", () => {
  assert.equal(solve({ values: [] }), 0);
});
