// Shared wiring for pipeline-level tests.
import { ComSession, type SessionConfig } from "../src/comSession.ts";
import { FakeAuth, FakeCadModel, FakeComClient, FakeLicense, GRANTS, RecordingTelemetry, TOKENS } from "../src/fakes.ts";
import type { PipelineDeps, ToolRequest } from "../src/pipeline.ts";
import type { Telemetry } from "../src/telemetry.ts";
import { ALL_TOOLS, createRegistry, type ToolDef } from "../src/tools.ts";

export const TEST_SESSION: SessionConfig = { maxPending: 10, deadlineMs: 200, retryAttempts: 3, retryBaseMs: 5 };

export interface SetupOptions {
  tools?: ToolDef[];
  telemetry?: Telemetry;
  seatFeatures?: string[];
  maxResultBytes?: number;
  session?: Partial<SessionConfig>;
}

export function setup(options: SetupOptions = {}) {
  const model = FakeCadModel.sample();
  const com = new FakeComClient({ handler: model.handle });
  const telemetry = new RecordingTelemetry();
  const sink = options.telemetry ?? telemetry;
  const auth = new FakeAuth(TOKENS);
  const license = new FakeLicense(GRANTS, options.seatFeatures);
  const deps: PipelineDeps = {
    auth,
    license,
    session: new ComSession(com, sink, { ...TEST_SESSION, ...options.session }),
    telemetry: sink,
    tools: createRegistry(options.tools ?? ALL_TOOLS),
    maxResultBytes: options.maxResultBytes,
  };
  return { model, com, telemetry, auth, license, deps };
}

export function request(tool: string, input: unknown, overrides: Partial<ToolRequest> = {}): ToolRequest {
  return { tool, input, token: "agent-token", correlationId: "c-1", ...overrides };
}
