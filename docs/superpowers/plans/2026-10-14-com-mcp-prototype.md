# COM-backed MCP Prototype + Validation Suite: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, OS-independent prototype of the MCP tool pipeline over the CAD app's COM API: all 8 MVP tools from the 5 agreed workflows, with delegated auth, licence layers, a single-threaded COM session, telemetry, and a validation suite that scores the plan's KPI gates and fails the build when one breaks.

**Architecture:** `handleToolCall` is a plain async function. It looks up a declarative `ToolDef`, validates input, verifies the delegated token, checks the actor's scope and the user's licence layers, and then queues the COM call on a single `ComSession`. That session runs one call at a time with a deadline, retries and reconnects. Every path ends with exactly one telemetry event. COM, auth and licensing sit behind interfaces with in-memory fakes, including a fake CAD model, so everything runs on macOS and Linux CI. A validation runner replays the workflows concurrently with seeded fault injection and computes the KPIs from telemetry alone.

**Tech Stack:** TypeScript 5.9 (strict, ESM, `verbatimModuleSyntax`), Node 22+ via `tsx`, `node:test` + `node:assert/strict`. No new packages.

**Spec:** `docs/plan.md` (owned by the `mcp-com-api-design` session). Read §2 (workflows and tool catalogue), §3 (KPIs and layers), §4/§4a (delegation, licensing), §5 (constraints), §6 (pipeline) and §8 (tests) before starting.

**Verification status:** every code block below was run as a whole in a scratch copy of this repo on 2026-10-14. Results: `tsc --noEmit` clean, **63/63 tests pass**, and `npm run validate` reports **VALIDATION PASSED** (18/18 gates over 195 simulated tool calls). Timings are on the fakes only; they say nothing about real COM.

## Global Constraints

- No new dependencies. `@modelcontextprotocol/sdk` (stdio transport) is out of scope here and needs the candidate's explicit approval (plan.md M4).
- Source files use `.ts` import specifiers and `import type` for type-only imports (`verbatimModuleSyntax`). Don't use parameter properties: assign fields in the constructor.
- All COM method names (`App.GetInfo`, `Model.QueryElements`, …) and the licence feature IDs are **placeholders** until the CAD architects and the licensing team confirm them (plan.md §10).
- All numeric limits are **(proposed)** values from plan.md §3.2 / §5: `maxPending 10`, `deadlineMs 30_000`, `retryAttempts 3`, `retryBaseMs 200`, `MAX_PAGE_SIZE 100`, `MAX_IDS_PER_CALL 100`, `MAX_RESULT_BYTES 100_000`. Don't present them as measured.
- The agent never sees raw COM text or HRESULTs (E6). `callerType` comes only from the verified token (D2).
- `docs/plan.md`, `README.md`, `CLAUDE.md`, `package.json`, `.github/` and `.githooks/` are owned by the `mcp-com-api-design` session. This plan creates only `src/` and `test/` files, plus overwriting the starter `src/solution.ts`, `src/main.ts` and `test/solution.test.ts`.
- **Two deliberate gaps against CLAUDE.md's invariants, both closed by the M2b follow-on plan:**
  - Session and deadline tests use real timers with small windows, while CLAUDE.md prefers injectable clocks.
  - Modifier tools are not yet gated on desktop-user activity (P11).
