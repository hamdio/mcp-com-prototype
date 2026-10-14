// Test doubles shared by the unit tests (L1/L2) and the validation runner. Runs on any OS.
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthClient, Principal } from "./auth.ts";
import type { ComClient } from "./comSession.ts";
import { ComError, RPC_E_CALL_REJECTED, ToolError } from "./errors.ts";
import { BASE_LICENSE, type LicenseClient, type LicenseLease } from "./license.ts";
import { SCOPES } from "./tools.ts";
import type { SessionStateEvent, Telemetry, TelemetryEvent, ToolCallEvent } from "./telemetry.ts";

export class FakeAuth implements AuthClient {
  down = false;
  verifyCalls = 0;
  private readonly tokens: Map<string, Principal>;

  constructor(tokens: Record<string, Principal>) {
    this.tokens = new Map(Object.entries(tokens));
  }

  async verify(token: string): Promise<Principal> {
    this.verifyCalls++;
    if (this.down) throw new Error("connect ECONNREFUSED auth.example");
    const principal = this.tokens.get(token);
    if (!principal) throw new ToolError("unauthenticated", "Unknown token");
    return principal;
  }
}

/** Grants per subject; features listed in `seatFeatures` behave as floating seats and count checkouts. */
export class FakeLicense implements LicenseClient {
  down = false;
  readonly checks: Array<{ subject: string; feature: string }> = [];
  seatsHeld = 0;
  private readonly grants: Map<string, Set<string>>;
  private readonly seatFeatures: Set<string>;

  constructor(grants: Record<string, string[]>, seatFeatures: string[] = []) {
    this.grants = new Map(Object.entries(grants).map(([subject, features]) => [subject, new Set(features)]));
    this.seatFeatures = new Set(seatFeatures);
  }

  async acquire(subject: string, feature: string): Promise<LicenseLease> {
    this.checks.push({ subject, feature });
    if (this.down) throw new Error("licence server timeout");
    if (!this.grants.get(subject)?.has(feature)) throw new ToolError("unlicensed", `No ${feature} licence`);
    if (!this.seatFeatures.has(feature)) return { release: async () => {} };
    this.seatsHeld++;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.seatsHeld--;
      },
    };
  }
}

export type ScriptStep =
  | { ok: unknown; delayMs?: number }
  | { hresult: number; delayMs?: number }
  | { throws: Error; delayMs?: number };

export type ComHandler = (method: string, args: unknown[]) => unknown;

export interface FakeComOptions {
  latencyMs?: number; // used when the script is empty
  transientRate?: number; // 0..1 chance of RPC_E_CALL_REJECTED when the script is empty
  seed?: number;
  handler?: ComHandler; // answers calls when the script is empty; default echoes method + args
}

/** Raw text includes a file path so tests can prove it never reaches the agent (E6). */
export function rawComText(hresult: number): string {
  return `Raw COM failure 0x${hresult.toString(16)} in C:\\Program Files\\App\\core.dll`;
}

export class FakeComClient implements ComClient {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  connects = 0;
  inFlight = 0;
  maxInFlight = 0;
  private failConnects = 0;
  private readonly script: ScriptStep[] = [];
  private readonly latencyMs: number;
  private readonly transientRate: number;
  private readonly rng: () => number;
  private readonly handler: ComHandler;

  constructor(options: FakeComOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.transientRate = options.transientRate ?? 0;
    this.rng = mulberry32(options.seed ?? 1);
    this.handler = options.handler ?? ((method, args) => ({ method, args }));
  }

  /** Scripted responses are used first, in order. */
  enqueue(...steps: ScriptStep[]): this {
    this.script.push(...steps);
    return this;
  }

  failNextConnects(count: number): this {
    this.failConnects = count;
    return this;
  }

  async connect(): Promise<void> {
    this.connects++;
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error("Class not registered");
    }
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const step = this.script.shift();
      await sleep(step?.delayMs ?? this.latencyMs);
      if (step) {
        if ("hresult" in step) throw new ComError(step.hresult, rawComText(step.hresult));
        if ("throws" in step) throw step.throws;
        return step.ok;
      }
      if (this.rng() < this.transientRate) {
        throw new ComError(RPC_E_CALL_REJECTED, rawComText(RPC_E_CALL_REJECTED));
      }
      return this.handler(method, args);
    } finally {
      this.inFlight--;
    }
  }
}

export interface FakeElement {
  id: string;
  type: string;
  level: string;
  layer: string;
  color: string;
  viewIds: string[];
}

export interface ElementFilter {
  type: string | null;
  level: string | null;
  layer: string | null;
}

const E_INVALIDARG = 0x80070057;
const DISP_E_UNKNOWNNAME = 0x80020006;

/**
 * In-memory stand-in for the CAD app behind COM. Method names are PLACEHOLDERS (see tools.ts).
 * Paging lives here because the real adapter will page inside one COM round-trip.
 */
export class FakeCadModel {
  readonly productName = "Desktop CAD (fake)";
  readonly version = "2026.1.0";
  readonly activeViewId = "view-1";
  readonly elements = new Map<string, FakeElement>();
  zoomedTo: string[] = [];

