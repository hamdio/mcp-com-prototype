import assert from "node:assert/strict";
import { test } from "node:test";
import { NOMINAL, runValidation } from "../src/validation/run.ts";

test("nominal profile passes every gate", async () => {
  const report = await runValidation(NOMINAL);
  assert.deepEqual(report.gates.filter((g) => !g.pass).map((g) => g.name), []);
  assert.equal(report.maxComCallsInFlight, 1);
});

test("the suite catches a bad configuration: no retries under 30% busy", async () => {
  const report = await runValidation({
    ...NOMINAL,
    transientRate: 0.3,
    session: { ...NOMINAL.session, retryAttempts: 1 },
  });
  assert.equal(report.pass, false);
  const failed = report.gates.filter((g) => !g.pass).map((g) => g.name);
  assert.ok(failed.includes("non-user error rate"), failed.join(", "));
  assert.ok(failed.includes("WF-2 task success rate"), failed.join(", "));
});

test("the suite catches an overloaded queue", async () => {
  const report = await runValidation({
    ...NOMINAL,
    concurrency: 10,
    session: { ...NOMINAL.session, maxPending: 5 },
  });
  assert.equal(report.pass, false);
});