- This folder is not a git repository. Each task ends with a **checkpoint** (`npm run typecheck` + the task's tests). If the repo is put under git, commit at each checkpoint.

## Review Focus

These failure modes aren't the headline of any test number in plan.md §8, but they're the ones most likely to hurt a real user. Each is pinned by a test in the task named.

1. **A hung COM call** (modal dialog): its caller gets `timeout` at the deadline, and calls queued behind it must also time out **without** ever reaching COM. Task 3: *"a hung call times out its caller…"*.
2. **Signed HRESULTs from the COM bridge**: winax and .NET give `-2147418111` where the docs say `0x80010001`. These must classify the same. Task 1: *"signed HRESULT…"*.
3. **The telemetry sink throws**: the tool call must still succeed (T3). Task 4: *"a throwing telemetry sink…"*.
4. **The adapter throws a non-COM error** (a bug in our adapter): the result is `internal`, with no retry, so a programming error isn't hammered three times against the UI thread. Task 3: *"a non-COM throw…"*.
5. **The caller times out while holding a licence seat**: the seat is released anyway, so seats can't leak (LIC3). Task 5: test 14.

**Known risks this plan deliberately does not solve.** They've been raised with the design session and need a decision:
- **A retried write reports the wrong "previous" colour.** If attempt 1 applied the colour but the call then failed (session lost mid-call), the retry's `previous` is the new colour.
- **A stale element ID surfaces as `app_error`.** The taxonomy has no `not_found` (E1).
- **The seat is released at caller timeout** while COM may still be rendering (interacts with LIC10).
- **Failed seat releases are invisible.** `lease.release()` failures are swallowed with no telemetry, so a seat leak in production couldn't be seen. Found in execution review.
- **Unknown tool names are logged verbatim** in telemetry, so the field's cardinality is unbounded. Found in execution review.

## Decisions taken in this plan (flag to the candidate)

| Decision | Choice here | Why / alternative |
|---|---|---|
| Validate before auth | Validate first | Saves a remote round-trip on bad input. It reveals the input shape to unauthenticated callers; that's acceptable for local stdio. |
| Retry rule | Keyed on `ToolDef.retrySafe`, not on read/write | `set_element_color` is an idempotent set (W1). The §3.1 gate is reworded to "non-retry-safe calls retried = 0". |
| Backoff jitter | None | One local stdio client means no thundering herd. Add jitter if the server becomes shared. |
| Licence model | `LicenseClient.acquire(subject, feature) → lease`, base always checked first | Covers the plain entitlement (no-op release) and the floating seat (release in `finally`). Serial and named-user activation are M2b. |
| Oversized result | New code `result_too_large` (outcome `error`) | The COM call already happened, so it isn't `invalid_input`. Needs the candidate's OK because it extends E1. |
| Identity check frequency (D6) | Verify per call | Simplest and correct. Caching per MCP session is an M2b optimisation once auth latency is baselined. |
| Colour model | `#RRGGBB`, normalised to upper case | Open question (index vs RGB). |
| `maxPending` | Counts in-flight + queued calls | One number to tune. The pending slot frees only when COM really finishes, not when the caller times out. |

## File Structure

| File | Responsibility |
|---|---|
| `src/errors.ts` | `ErrorCode` taxonomy, `ToolError` (+ telemetry meta), `ComError`, HRESULT classification, agent-safe messages |
| `src/auth.ts` | `Principal`, `CallerType`, `AuthClient` contract (delegated token → subject/actor/scopes) |
| `src/license.ts` | `LicenseClient` / `LicenseLease` contract, `BASE_LICENSE` |
| `src/telemetry.ts` | Event types, `safeEmit`, outcome mapping, pseudonymisation |
| `src/tools.ts` | `ToolDef`, input validators, pagination/size constants, the 8-tool catalogue, `M1_TOOLS`, `ALL_TOOLS` |
| `src/comSession.ts` | `ComClient` seam; `ComSession`: FIFO queue, bounded admission, deadline, retry, reconnect, lifecycle events |
| `src/pipeline.ts` | `handleToolCall`: the request pipeline of plan.md §6 |
| `src/fakes.ts` | `FakeAuth`, `FakeLicense` (seat counting), `FakeComClient` (script + seeded faults), `FakeCadModel`, `RecordingTelemetry`, fixtures |
| `src/kpi.ts` | KPI and gate computation from telemetry (works on production events too, T5) |
| `src/validation/scenarios.ts` | WF-1…WF-5 + guard scenarios with success checks |
| `src/validation/run.ts` | Concurrent scenario runner + report formatting |
| `src/validation/cli.ts` | `npm run validate` entry; exit code 1 on any failed gate |
| `src/solution.ts` | Public entry (replaces the starter `solve()`) |
| `src/main.ts` | `npm start` → runs the validation report |
| `test/helpers.ts` | Shared pipeline wiring for tests (not matched by `test/*.test.ts`) |
| `test/*.test.ts` | One file per module / acceptance area |

Milestone mapping (plan.md §9): Tasks 1–4 = **M1** (tests 1–4, 9) with the minimal session pulled forward, because the pipeline calls through it. Task 3 also delivers **M2** (tests 5–8). Task 5 = **M3** acceptance (tests 10–12) plus licence layers (tests 13–14). Tasks 6–7 = the validation suite (L1/L2 plus a scripted stand-in for L4/L5).

---

### Task 1: Error taxonomy and COM error classification

**Files:**
- Create: `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ErrorCode`; `interface CallMeta { hresult?, attempts?, queueWaitMs?, comMs?, feature? }`; `class ToolError(code, message, meta = {})` with `.code`, `.meta`; `class ComError(hresult, message)` with `.hresult` (normalised unsigned); constants `RPC_E_CALL_REJECTED`, `RPC_E_SERVERCALL_RETRYLATER`, `RPC_E_DISCONNECTED`, `RPC_S_SERVER_UNAVAILABLE`; `classifyComError(hresult): "transient" | "session_lost" | "permanent"`; `agentMessage(err: ToolError): string`.

- [ ] **Step 1: Write the failing test** at `test/errors.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentMessage,
  classifyComError,
  ComError,
  RPC_E_CALL_REJECTED,
  RPC_E_DISCONNECTED,
  RPC_S_SERVER_UNAVAILABLE,
  ToolError,
} from "../src/errors.ts";

test("busy HRESULT is transient", () => {
  assert.equal(classifyComError(RPC_E_CALL_REJECTED), "transient");
});

test("server-gone HRESULTs mean the session is lost", () => {
  assert.equal(classifyComError(RPC_S_SERVER_UNAVAILABLE), "session_lost");
  assert.equal(classifyComError(RPC_E_DISCONNECTED), "session_lost");
});

test("unknown HRESULT is permanent", () => {
  assert.equal(classifyComError(0x80004005), "permanent"); // E_FAIL
});

test("signed HRESULT from a COM bridge classifies the same as unsigned", () => {
  assert.equal(classifyComError(RPC_E_CALL_REJECTED | 0), "transient"); // -2147418111
  assert.equal(new ComError(RPC_E_CALL_REJECTED | 0, "x").hresult, RPC_E_CALL_REJECTED);
});

test("agent message hides internal detail except for invalid_input", () => {
  assert.equal(agentMessage(new ToolError("app_error", "0x80004005 at C:\\secret")), "The desktop application reported an error.");
  assert.equal(agentMessage(new ToolError("invalid_input", '"itemId" must be a non-empty string.')), '"itemId" must be a non-empty string.');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --test test/errors.test.ts`
Expected: FAIL. The output includes `Cannot find module` for `../src/errors.ts`.

- [ ] **Step 3: Write the implementation** at `src/errors.ts`:

```ts
// Stable, agent-facing error taxonomy (plan.md E1) and COM failure classification (E2).

export type ErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "auth_unavailable"
  | "forbidden"
  | "unlicensed"
  | "license_unavailable"
  | "app_busy"
  | "app_unavailable"
  | "timeout"
  | "app_error"
  | "result_too_large"
  | "internal";

/** Progress recorded for telemetry, even when a call fails. */
export interface CallMeta {
  hresult?: number;
  attempts?: number;
  queueWaitMs?: number;
  comMs?: number;
  feature?: string; // which licence layer failed (L5)
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly meta: CallMeta;

  constructor(code: ErrorCode, message: string, meta: CallMeta = {}) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

/** What a ComClient throws. `message` may contain raw COM text and must never reach the agent (E6). */
export class ComError extends Error {
  readonly hresult: number;

  constructor(hresult: number, message: string) {
    super(message);
    this.hresult = hresult >>> 0;
  }
}

export const RPC_E_CALL_REJECTED = 0x80010001; // app busy, often a modal dialog
export const RPC_E_SERVERCALL_RETRYLATER = 0x8001010a;
export const RPC_E_DISCONNECTED = 0x80010108;
export const RPC_S_SERVER_UNAVAILABLE = 0x800706ba; // app process gone

export type ComErrorClass = "transient" | "session_lost" | "permanent";

/** Accepts signed or unsigned HRESULTs; COM bridges disagree on which they return. */
export function classifyComError(hresult: number): ComErrorClass {
  switch (hresult >>> 0) {
    case RPC_E_CALL_REJECTED:
    case RPC_E_SERVERCALL_RETRYLATER:
      return "transient";
    case RPC_E_DISCONNECTED:
    case RPC_S_SERVER_UNAVAILABLE:
      return "session_lost";
    default:
      return "permanent";
  }
}

const SAFE_MESSAGES: Record<ErrorCode, string> = {
  invalid_input: "The tool input is invalid.",
  unauthenticated: "The caller could not be authenticated.",
  auth_unavailable: "The authentication service is unavailable. Try again later.",
  forbidden: "This client is not permitted to use this tool.",
  unlicensed: "The user is not licensed for this feature.",
  license_unavailable: "The licensing service is unavailable. Try again later.",
  app_busy: "The desktop application is busy. Try again shortly.",
  app_unavailable: "The desktop application is not available.",
  timeout: "The operation did not complete in time.",
  app_error: "The desktop application reported an error.",
  result_too_large: "The result is too large. Request a smaller page or fewer IDs.",
  internal: "An internal error occurred.",
};

/** Agent-facing message. Only `invalid_input` keeps its specific text, because it describes the agent's own input. */
export function agentMessage(err: ToolError): string {
  return err.code === "invalid_input" ? err.message : SAFE_MESSAGES[err.code];
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx tsx --test test/errors.test.ts`
Expected: `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Checkpoint.** Run `npm run typecheck`. It is expected to report errors only from `test/solution.test.ts` / `src/main.ts`, which still import the starter `solve()` until Task 4. Nothing in `src/errors.ts` may error.

---

### Task 2: Contracts, telemetry and the tool catalogue

**Files:**
- Create: `src/auth.ts`, `src/license.ts`, `src/telemetry.ts`, `src/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `ToolError`, `ErrorCode` (Task 1).
- Produces:
  - `auth.ts`: `type CallerType = "agent" | "app"`; `interface Principal { subject; actor; callerType; scopes: string[] }`; `interface AuthClient { verify(token): Promise<Principal> }`.
  - `license.ts`: `BASE_LICENSE = "base"`; `interface LicenseLease { release(): Promise<void> }`; `interface LicenseClient { acquire(subject, feature): Promise<LicenseLease> }`.
  - `telemetry.ts`: `type Outcome`; `interface ToolCallEvent` (fields listed in the file); `type SessionState`; `interface SessionStateEvent`; `type TelemetryEvent`; `interface Telemetry { emit(e) }`; `safeEmit(t, e)`; `outcomeFor(code?)`; `pseudonymise(subject)`.
  - `tools.ts`: `type Effect = "read" | "view" | "model" | "heavy"`; `interface ToolDef { name, description, effect, retrySafe, scope, licenseFeatures, comMethod, toArgs, elementCount?, example }`; `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `MAX_IDS_PER_CALL`, `MAX_RESULT_BYTES`, `SCOPES`; validators `requireString`, `optionalString`, `requireIds`, `pageArgs`, `requireColor`; `createRegistry(defs)`; the 8 tool constants (`GET_APP_INFO`, `QUERY_ELEMENTS`, `GET_ACTIVE_VIEW`, `LIST_ELEMENTS_IN_VIEW`, `GET_ELEMENT_PROPERTIES`, `SET_ELEMENT_COLOR`, `ZOOM_TO_ELEMENTS`, `CAPTURE_VIEW`); `M1_TOOLS`; `ALL_TOOLS`.

The whole catalogue lands in this task because it is declarative data agreed in plan.md §2. The behaviour behind it is tested end to end in Task 5.

- [ ] **Step 1: Write the failing test** at `test/tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --test test/tools.test.ts`
Expected: FAIL with `Cannot find module` (`../src/telemetry.ts` / `../src/tools.ts`).

- [ ] **Step 3: Write the contracts.** `src/auth.ts`:

```ts
// Delegated identity (plan.md §4). The real AuthClient calls the remote auth service.

export type CallerType = "agent" | "app";

export interface Principal {
  subject: string; // the user
  actor: string; // the agent or app acting for the user
  callerType: CallerType; // derived from the verified token only (D2)
  scopes: string[]; // granted to the actor (D3)
}

export interface AuthClient {
  /** Throws ToolError("unauthenticated") for a bad token; any other throw is treated as an outage. */
  verify(token: string): Promise<Principal>;
}
```

`src/license.ts`:

```ts
// Licence layers (plan.md §4a). The real LicenseClient calls the remote licensing service.

export const BASE_LICENSE = "base";

/** What a granted check returns. A plain entitlement check returns a lease whose release() does nothing. */
export interface LicenseLease {
  release(): Promise<void>;
}

export interface LicenseClient {
  /**
   * Checks (and, for floating seats, checks out) one licence layer for the user.
   * Throws ToolError("unlicensed", { feature }) when denied; any other throw is treated as an outage (L6).
   */
  acquire(subject: string, feature: string): Promise<LicenseLease>;
}
```

`src/telemetry.ts`:

```ts
// Telemetry events (plan.md T1-T5). Fields are chosen so every KPI in §3 can be computed from them.
import { createHash } from "node:crypto";
import type { CallerType } from "./auth.ts";
import type { ErrorCode } from "./errors.ts";

export type Outcome = "success" | "denied" | "invalid" | "error";

export interface ToolCallEvent {
  type: "tool_call";
  tool: string;
  effect?: "read" | "view" | "model" | "heavy";
  retrySafe?: boolean;
  correlationId: string;
  workflowId?: string;
  callerType?: CallerType;
  actor?: string;
  subject?: string; // pseudonymised
  outcome: Outcome;
  errorCode?: ErrorCode;
  hresult?: number;
  durationMs: number;
  queueWaitMs: number;
  comMs: number;
  attempts: number; // 0 means COM was never called
  resultBytes?: number; // size of the successful result, for the response-size KPI
  elementCount?: number; // writes only (W5)
  licenseFeatures?: string[]; // layers checked, including "base" (L8)
  deniedFeature?: string;
  seatHoldMs?: number;
  sessionId: string;
}

export type SessionState = "disconnected" | "connecting" | "ready" | "faulted" | "reconnecting";

export interface SessionStateEvent {
  type: "session_state";
  sessionId: string;
  from: SessionState;
  to: SessionState;
  reason: string;
}

export type TelemetryEvent = ToolCallEvent | SessionStateEvent;

export interface Telemetry {
  emit(event: TelemetryEvent): void;
}

/** A telemetry failure never fails a tool call (T3). */
export function safeEmit(telemetry: Telemetry, event: TelemetryEvent): void {
  try {
    telemetry.emit(event);
  } catch {
    // Deliberately swallowed; a real sink would count drops.
  }
}

export function outcomeFor(code: ErrorCode | undefined): Outcome {
  switch (code) {
    case undefined:
      return "success";
    case "invalid_input":
      return "invalid";
    case "unauthenticated":
    case "auth_unavailable":
    case "forbidden":
    case "unlicensed":
    case "license_unavailable":
      return "denied";
    default:
      return "error";
  }
}

/** Prototype only: production should use a keyed HMAC so the IDs can't be brute-forced. */
export function pseudonymise(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Write the tool catalogue** at `src/tools.ts`:

```ts
// Declarative tool table (plan.md §2 tool catalogue). Adding a COM call = adding one entry here.
import { ToolError } from "./errors.ts";

/** plan.md P10: view/model/heavy are "modifiers". `heavy` (render) is not in the MVP catalogue. */
export type Effect = "read" | "view" | "model" | "heavy";

export interface ToolDef {
  name: string;
  description: string;
  effect: Effect;
  retrySafe: boolean; // reads and idempotent writes only (E4, W1)
  scope: string; // required actor scope (D3)
  licenseFeatures: string[]; // licence layers beyond "base", checked in order (L2); [] for all MVP tools
  comMethod: string; // PLACEHOLDER names until the architects confirm the real COM API
  /** Validates the input and maps it to COM arguments. Throws ToolError("invalid_input"). */
  toArgs(input: unknown): unknown[];
  /** Element count for write telemetry (W5); never element contents. */
  elementCount?(args: unknown[]): number;
  /** A valid sample input; the contract tests run every tool with it. */
  example: unknown;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100; // (proposed)
export const MAX_IDS_PER_CALL = 100; // (proposed)
export const MAX_RESULT_BYTES = 100_000; // (proposed) ≈25k tokens at ~4 bytes/token, plan.md §3.2

export const SCOPES = { read: "model:read", view: "view:write", write: "model:write" } as const;

function invalid(message: string): ToolError {
  return new ToolError("invalid_input", message);
}

/** Missing input counts as {} so tools without parameters accept an empty call. */
function asObject(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("Input must be an object.");
  return input as Record<string, unknown>;
}

export function requireString(input: unknown, key: string): string {
  const value = asObject(input)[key];
  if (typeof value !== "string" || value.trim() === "") throw invalid(`"${key}" must be a non-empty string.`);
  return value;
}

export function optionalString(input: unknown, key: string): string | null {
  const value = asObject(input)[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") throw invalid(`"${key}" must be a non-empty string if given.`);
  return value;
}

/** Writes act only on explicit IDs, never on an implicit selection (W2). */
export function requireIds(input: unknown, key: string): string[] {
  const value = asObject(input)[key];
  if (!Array.isArray(value) || value.length === 0) throw invalid(`"${key}" must be a non-empty array of element IDs.`);
  if (value.length > MAX_IDS_PER_CALL) throw invalid(`"${key}" can hold at most ${MAX_IDS_PER_CALL} IDs per call.`);
  if (!value.every((id) => typeof id === "string" && id.trim() !== "")) {
    throw invalid(`"${key}" must contain only non-empty strings.`);
  }
  return value as string[];
}

export function pageArgs(input: unknown): [pageSize: number, cursor: string | null] {
  const obj = asObject(input);
  const pageSize = obj.pageSize ?? DEFAULT_PAGE_SIZE;
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalid(`"pageSize" must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return [pageSize, optionalString(input, "cursor")];
}

/** (open) Colour model: index vs RGB. The prototype assumes "#RRGGBB". */
export function requireColor(input: unknown, key: string): string {
  const value = requireString(input, key);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw invalid(`"${key}" must be a colour like "#FF0000".`);
  return value.toUpperCase();
}

export function createRegistry(defs: ToolDef[]): Map<string, ToolDef> {
  const registry = new Map<string, ToolDef>();
  for (const def of defs) {
    if (registry.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    registry.set(def.name, def);
  }
  return registry;
}

const read = { effect: "read", retrySafe: true, scope: SCOPES.read, licenseFeatures: [] as string[] } as const;

export const GET_APP_INFO: ToolDef = {
  ...read,
  name: "get_app_info",
  description: "Product name and version of the running CAD app (WF-1).",
  comMethod: "App.GetInfo",
  toArgs: (input) => (asObject(input), []),
  example: {},
};

export const QUERY_ELEMENTS: ToolDef = {
  ...read,
  name: "query_elements",
  description: "Find elements by type, level and/or layer, one page at a time (WF-4).",
  comMethod: "Model.QueryElements",
  toArgs: (input) => {
    const filter = {
      type: optionalString(input, "type"),
      level: optionalString(input, "level"),
      layer: optionalString(input, "layer"),
    };
    return [filter, ...pageArgs(input)];
  },
  example: { type: "column", level: "L2", pageSize: 20 },
};

export const GET_ACTIVE_VIEW: ToolDef = {
  ...read,
  name: "get_active_view",
  description: "Stable ID of the active view (WF-2, WF-5).",
  comMethod: "View.GetActive",
  toArgs: (input) => (asObject(input), []),
  example: {},
};

export const LIST_ELEMENTS_IN_VIEW: ToolDef = {
  ...read,
  name: "list_elements_in_view",
  description: "Elements visible in a view, one page at a time (WF-2).",
  comMethod: "View.ListElements",
  toArgs: (input) => [requireString(input, "viewId"), ...pageArgs(input)],
  example: { viewId: "view-1", pageSize: 20 },
};

export const GET_ELEMENT_PROPERTIES: ToolDef = {
  ...read,
  name: "get_element_properties",
  description: "Properties of elements by stable ID (WF-2, WF-4).",
  comMethod: "Element.GetProperties",
  toArgs: (input) => [requireIds(input, "ids")],
  example: { ids: ["box-1"] },
};

export const SET_ELEMENT_COLOR: ToolDef = {
  name: "set_element_color",
  description: "Set (not toggle) the colour of elements by explicit ID. Returns each previous colour (WF-3).",
  effect: "model",
  retrySafe: true, // absolute set → idempotent (W1)
  scope: SCOPES.write,
  licenseFeatures: [],
  comMethod: "Element.SetColor",
  toArgs: (input) => [requireIds(input, "ids"), requireColor(input, "color")],
  elementCount: (args) => (args[0] as string[]).length,
  example: { ids: ["box-1"], color: "#FF0000" },
};

export const ZOOM_TO_ELEMENTS: ToolDef = {
  name: "zoom_to_elements",
  description: "Fit the view to the given elements. Changes the view only (WF-5).",
  effect: "view",
  retrySafe: true,
  scope: SCOPES.view,
  licenseFeatures: [],
  comMethod: "View.ZoomTo",
  toArgs: (input) => [requireString(input, "viewId"), requireIds(input, "ids")],
  example: { viewId: "view-1", ids: ["box-1"] },
};

export const CAPTURE_VIEW: ToolDef = {
  ...read,
  name: "capture_view",
  description: "PNG image of a view (WF-5).",
  comMethod: "View.Capture",
  toArgs: (input) => [requireString(input, "viewId")],
  example: { viewId: "view-1" },
};

/** Milestone 1 slice. */
export const M1_TOOLS: ToolDef[] = [GET_APP_INFO, QUERY_ELEMENTS];

export const ALL_TOOLS: ToolDef[] = [
  GET_APP_INFO,
  GET_ACTIVE_VIEW,
  LIST_ELEMENTS_IN_VIEW,
  QUERY_ELEMENTS,
  GET_ELEMENT_PROPERTIES,
  SET_ELEMENT_COLOR,
  ZOOM_TO_ELEMENTS,
  CAPTURE_VIEW,
];
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx tsx --test test/tools.test.ts`
Expected: `ℹ pass 10`, `ℹ fail 0`.

- [ ] **Step 6: Checkpoint.** `npm run typecheck`: the only errors allowed are the starter `solve()` imports.

---

### Task 3: COM session (queue, deadline, retry, reconnect) and the fakes

**Files:**
- Create: `src/comSession.ts`, `src/fakes.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 errors; `Telemetry`, `safeEmit`, `SessionState` (Task 2); `Principal`, `AuthClient`, `LicenseClient`, `BASE_LICENSE`, `SCOPES` (Task 2, used by the fakes).
- Produces:
  - `comSession.ts`: `interface ComClient { connect(); call(method, args) }`; `interface SessionConfig { maxPending; deadlineMs; retryAttempts; retryBaseMs }`; `DEFAULT_SESSION_CONFIG`; `interface CallResult { value; attempts; queueWaitMs; comMs }`; `class ComSession(client, telemetry, config?)` with `.id`, `.currentState`, `execute(method, args, retryable): Promise<CallResult>`. It rejects with `ToolError` (`app_busy` | `timeout` | `app_unavailable` | `app_error` | `internal`), and `meta` is always filled.
  - `fakes.ts`: `FakeAuth(tokens)` with `.down` and `.verifyCalls`; `FakeLicense(grants, seatFeatures?)` with `.down`, `.checks` and `.seatsHeld`; `FakeComClient(options?)` with `.calls`, `.connects`, `.maxInFlight`, `enqueue(...steps)` and `failNextConnects(n)`; `ScriptStep`; `rawComText(hresult)`; `FakeCadModel.sample()` with `.handle`, `.elements` and `.zoomedTo`; `RecordingTelemetry` with `.events`, `toolCalls()` and `sessionStates()`; `mulberry32(seed)`; `PRINCIPALS`, `TOKENS`, `GRANTS`.

Design notes for the implementer:
- **The queue.** It is a promise chain (`this.tail`). The tail only advances when the COM call really finishes, even if its caller already got `timeout`, because the app's UI thread is still busy until then (S2). That's why Review Focus #1 matters.
- **The deadline.** It covers queue wait, execution and retries (S4). Two checks enforce it: `withDeadline` races the caller against a timer, and `runWithPolicy` refuses to *start* any attempt after the deadline.
- **Retry policy.** Transient errors are retried with exponential backoff (base, 2×base, …) only when `retryable`, and never past the deadline. A lost session gets exactly one reconnect and one retry (E5). Anything else fails straight away.

- [ ] **Step 1: Write the failing test** at `test/session.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ComSession, type SessionConfig } from "../src/comSession.ts";
import { RPC_E_CALL_REJECTED, RPC_S_SERVER_UNAVAILABLE, ToolError, type ErrorCode } from "../src/errors.ts";
import { FakeComClient, RecordingTelemetry } from "../src/fakes.ts";

const config: SessionConfig = { maxPending: 10, deadlineMs: 200, retryAttempts: 3, retryBaseMs: 5 };

function setup(overrides: Partial<SessionConfig> = {}) {
  const com = new FakeComClient();
  const telemetry = new RecordingTelemetry();
  const session = new ComSession(com, telemetry, { ...config, ...overrides });
  return { com, telemetry, session };
}

function isCode(code: ErrorCode) {
  return (e: unknown) => e instanceof ToolError && e.code === code;
}

test("connects lazily on the first call and reports state changes", async () => {
  const { com, telemetry, session } = setup();
  assert.equal(session.currentState, "disconnected");
  assert.equal(com.connects, 0);
  const result = await session.execute("M", [1], true);
  assert.deepEqual(result.value, { method: "M", args: [1] });
  assert.equal(result.attempts, 1);
  assert.equal(session.currentState, "ready");
  assert.deepEqual(telemetry.sessionStates().map((e) => e.to), ["connecting", "ready"]);
});

test("parallel calls never overlap inside the COM client and run in order", async () => {
  const { com, session } = setup();
  com.enqueue({ ok: "a", delayMs: 20 }, { ok: "b", delayMs: 5 }, { ok: "c" });
  const results = await Promise.all([
    session.execute("A", [], true),
    session.execute("B", [], true),
    session.execute("C", [], true),
  ]);
  assert.deepEqual(results.map((r) => r.value), ["a", "b", "c"]);
  assert.deepEqual(com.calls.map((c) => c.method), ["A", "B", "C"]);
  assert.equal(com.maxInFlight, 1);
  assert.ok((results[2]?.queueWaitMs ?? 0) >= 20);
});

test("rejects immediately with app_busy when the queue is full", async () => {
  const { com, session } = setup({ maxPending: 2 });
  com.enqueue({ ok: 1, delayMs: 30 }, { ok: 2 });
  const first = session.execute("A", [], true);
  const second = session.execute("B", [], true);
  await assert.rejects(session.execute("C", [], true), (e) => isCode("app_busy")(e) && (e as ToolError).meta.attempts === 0);
  await Promise.all([first, second]);
  assert.equal(com.calls.length, 2);
});

test("cannot connect → app_unavailable, and the next call tries again", async () => {
  const { com, session } = setup();
  com.failNextConnects(1);
  await assert.rejects(session.execute("A", [], true), isCode("app_unavailable"));
  assert.equal(session.currentState, "faulted");
  await session.execute("A", [], true);
  assert.equal(com.connects, 2);
  assert.equal(session.currentState, "ready");
});

test("transient busy then success → retried, attempts 2", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED }, { ok: "done" });
  const result = await session.execute("A", [], true);
  assert.equal(result.value, "done");
  assert.equal(result.attempts, 2);
});

test("transient errors stop after retryAttempts → app_busy", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED }, { hresult: RPC_E_CALL_REJECTED }, { hresult: RPC_E_CALL_REJECTED }, { ok: "late" });
  await assert.rejects(session.execute("A", [], true), (e) => isCode("app_busy")(e) && (e as ToolError).meta.attempts === 3);
  assert.equal(com.calls.length, 3);
});

test("non-retry-safe calls are never retried", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_E_CALL_REJECTED }, { ok: "should not run" });
  await assert.rejects(session.execute("W", [], false), (e) => isCode("app_busy")(e) && (e as ToolError).meta.attempts === 1);
  assert.equal(com.calls.length, 1);
});

test("busy past the deadline → timeout, with no attempt started after the deadline", async () => {
  const { com, session } = setup({ deadlineMs: 50, retryBaseMs: 40 });
  com.enqueue({ hresult: RPC_E_CALL_REJECTED, delayMs: 20 }, { ok: "too late" });
  await assert.rejects(session.execute("A", [], true), isCode("timeout"));
  assert.equal(com.calls.length, 1);
});

test("a hung call times out its caller, and queued calls time out without reaching COM", async () => {
  const { com, session } = setup({ deadlineMs: 30 });
  com.enqueue({ ok: "hung", delayMs: 80 });
  const hung = session.execute("A", [], true);
  const queued = session.execute("B", [], true);
  await assert.rejects(hung, isCode("timeout"));
  await assert.rejects(queued, (e) => isCode("timeout")(e) && (e as ToolError).meta.attempts === 0);
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the hung call finish
  assert.deepEqual(com.calls.map((c) => c.method), ["A"]);
});

test("app gone → one reconnect and one retry", async () => {
  const { com, telemetry, session } = setup();
  await session.execute("warm-up", [], true);
  com.enqueue({ hresult: RPC_S_SERVER_UNAVAILABLE }, { ok: "after reconnect" });
  const result = await session.execute("A", [], true);
  assert.equal(result.value, "after reconnect");
  assert.equal(result.attempts, 2);
  assert.equal(com.connects, 2);
  assert.deepEqual(telemetry.sessionStates().map((e) => e.to), ["connecting", "ready", "faulted", "reconnecting", "ready"]);
});

test("app gone twice → app_unavailable", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: RPC_S_SERVER_UNAVAILABLE }, { hresult: RPC_S_SERVER_UNAVAILABLE });
  await assert.rejects(session.execute("A", [], true), isCode("app_unavailable"));
  assert.equal(com.calls.length, 2);
});

test("permanent COM error → app_error with the HRESULT kept for telemetry", async () => {
  const { com, session } = setup();
  com.enqueue({ hresult: 0x80004005 });
  await assert.rejects(session.execute("A", [], true), (e) => isCode("app_error")(e) && (e as ToolError).meta.hresult === 0x80004005);
});

test("a non-COM throw from the adapter → internal, not retried", async () => {
  const { com, session } = setup();
  com.enqueue({ throws: new TypeError("bug in adapter") }, { ok: "unused" });
  await assert.rejects(session.execute("A", [], true), isCode("internal"));
  assert.equal(com.calls.length, 1);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --test test/session.test.ts`
Expected: FAIL with `Cannot find module` (`../src/comSession.ts`).

- [ ] **Step 3: Write the session** at `src/comSession.ts`:

```ts
// The only owner of the COM connection (plan.md S1-S7, E2-E5).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { classifyComError, ComError, ToolError, type ErrorCode } from "./errors.ts";
import { safeEmit, type SessionState, type Telemetry } from "./telemetry.ts";

/** Seam over real COM. The Windows implementation (winax or a .NET helper) lives behind this. */
export interface ComClient {
  connect(): Promise<void>;
  /** Throws ComError for COM failures. */
  call(method: string, args: unknown[]): Promise<unknown>;
}

export interface SessionConfig {
  maxPending: number; // in-flight + queued calls; beyond this → app_busy (S3)
  deadlineMs: number; // per call: queue wait + execution + retries (S4)
  retryAttempts: number; // max total attempts for transient errors, read tools only (E3, E4)
  retryBaseMs: number; // backoff: base, 2×base, 4×base…
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxPending: 10,
  deadlineMs: 30_000,
  retryAttempts: 3,
  retryBaseMs: 200,
};

export interface CallResult {
  value: unknown;
  attempts: number;
  queueWaitMs: number;
  comMs: number;
}

interface Progress {
  started: boolean;
  enqueuedAt: number;
  attempts: number;
  queueWaitMs: number;
  comMs: number;
  hresult?: number;
}

function fail(code: ErrorCode, message: string, p: Progress): ToolError {
  const queueWaitMs = p.started ? p.queueWaitMs : Date.now() - p.enqueuedAt;
  return new ToolError(code, message, { hresult: p.hresult, attempts: p.attempts, queueWaitMs, comMs: p.comMs });
}

export class ComSession {
  readonly id = randomUUID();
  private state: SessionState = "disconnected";
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly client: ComClient;
  private readonly telemetry: Telemetry;
  private readonly config: SessionConfig;

  constructor(client: ComClient, telemetry: Telemetry, config: SessionConfig = DEFAULT_SESSION_CONFIG) {
    this.client = client;
    this.telemetry = telemetry;
    this.config = config;
  }

  get currentState(): SessionState {
    return this.state;
  }

  /** Queues a COM call. Calls run one at a time, first in, first out (S2). */
  execute(method: string, args: unknown[], retryable: boolean): Promise<CallResult> {
    const p: Progress = { started: false, enqueuedAt: Date.now(), attempts: 0, queueWaitMs: 0, comMs: 0 };
    if (this.pending >= this.config.maxPending) {
      return Promise.reject(fail("app_busy", "Session queue is full", p));
    }
    this.pending++;
    const deadline = p.enqueuedAt + this.config.deadlineMs;
    const run = this.tail.then(() => this.runWithPolicy(method, args, retryable, deadline, p));
    // The queue only moves on when the COM call really ends, even if its caller already
    // got a timeout: the app's single thread is still busy until then.
    this.tail = run.catch(() => undefined).finally(() => this.pending--);
    return withDeadline(run, deadline, p);
  }

  private async runWithPolicy(
    method: string,
    args: unknown[],
    retryable: boolean,
    deadline: number,
    p: Progress,
  ): Promise<CallResult> {
    p.started = true;
    p.queueWaitMs = Date.now() - p.enqueuedAt;
    let reconnected = false;
    for (;;) {
      // Never start COM work after the deadline, including work that waited in the queue.
      if (Date.now() >= deadline) throw fail("timeout", "Deadline passed before the call could run", p);
      await this.ensureConnected(p);
      p.attempts++;
      const callStart = Date.now();
      try {
        const value = await this.client.call(method, args);
        p.comMs += Date.now() - callStart;
        return { value, attempts: p.attempts, queueWaitMs: p.queueWaitMs, comMs: p.comMs };
      } catch (err) {
        p.comMs += Date.now() - callStart;
        if (!(err instanceof ComError)) throw fail("internal", "COM adapter threw a non-COM error", p);
        p.hresult = err.hresult;
        const kind = classifyComError(err.hresult);
        if (kind === "session_lost") {
          this.transition("faulted", `hresult 0x${err.hresult.toString(16)}`);
          if (!retryable || reconnected) throw fail("app_unavailable", "COM session lost", p);
          reconnected = true; // one reconnect + one retry (E5)
          continue;
        }
        if (kind === "transient") {
          if (!retryable || p.attempts >= this.config.retryAttempts) throw fail("app_busy", "COM server busy", p);
          const delay = this.config.retryBaseMs * 2 ** (p.attempts - 1);
          if (Date.now() + delay >= deadline) throw fail("timeout", "No time left to retry", p);
          await sleep(delay);
          continue;
        }
        throw fail("app_error", "COM call failed", p);
      }
    }
  }

  /** Lazy connect, and reconnect after a fault (S5). */
  private async ensureConnected(p: Progress): Promise<void> {
    if (this.state === "ready") return;
    this.transition(this.state === "disconnected" ? "connecting" : "reconnecting", "call needs a session");
    try {
      await this.client.connect();
    } catch {
      this.transition("faulted", "connect failed");
      throw fail("app_unavailable", "Cannot connect to the desktop app", p);
    }
    this.transition("ready", "connected");
  }

  private transition(to: SessionState, reason: string): void {
    const from = this.state;
    this.state = to;
    safeEmit(this.telemetry, { type: "session_state", sessionId: this.id, from, to, reason });
  }
}

function withDeadline<T>(work: Promise<T>, deadline: number, p: Progress): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(fail("timeout", "Deadline exceeded", p)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
```

- [ ] **Step 4: Write the fakes** at `src/fakes.ts`. They are used by this task's tests and every later task:

```ts
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
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx tsx --test test/session.test.ts`
Expected: `ℹ pass 13`, `ℹ fail 0`. The suite takes about 0.3 s, because the tests use real timers with 5–200 ms windows.

- [ ] **Step 6: Checkpoint.** `npm run typecheck`: the only errors allowed are the starter `solve()` imports.

---

### Task 4: Request pipeline and public entry point (M1)

**Files:**
- Create: `src/pipeline.ts`, `test/helpers.ts`, `test/pipeline.test.ts`
- Modify (replace contents): `src/solution.ts`, `test/solution.test.ts`. The starter `solve()` example goes away. These are overwrites, not deletions, but confirm with the candidate first.

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `interface PipelineDeps { auth; license; session; telemetry; tools: Map<string, ToolDef>; maxResultBytes? }`; `interface ToolRequest { tool; input; token; correlationId; workflowId? }`; `interface AgentError { code; message; correlationId; detail?: { feature } }`; `type ToolResult = { ok: true; data } | { ok: false; error: AgentError }`; `handleToolCall(deps, req): Promise<ToolResult>`; test helpers `setup(options?)` and `request(tool, input, overrides?)`.

Pipeline order (plan.md §6):

lookup → validate → auth → scope → licence layers (base, then features) → `session.execute` → size cap → one telemetry event.

Licence leases are released in `finally` on every path (LIC3).

- [ ] **Step 1: Write the shared test wiring** at `test/helpers.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing tests** at `test/pipeline.test.ts`:

```ts
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
```

Replace `test/solution.test.ts` with:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TOOLS, handleToolCall, M1_TOOLS } from "../src/solution.ts";

test("public entry exports the pipeline and tools", () => {
  assert.equal(typeof handleToolCall, "function");
  assert.deepEqual(M1_TOOLS.map((t) => t.name), ["get_app_info", "query_elements"]);
  assert.equal(ALL_TOOLS.length, 8);
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx tsx --test test/pipeline.test.ts test/solution.test.ts`
Expected: FAIL with `Cannot find module` (`../src/pipeline.ts`), and `solution.test.ts` fails on the missing exports.

- [ ] **Step 4: Write the pipeline** at `src/pipeline.ts`:

```ts
// Transport-independent request pipeline (plan.md §6).
import type { AuthClient, Principal } from "./auth.ts";
import type { ComSession } from "./comSession.ts";
import { agentMessage, ToolError, type CallMeta, type ErrorCode } from "./errors.ts";
import { BASE_LICENSE, type LicenseClient, type LicenseLease } from "./license.ts";
import { outcomeFor, pseudonymise, safeEmit, type Telemetry } from "./telemetry.ts";
import { MAX_RESULT_BYTES, type ToolDef } from "./tools.ts";

export interface PipelineDeps {
  auth: AuthClient;
  license: LicenseClient;
  session: ComSession;
  telemetry: Telemetry;
  tools: Map<string, ToolDef>;
  maxResultBytes?: number; // defaults to MAX_RESULT_BYTES
}

export interface ToolRequest {
  tool: string;
  input: unknown;
  token: string;
  correlationId: string;
  workflowId?: string;
}

export interface AgentError {
  code: ErrorCode;
  message: string;
  correlationId: string;
  detail?: { feature: string }; // which licence layer is missing (L5)
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: AgentError };

async function verify(auth: AuthClient, token: string): Promise<Principal> {
  try {
    return await auth.verify(token);
  } catch (err) {
    if (err instanceof ToolError && err.code === "unauthenticated") throw err;
    throw new ToolError("auth_unavailable", "Auth service call failed"); // fail closed (E7)
  }
}

async function acquire(license: LicenseClient, subject: string, feature: string): Promise<LicenseLease> {
  try {
    return await license.acquire(subject, feature);
  } catch (err) {
    if (err instanceof ToolError && err.code === "unlicensed") {
      throw new ToolError("unlicensed", err.message, { feature });
    }
    throw new ToolError("license_unavailable", "Licence service call failed", { feature }); // fail closed (L6)
  }
}

export async function handleToolCall(deps: PipelineDeps, req: ToolRequest): Promise<ToolResult> {
  const startedAt = Date.now();
  const def = deps.tools.get(req.tool);
  const features = def ? [BASE_LICENSE, ...def.licenseFeatures] : [];
  const checked: string[] = [];
  const leases: LicenseLease[] = [];
  let seatsAcquiredAt: number | undefined;
  let principal: Principal | undefined;
  let args: unknown[] = [];
  let meta: CallMeta = {};
  let resultBytes: number | undefined;
  let result: ToolResult;

  try {
    if (!def) throw new ToolError("invalid_input", `Unknown tool "${req.tool}".`);
    args = def.toArgs(req.input); // validate before the remote auth round-trip
    principal = await verify(deps.auth, req.token);
    if (!principal.scopes.includes(def.scope)) throw new ToolError("forbidden", `Actor lacks scope ${def.scope}`);
    seatsAcquiredAt = Date.now();
    for (const feature of features) {
      checked.push(feature);
      leases.push(await acquire(deps.license, principal.subject, feature)); // L1, L2; before queueing (L4)
    }

    const call = await deps.session.execute(def.comMethod, args, def.retrySafe);
    meta = call;
    resultBytes = Buffer.byteLength(JSON.stringify(call.value ?? null));
    if (resultBytes > (deps.maxResultBytes ?? MAX_RESULT_BYTES)) {
      throw new ToolError("result_too_large", `Result is ${resultBytes} bytes`);
    }
    result = { ok: true, data: call.value };
  } catch (err) {
    const toolError = err instanceof ToolError ? err : new ToolError("internal", "Unexpected error");
    meta = { ...meta, ...toolError.meta };
    const error: AgentError = { code: toolError.code, message: agentMessage(toolError), correlationId: req.correlationId };
    if (toolError.code === "unlicensed" && toolError.meta.feature) error.detail = { feature: toolError.meta.feature };
    result = { ok: false, error };
  } finally {
    // Seats are released on every path, including errors and timeouts (L3).
    for (const lease of leases) {
      try {
        await lease.release();
      } catch {
        // A failed release must not change the tool result; the licence server's lease expiry is the backstop.
      }
    }
  }

  // Both branches above end here, so every call emits exactly one event (T1).
  const errorCode = result.ok ? undefined : result.error.code;
  safeEmit(deps.telemetry, {
    type: "tool_call",
    tool: req.tool,
    effect: def?.effect,
    retrySafe: def?.retrySafe,
    correlationId: req.correlationId,
    workflowId: req.workflowId,
    callerType: principal?.callerType,
    actor: principal?.actor,
    subject: principal ? pseudonymise(principal.subject) : undefined,
    outcome: outcomeFor(errorCode),
    errorCode,
    hresult: meta.hresult,
    durationMs: Date.now() - startedAt,
    queueWaitMs: meta.queueWaitMs ?? 0,
    comMs: meta.comMs ?? 0,
    attempts: meta.attempts ?? 0,
    resultBytes,
    elementCount: def?.elementCount && args.length > 0 ? def.elementCount(args) : undefined,
    licenseFeatures: checked.length > 0 ? checked : undefined,
    deniedFeature: meta.feature,
    seatHoldMs: seatsAcquiredAt !== undefined && leases.length > 0 ? Date.now() - seatsAcquiredAt : undefined,
    sessionId: deps.session.id,
  });
  return result;
}
```

Replace `src/solution.ts` with:

```ts
// Public entry point for the COM-backed MCP prototype. See docs/plan.md.
export { handleToolCall, type PipelineDeps, type ToolRequest, type ToolResult } from "./pipeline.ts";
export { ComSession, DEFAULT_SESSION_CONFIG, type ComClient, type SessionConfig } from "./comSession.ts";
export { ALL_TOOLS, createRegistry, M1_TOOLS, type ToolDef } from "./tools.ts";
export { BASE_LICENSE, type LicenseClient, type LicenseLease } from "./license.ts";
```

(The `./kpi.ts` re-export is added in Task 6, once that file exists.)

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx tsx --test test/pipeline.test.ts test/solution.test.ts`
Expected: `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 6: Checkpoint.** `npm run typecheck` still fails only on `src/main.ts` (starter `solve` import), which is fixed in Task 7. `npm test`: everything else passes.

---

### Task 5: Workflow and licensing acceptance tests (M3: tests 10–14)

**Files:**
- Test: `test/workflowTools.test.ts`, `test/licensing.test.ts`

**Interfaces:**
- Consumes: `handleToolCall` (Task 4), `setup` / `request` (Task 4 helpers), tool constants (Task 2), `RPC_E_CALL_REJECTED` (Task 1).
- Produces: nothing new.

These are **acceptance tests for behaviour already built** in Tasks 2–4: the write, pagination, the size cap and licence layers. They should pass on the first run. If one fails, fix the owning module (named in the test title) rather than the test. `render_view` is a test-only tool: rendering is an example licence layer, not an MVP tool.

- [ ] **Step 1: Write the workflow tests** at `test/workflowTools.test.ts`:

```ts
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
```

- [ ] **Step 2: Write the licensing tests** at `test/licensing.test.ts`:

```ts
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

test("14. a rendering seat is released after success, COM failure and timeout", async () => {
  const { com, license, telemetry, deps } = setup({ tools, seatFeatures: ["rendering"], session: { deadlineMs: 30 } });
  const ok = await handleToolCall(deps, request("render_view", { viewId: "view-1" }));
  assert.equal(ok.ok, true);
  assert.equal(license.seatsHeld, 0);

  com.enqueue({ hresult: 0x80004005 });
  const failed = await handleToolCall(deps, request("render_view", { viewId: "view-1" }, { correlationId: "c-2" }));
  assert.equal(!failed.ok && failed.error.code, "app_error");
  assert.equal(license.seatsHeld, 0);

  com.enqueue({ ok: "slow", delayMs: 60 });
  const timedOut = await handleToolCall(deps, request("render_view", { viewId: "view-1" }, { correlationId: "c-3" }));
  assert.equal(!timedOut.ok && timedOut.error.code, "timeout");
  assert.equal(license.seatsHeld, 0);

  assert.ok(telemetry.toolCalls().every((e) => e.seatHoldMs !== undefined));
  assert.deepEqual(telemetry.toolCalls()[0]?.licenseFeatures, ["base", "rendering"]);
  await new Promise((resolve) => setTimeout(resolve, 60)); // let the slow COM call drain
});
```

- [ ] **Step 3: Run them**

Run: `npx tsx --test test/workflowTools.test.ts test/licensing.test.ts`
Expected: `ℹ pass 13`, `ℹ fail 0`.

- [ ] **Step 4: Prove the tests can fail.** Temporarily change `SET_ELEMENT_COLOR.retrySafe` to `false` in `src/tools.ts`, and expect test `10b` to fail with `app_busy`. Then temporarily delete the `finally` release loop in `src/pipeline.ts`, and expect test `14` to fail on `seatsHeld`. Revert both changes.

- [ ] **Step 5: Checkpoint.** `npm test`: all files except `main.ts`'s typecheck pass.

---

### Task 6: KPI calculator

**Files:**
- Create: `src/kpi.ts`
- Test: `test/kpi.test.ts`

**Interfaces:**
- Consumes: `ToolCallEvent`, `TelemetryEvent` (Task 2), `ErrorCode` (Task 1), `CallerType` (Task 2), `MAX_RESULT_BYTES` (Task 2).
- Produces: `interface KpiLimits { maxOverheadP95Ms; maxQueueWaitP95Ms; maxNonUserErrorRate; maxResultBytes }`; `DEFAULT_LIMITS`; `interface Expectations { correlationIds: string[]; callerTypes: Map<string, CallerType> }`; `interface Gate { name; actual; limit; comparison; pass }`; `interface KpiReport { metrics; gates; pass }`; `p95(values)`; `gate(name, actual, comparison, limit)`; `computeKpis(events, expect, limits?)`.

The KPIs are computed **only from telemetry** plus the caller's ground truth (`Expectations`), so the same function can later run on production events (T5). Gates implemented here:

- blocked calls that reached COM = 0;
- exactly-once telemetry = 100%;
- non-retry-safe calls retried = 0;
- responses over the size cap = 0;
- wrong caller type = 0;
- overhead p95, queue-wait p95 and non-user error rate within the limits.

- [ ] **Step 1: Write the failing test** at `test/kpi.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeKpis, p95, type Expectations } from "../src/kpi.ts";
import type { ToolCallEvent } from "../src/telemetry.ts";

function call(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call", tool: "get_app_info", effect: "read", retrySafe: true, correlationId: id, callerType: "agent",
    outcome: "success", durationMs: 10, queueWaitMs: 2, comMs: 7, attempts: 1, sessionId: "s", ...overrides,
  };
}

function expectIds(ids: string[], callerType: "agent" | "app" = "agent"): Expectations {
  return { correlationIds: ids, callerTypes: new Map(ids.map((id) => [id, callerType])) };
}

const failing = (report: ReturnType<typeof computeKpis>) => report.gates.filter((g) => !g.pass).map((g) => g.name);

test("p95 picks the 95th percentile value", () => {
  assert.equal(p95([]), 0);
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
});

test("clean telemetry passes every gate", () => {
  const report = computeKpis([call("a"), call("b")], expectIds(["a", "b"]));
  assert.deepEqual(failing(report), []);
  assert.equal(report.metrics.overheadP95, 1);
});

test("a missing or duplicated event fails the exactly-once gate", () => {
  assert.deepEqual(failing(computeKpis([call("a")], expectIds(["a", "b"]))), ["tool calls with exactly one telemetry event"]);
  assert.deepEqual(failing(computeKpis([call("a"), call("a")], expectIds(["a"]))), ["tool calls with exactly one telemetry event"]);
});

test("a denied call that reached COM fails the gate", () => {
  const report = computeKpis([call("a", { outcome: "denied", errorCode: "forbidden", attempts: 1 })], expectIds(["a"]));
  assert.ok(failing(report).includes("blocked calls that reached COM"));
});

test("a retried non-retry-safe call fails the gate; a retried idempotent write does not", () => {
  const unsafe = computeKpis([call("a", { effect: "model", retrySafe: false, attempts: 2 })], expectIds(["a"]));
  const safe = computeKpis([call("a", { effect: "model", retrySafe: true, attempts: 2 })], expectIds(["a"]));
  assert.ok(failing(unsafe).includes("non-retry-safe calls retried"));
  assert.deepEqual(failing(safe), []);
});

test("a successful response over the size cap fails the gate", () => {
  const report = computeKpis([call("a", { resultBytes: 200_000 })], expectIds(["a"]));
  assert.ok(failing(report).includes("responses over the size cap"));
});

test("wrong caller type fails the gate", () => {
  const report = computeKpis([call("a", { callerType: "app" })], expectIds(["a"], "agent"));
  assert.ok(failing(report).includes("calls with wrong caller type"));
});

test("non-user error rate counts app/timeout/internal but not denials", () => {
  const events = [
    call("a", { outcome: "error", errorCode: "timeout" }),
    call("b", { outcome: "denied", errorCode: "forbidden", attempts: 0 }),
    call("c"),
    call("d"),
  ];
  assert.equal(computeKpis(events, expectIds(["a", "b", "c", "d"])).metrics.nonUserErrorRate, 0.25);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --test test/kpi.test.ts`
Expected: FAIL with `Cannot find module` (`../src/kpi.ts`).

- [ ] **Step 3: Write the implementation** at `src/kpi.ts`:

```ts
// Computes plan.md §3 KPIs from telemetry alone (T5), so the same code can run on production events.
import type { CallerType } from "./auth.ts";
import type { ErrorCode } from "./errors.ts";
import type { TelemetryEvent, ToolCallEvent } from "./telemetry.ts";
import { MAX_RESULT_BYTES } from "./tools.ts";

export interface KpiLimits {
  maxOverheadP95Ms: number;
  maxQueueWaitP95Ms: number;
  maxNonUserErrorRate: number;
  maxResultBytes: number;
}

/** (proposed) values from plan.md §3.2; placeholders until baselined on real COM. */
export const DEFAULT_LIMITS: KpiLimits = {
  maxOverheadP95Ms: 50,
  maxQueueWaitP95Ms: 1000,
  maxNonUserErrorRate: 0.01,
  maxResultBytes: MAX_RESULT_BYTES,
};

/** Ground truth known to whoever generated the calls (the validation runner, or a test). */
export interface Expectations {
  correlationIds: string[];
  callerTypes: Map<string, CallerType>;
}

export interface Gate {
  name: string;
  actual: number;
  limit: number;
  comparison: "<=" | ">=";
  pass: boolean;
}

export interface KpiReport {
  metrics: Record<string, number>;
  gates: Gate[];
  pass: boolean;
}

const NON_USER_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "app_busy",
  "app_unavailable",
  "timeout",
  "app_error",
  "internal",
]);

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
}

export function gate(name: string, actual: number, comparison: "<=" | ">=", limit: number): Gate {
  return { name, actual, limit, comparison, pass: comparison === "<=" ? actual <= limit : actual >= limit };
}

export function computeKpis(events: TelemetryEvent[], expect: Expectations, limits: KpiLimits = DEFAULT_LIMITS): KpiReport {
  const calls = events.filter((e): e is ToolCallEvent => e.type === "tool_call");
  const perId = new Map<string, number>();
  for (const call of calls) perId.set(call.correlationId, (perId.get(call.correlationId) ?? 0) + 1);

  const expected = new Set(expect.correlationIds);
  const exactlyOnce = expect.correlationIds.filter((id) => perId.get(id) === 1).length;
  const unexpected = calls.filter((c) => !expected.has(c.correlationId)).length;
  const telemetryExactlyOnceRate =
    expect.correlationIds.length === 0 ? 1 : (exactlyOnce - unexpected) / expect.correlationIds.length;

  const blockedButReachedCom = calls.filter(
    (c) => (c.outcome === "denied" || c.outcome === "invalid") && c.attempts > 0,
  ).length;
  // The gate is about retry safety, not R/W: an idempotent write (W1) may be retried.
  const unsafeRetried = calls.filter((c) => c.retrySafe === false && c.attempts > 1).length;
  const oversizedResponses = calls.filter(
    (c) => c.outcome === "success" && (c.resultBytes ?? 0) > limits.maxResultBytes,
  ).length;
  const wrongCallerType = calls.filter((c) => {
    const want = expect.callerTypes.get(c.correlationId);
    return want !== undefined && c.callerType !== undefined && c.callerType !== want;
  }).length;

  // Overhead = time not spent waiting in the queue or inside COM. Single-attempt successes only,
  // so retry backoff doesn't count as pipeline overhead.
  const overheadP95 = p95(
    calls.filter((c) => c.outcome === "success" && c.attempts === 1).map((c) => c.durationMs - c.queueWaitMs - c.comMs),
  );
  const queueWaitP95 = p95(calls.filter((c) => c.attempts > 0).map((c) => c.queueWaitMs));
  const nonUserErrors = calls.filter((c) => c.errorCode !== undefined && NON_USER_ERRORS.has(c.errorCode)).length;
  const nonUserErrorRate = calls.length === 0 ? 0 : nonUserErrors / calls.length;
  const retryRecovered = calls.filter((c) => c.outcome === "success" && c.attempts > 1).length;

  const gates = [
    gate("blocked calls that reached COM", blockedButReachedCom, "<=", 0),
    gate("tool calls with exactly one telemetry event", telemetryExactlyOnceRate, ">=", 1),
    gate("non-retry-safe calls retried", unsafeRetried, "<=", 0),
    gate("responses over the size cap", oversizedResponses, "<=", 0),
    gate("calls with wrong caller type", wrongCallerType, "<=", 0),
    gate("MCP overhead p95 (ms)", overheadP95, "<=", limits.maxOverheadP95Ms),
    gate("queue wait p95 (ms)", queueWaitP95, "<=", limits.maxQueueWaitP95Ms),
    gate("non-user error rate", nonUserErrorRate, "<=", limits.maxNonUserErrorRate),
  ];

  return {
    metrics: {
      toolCalls: calls.length,
      telemetryExactlyOnceRate,
      blockedButReachedCom,
      unsafeRetried,
      oversizedResponses,
      wrongCallerType,
      overheadP95,
      queueWaitP95,
      nonUserErrorRate,
      retryRecovered,
    },
    gates,
    pass: gates.every((g) => g.pass),
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx tsx --test test/kpi.test.ts`
Expected: `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Export the KPI calculator** by appending this line to `src/solution.ts`:

```ts
export { computeKpis, DEFAULT_LIMITS } from "./kpi.ts";
```

- [ ] **Step 6: Checkpoint.** `npm test` passes.

---

### Task 7: Validation runner, scenarios and `npm run validate`

**Files:**
- Create: `src/validation/scenarios.ts`, `src/validation/run.ts`, `src/validation/cli.ts`, `test/validation.test.ts`
- Modify (replace contents): `src/main.ts`
- `package.json`: no edit needed (`validate` is already wired; see Step 6).

**Interfaces:**
- Consumes: everything above.
- Produces: `ScenarioStep`, `Scenario`, `SCENARIOS`; `interface ValidationConfig { rounds; concurrency; comLatencyMs; transientRate; seed; minWorkflowSuccessRate; session; limits }`; `NOMINAL`; `interface ValidationReport { kpis; workflowSuccess; gates; pass; maxComCallsInFlight }`; `runValidation(config, scenarios?, tools?)`; `formatReport(report)`.

What it does:
- Runs every scenario `concurrency` times in parallel for `rounds` rounds against one shared `ComSession`, with a seeded 5% busy rate.
- Scores the Task 6 gates plus three of its own:
  - COM calls in flight at once ≤ 1 (S2, "0 calls bypass the scheduler");
  - licence seats held after the run = 0;
  - per-workflow task success ≥ 90% (§3.3), judged on result codes, `check` (returned data) and `verify` (end state of the fake model).
- Scenario inputs are static because the fake's IDs are known. The L4 agent evals will chain IDs between steps instead.
- It **cannot** measure "correct tool chosen first time"; that needs a real agent (L4).

- [ ] **Step 1: Write the failing test** at `test/validation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx tsx --test test/validation.test.ts`
Expected: FAIL with `Cannot find module` (`../src/validation/run.ts`).

- [ ] **Step 3: Write the scenarios** at `src/validation/scenarios.ts`:

```ts
// Workflow scenarios for the validation suite: the agreed MVP workflows (plan.md §2) plus guard
// scenarios for the hard gates. Inputs are static because the fake model's IDs are known; L4 evals
// with a real agent chain IDs from earlier steps instead.
import type { CallerType } from "../auth.ts";
import type { ErrorCode } from "../errors.ts";
import type { FakeCadModel } from "../fakes.ts";

export interface ScenarioStep {
  tool: string;
  input: unknown;
  expect: "success" | ErrorCode;
  check?: (data: unknown) => boolean; // success criteria on the returned data
}

export interface Scenario {
  workflowId: string;
  name: string;
  token: string;
  callerType: CallerType; // ground truth for the caller-type gate
  steps: ScenarioStep[];
  verify?: (model: FakeCadModel) => boolean; // success criteria on the app's end state
}

const field = (data: unknown, key: string): unknown => (data as Record<string, unknown>)[key];

export const SCENARIOS: Scenario[] = [
  {
    workflowId: "WF-1",
    name: "Get version",
    token: "agent-token",
    callerType: "agent",
    steps: [{ tool: "get_app_info", input: {}, expect: "success", check: (d) => field(d, "version") === "2026.1.0" }],
  },
  {
    workflowId: "WF-2",
    name: "Viewport & objects",
    token: "agent-token",
    callerType: "agent",
    steps: [
      { tool: "get_active_view", input: {}, expect: "success", check: (d) => field(d, "viewId") === "view-1" },
      {
        tool: "list_elements_in_view",
        input: { viewId: "view-1", pageSize: 50 },
        expect: "success",
        check: (d) => (field(d, "items") as unknown[]).length === 50 && field(d, "nextCursor") === "50",
      },
      { tool: "get_element_properties", input: { ids: ["box-1"] }, expect: "success" },
    ],
  },
  {
    workflowId: "WF-3",
    name: "Paint the box red",
    token: "agent-token",
    callerType: "agent",
    steps: [
      { tool: "query_elements", input: { type: "box" }, expect: "success" },
      { tool: "set_element_color", input: { ids: ["box-1"], color: "#ff0000" }, expect: "success" },
    ],
    verify: (model) => model.elements.get("box-1")?.color === "#FF0000",
  },
  {
    workflowId: "WF-4",
    name: "Find & inspect elements",
    token: "app-token",
    callerType: "app",
    steps: [
      {
        tool: "query_elements",
        input: { type: "column", level: "L2" },
        expect: "success",
        check: (d) => field(d, "total") === 6,
      },
      { tool: "get_element_properties", input: { ids: ["col-1", "col-2"] }, expect: "success" },
    ],
  },
  {
    workflowId: "WF-5",
    name: "Zoom & capture view",
    token: "agent-token",
    callerType: "agent",
    steps: [
      { tool: "zoom_to_elements", input: { viewId: "view-1", ids: ["box-1"] }, expect: "success" },
      { tool: "capture_view", input: { viewId: "view-1" }, expect: "success", check: (d) => field(d, "mimeType") === "image/png" },
    ],
    verify: (model) => model.zoomedTo.includes("box-1"),
  },
  {
    workflowId: "GUARD-1",
    name: "Read-only agent cannot write",
    token: "agent-readonly-token",
    callerType: "agent",
    steps: [{ tool: "set_element_color", input: { ids: ["box-1"], color: "#00FF00" }, expect: "forbidden" }],
  },
  {
    workflowId: "GUARD-2",
    name: "Unlicensed user is refused",
    token: "agent-unlicensed-token",
    callerType: "agent",
    steps: [{ tool: "get_app_info", input: {}, expect: "unlicensed" }],
  },
  {
    workflowId: "GUARD-3",
    name: "Write without explicit IDs is rejected",
    token: "agent-token",
    callerType: "agent",
    steps: [{ tool: "set_element_color", input: { color: "#00FF00" }, expect: "invalid_input" }],
  },
];
```

- [ ] **Step 4: Write the runner** at `src/validation/run.ts`:

```ts
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
```

- [ ] **Step 5: Write the CLI** at `src/validation/cli.ts`, and replace `src/main.ts`.

`src/validation/cli.ts`:

```ts
import { formatReport, NOMINAL, runValidation } from "./run.ts";

const report = await runValidation(NOMINAL);
console.log(formatReport(report));
process.exitCode = report.pass ? 0 : 1;
```

`src/main.ts`:

```ts
import "./validation/cli.ts";
```

- [ ] **Step 6: Scripts.** `package.json` already has `"validate": "tsx src/validation/cli.ts"`. The design session added it, and CI runs it once `src/validation/cli.ts` exists. **Decision for the candidate:** whether to also fold it into `check` (`"check": "npm run typecheck && npm test && npm run validate"`). That makes the pre-push hook run it too, adding about 0.2 s on the fakes.

- [ ] **Step 7: Run the tests and the suite**

Run: `npx tsx --test test/validation.test.ts`
Expected: `ℹ pass 3`, `ℹ fail 0`. The two "catches a bad configuration" tests prove the suite can fail.

Run: `npm run check && npm run validate`
Expected:
- `tsc` exits clean;
- `ℹ tests 63`, `ℹ pass 63`, `ℹ fail 0`;
- the validate report ends with `VALIDATION PASSED`: 18 gates PASS, including `COM calls in flight at once: 1`, `licence seats still held after the run: 0`, and `WF-1`…`WF-5` and `GUARD-1`…`GUARD-3` task success rate 1.

- [ ] **Step 8: Checkpoint.** `npm run check` is green. This is the milestone deliverable: report it to the candidate with the real output.

---

## Self-review (done while writing this plan)

- **Spec coverage.** plan.md §8 tests 1–14 map to these tasks:
  - tests 1–4 and 9 → Task 4;
  - tests 5–8 → Task 3;
  - tests 10–12 and the WF-5 path → Task 5;
  - tests 13–14 → Task 5;
  - the §3.1 gates → Tasks 6–7, except the soak/process-leak gate, which is L5 on Windows;
  - D2/D3/D5 → Task 4;
  - LIC1–LIC6 → Tasks 4–5;
  - S1–S5 → Task 3. S6 is satisfied by design (tools take stable IDs). S7 is adapter work in the Windows plan.
- **Placeholder scan.** Every code step contains the full file. "PLACEHOLDER" appears only on COM method names and licence IDs, which really are unknown (Global Constraints).
- **Type consistency.** `effect`, `retrySafe`, `licenseFeatures`, `execute(method, args, retryable)` and `ToolError.meta` have the same names in every task. This was confirmed by the scratch typecheck.

## Follow-on plans (not in this plan; each needs decisions first)

1. **M2b: load, fairness, UI priority, licence providers** (plan.md P1–P14, LIC1–LIC10, tests 15–24). This replaces the FIFO in `ComSession` with a scheduler behind the same `execute` signature. The scheduler adds:
   - per-MCP-session registry and token-bucket `rate_limited`;
   - round-robin across sessions within priority classes, with ageing;
   - duty-cycle budget and yield gap;
   - user-activity gating for modifiers (`user_active`);
   - render cancel;
   - serial / licence-server / named-user `LicenseProvider`s with `detail.reason`.

   It needs an injectable clock (test 18), which would also remove the real-timer flakiness risk above. Blocked on: duty-cycle / grace / rate numbers (P1, P5, P11), LIC10 (does COM already consume a seat?), and the COM user-activity API shape.
2. **M4: MCP stdio transport.** This adds `@modelcontextprotocol/sdk` (needs approval). It maps `ToolDef` to MCP tool schemas and `ToolResult` to `CallToolResult` with `isError`. The delegated token comes from the environment at startup (D6).
3. **M5/M6: Windows `ComClient` + L3/L5.** This covers the winax vs .NET helper decision, real HRESULT capture, releasing references in `finally` (S7), and baselining the §3.2 numbers. It adds L4 agent evals over WF-1…5 and a soak run with scripted UI interaction.