  /** 1 box + 12 columns (6 on L2 in view) + 300 lines in view-1. */
  static sample(): FakeCadModel {
    const model = new FakeCadModel();
    model.add({ id: "box-1", type: "box", level: "L1", layer: "A", color: "#808080", viewIds: ["view-1"] });
    for (let i = 1; i <= 12; i++) {
      model.add({
        id: `col-${i}`,
        type: "column",
        level: i <= 6 ? "L2" : "L3",
        layer: "S",
        color: "#C0C0C0",
        viewIds: i <= 6 ? ["view-1"] : [],
      });
    }
    for (let i = 1; i <= 300; i++) {
      model.add({ id: `line-${i}`, type: "line", level: "L1", layer: "A", color: "#000000", viewIds: ["view-1"] });
    }
    return model;
  }

  add(element: FakeElement): void {
    this.elements.set(element.id, element);
  }

  readonly handle: ComHandler = (method, args) => {
    switch (method) {
      case "App.GetInfo":
        return { productName: this.productName, version: this.version };
      case "View.GetActive":
        return { viewId: this.activeViewId };
      case "View.ListElements": {
        const [viewId, pageSize, cursor] = args as [string, number, string | null];
        this.requireView(viewId);
        return page([...this.elements.values()].filter((e) => e.viewIds.includes(viewId)), pageSize, cursor);
      }
      case "Model.QueryElements": {
        const [filter, pageSize, cursor] = args as [ElementFilter, number, string | null];
        const matches = [...this.elements.values()].filter(
          (e) =>
            (filter.type === null || e.type === filter.type) &&
            (filter.level === null || e.level === filter.level) &&
            (filter.layer === null || e.layer === filter.layer),
        );
        return page(matches, pageSize, cursor);
      }
      case "Element.GetProperties": {
        const [ids] = args as [string[]];
        return ids.map((id) => ({ ...this.get(id) }));
      }
      case "Element.SetColor": {
        const [ids, color] = args as [string[], string];
        const targets = ids.map((id) => this.get(id)); // look up all first: all-or-nothing
        const previous = targets.map((e) => ({ id: e.id, color: e.color }));
        for (const e of targets) e.color = color;
        return { previous };
      }
      case "View.ZoomTo": {
        const [viewId, ids] = args as [string, string[]];
        this.requireView(viewId);
        ids.forEach((id) => this.get(id));
        this.zoomedTo = ids;
        return { viewId, zoomedTo: ids.length };
      }
      case "View.Capture": {
        const [viewId] = args as [string];
        this.requireView(viewId);
        return { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==" };
      }
      default:
        throw new ComError(DISP_E_UNKNOWNNAME, `Unknown member ${method}`);
    }
  };

  private get(id: string): FakeElement {
    const element = this.elements.get(id);
    if (!element) throw new ComError(E_INVALIDARG, `Element ${id} not found`);
    return element;
  }

  private requireView(viewId: string): void {
    if (viewId !== this.activeViewId) throw new ComError(E_INVALIDARG, `View ${viewId} not found`);
  }
}

function page(list: FakeElement[], pageSize: number, cursor: string | null) {
  const offset = cursor === null ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new ComError(E_INVALIDARG, `Bad cursor ${cursor}`);
  const items = list.slice(offset, offset + pageSize).map(({ id, type, level, layer }) => ({ id, type, level, layer }));
  const next = offset + pageSize;
  return { items, total: list.length, nextCursor: next < list.length ? String(next) : null };
}

export class RecordingTelemetry implements Telemetry {
  readonly events: TelemetryEvent[] = [];

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }

  toolCalls(): ToolCallEvent[] {
    return this.events.filter((e): e is ToolCallEvent => e.type === "tool_call");
  }

  sessionStates(): SessionStateEvent[] {
    return this.events.filter((e): e is SessionStateEvent => e.type === "session_state");
  }
}

/** Small seeded PRNG so fault-injection runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_SCOPES = [SCOPES.read, SCOPES.view, SCOPES.write];

export const PRINCIPALS = {
  agent: { subject: "user-123", actor: "assistant-agent", callerType: "agent", scopes: ALL_SCOPES },
  agentReadOnly: { subject: "user-123", actor: "readonly-agent", callerType: "agent", scopes: [SCOPES.read] },
  agentNoScope: { subject: "user-123", actor: "restricted-agent", callerType: "agent", scopes: [] },
  app: { subject: "user-123", actor: "desktop-app", callerType: "app", scopes: ALL_SCOPES },
  agentUnlicensed: { subject: "user-456", actor: "assistant-agent", callerType: "agent", scopes: ALL_SCOPES },
  agentBaseOnly: { subject: "user-789", actor: "assistant-agent", callerType: "agent", scopes: ALL_SCOPES },
} satisfies Record<string, Principal>;

export const TOKENS: Record<string, Principal> = {
  "agent-token": PRINCIPALS.agent,
  "agent-readonly-token": PRINCIPALS.agentReadOnly,
  "agent-noscope-token": PRINCIPALS.agentNoScope,
  "app-token": PRINCIPALS.app,
  "agent-unlicensed-token": PRINCIPALS.agentUnlicensed,
  "agent-baseonly-token": PRINCIPALS.agentBaseOnly,
};

/** user-123: base + rendering; user-789: base only; user-456: nothing. */
export const GRANTS: Record<string, string[]> = {
  "user-123": [BASE_LICENSE, "rendering"],
  "user-789": [BASE_LICENSE],
};
