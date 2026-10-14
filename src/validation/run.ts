// Runs workflow scenarios concurrently against fakes, then scores them with the KPI gates.
// This is L2 + a scripted stand-in for L4/L5; it can't measure agent tool choice (needs a real agent).
import { ComSession, type SessionConfig } from "../comSession.ts";
import { FakeAuth, FakeCadModel, FakeComClient, FakeLicense, GRANTS, RecordingTelemetry, TOKENS } from "../fakes.ts";
import { computeKpis, DEFAULT_LIMITS, gate, type Expectations, type Gate, type KpiLimits, type KpiReport } from "../kpi.ts";
import { handleToolCall, type PipelineDeps } from "../pipeline.ts";
import { ALL_TOOLS, createRegistry, type ToolDef } from "../tools.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

export interface ValidationConfig {
  rounds: number; // each round runs every scenario `concurrency` times in parallel
  concurrency: number;
  comLatencyMs: number;
  transientRate: number;
  seed: number;
  minWorkflowSuccessRate: number; // plan.md §3.3 (proposed: 0.9)
  session: SessionConfig;
  limits: KpiLimits;
}

export const NOMINAL: ValidationConfig = {
  rounds: 5,
  concurrency: 3,
  comLatencyMs: 2,
  transientRate: 0.05,
  seed: 42,
  minWorkflowSuccessRate: 0.9,
  session: { maxPending: 64, deadlineMs: 2_000, retryAttempts: 3, retryBaseMs: 5 },
  limits: DEFAULT_LIMITS,
};

export interface ValidationReport {
  kpis: KpiReport;
  workflowSuccess: Record<string, number>;
  gates: Gate[];
  pass: boolean;
  maxComCallsInFlight: number;
}

export async function runValidation(
  config: ValidationConfig,
  scenarios: Scenario[] = SCENARIOS,
  tools: ToolDef[] = ALL_TOOLS,
): Promise<ValidationReport> {
  const telemetry = new RecordingTelemetry();
  const model = FakeCadModel.sample();
  const com = new FakeComClient({
    latencyMs: config.comLatencyMs,
    transientRate: config.transientRate,
    seed: config.seed,
    handler: model.handle,
  });
  const license = new FakeLicense(GRANTS);
  const deps: PipelineDeps = {
    auth: new FakeAuth(TOKENS),
    license,
    session: new ComSession(com, telemetry, config.session),
    telemetry,
    tools: createRegistry(tools),
  };
  const expect: Expectations = { correlationIds: [], callerTypes: new Map() };
  const runs = new Map<string, { total: number; passed: number }>();

  async function runOnce(scenario: Scenario, instance: string): Promise<void> {
    let passed = true;
    for (const [index, step] of scenario.steps.entries()) {
      const correlationId = `${scenario.workflowId}-${instance}-${index}`;
      expect.correlationIds.push(correlationId);
      expect.callerTypes.set(correlationId, scenario.callerType);
      const result = await handleToolCall(deps, {
        tool: step.tool,
        input: step.input,
        token: scenario.token,
        correlationId,
        workflowId: scenario.workflowId,
      });
      const got = result.ok ? "success" : result.error.code;
      if (got !== step.expect || (result.ok && step.check && !step.check(result.data))) {
        passed = false;
        break; // a workflow stops at its first unexpected result, as an agent would have to replan
      }
    }
    if (passed && scenario.verify && !scenario.verify(model)) passed = false;
    const tally = runs.get(scenario.workflowId) ?? { total: 0, passed: 0 };
    tally.total++;
    if (passed) tally.passed++;
    runs.set(scenario.workflowId, tally);
  }

  for (let round = 0; round < config.rounds; round++) {
    const batch: Promise<void>[] = [];
    for (const scenario of scenarios) {
      for (let k = 0; k < config.concurrency; k++) batch.push(runOnce(scenario, `${round}.${k}`));
    }
    await Promise.all(batch);
  }

  const kpis = computeKpis(telemetry.events, expect, config.limits);
  const workflowSuccess: Record<string, number> = {};
  const gates: Gate[] = [
    ...kpis.gates,
    gate("COM calls in flight at once", com.maxInFlight, "<=", 1),
    gate("licence seats still held after the run", license.seatsHeld, "<=", 0),
  ];
  for (const [workflowId, tally] of runs) {
    workflowSuccess[workflowId] = tally.passed / tally.total;
    gates.push(gate(`${workflowId} task success rate`, tally.passed / tally.total, ">=", config.minWorkflowSuccessRate));
  }
  return { kpis, workflowSuccess, gates, pass: gates.every((g) => g.pass), maxComCallsInFlight: com.maxInFlight };
}

export function formatReport(report: ValidationReport): string {
  const lines = report.gates.map(
    (g) => `${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${Number(g.actual.toFixed(3))} (limit ${g.comparison} ${g.limit})`,
  );
  lines.push(`\n${report.kpis.metrics.toolCalls} tool calls, ${report.kpis.metrics.retryRecovered} recovered by retry`);
  lines.push(report.pass ? "VALIDATION PASSED" : "VALIDATION FAILED");
  return lines.join("\n");
}
