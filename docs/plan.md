# COM-backed MCP: constraints & plan (draft)

Status: **draft prototype plan**. Items marked _(proposed)_ are suggestions awaiting a decision. Items marked _(open)_ need input from product owners or architects. All numeric limits are placeholders until they are measured against the real COM API.

Sequencing principle: **workflows → KPIs/limits → design.** The set of COM calls to expose comes from the critical workflows, not the other way round.

## 1. Scope

- Product: desktop **CAD application** exposing its capability through a COM API.
- Prototype MCP server exposing **8 tools** (+1 optional undo) derived from the 5 MVP workflows in §2.
- Must follow the Python MCP's patterns: remote auth (now **delegated**), licensing, telemetry, error format.
- The MCP implementation owns all session, threading, retry, error and telemetry handling. The COM API is treated as a raw, unreliable dependency.
- **One write operation is in scope** (`set_element_color`, WF-3). All other tools are read-only or change only the view.
- Out of scope for now: production packaging, remote transport, multi-user hosting, writes other than WF-3.

## 2. Business-critical workflows _(open: product owners to supply)_

The real workflows come from product owners and usage data. This section defines how to pick them and what each one must specify.

**Selection criteria** (rank candidates on these):
1. Business value: time saved, or decisions it unblocks.
2. Frequency of the task today.
3. Blast radius: read-only and reversible first.
4. COM coverage: how many of the candidate calls it uses.
5. Measurability: a clear, checkable success outcome.

**Target for the prototype:** 2–3 workflows, read-only, together covering the initial COM calls.

**Workflow template:**

| Field | Description |
|---|---|
| ID / name | `WF-n`, short name |
| Caller type | `agent` and/or `app` (see §4 delegation) |
| User intent | What the person asks for, in their words |
| Tool sequence | Expected tools in order, with inputs |
| Read / write | Any write requires a decision on confirmation and idempotency |
| Success criteria | Checkable end state or answer |
| Criticality | High / medium: what breaks for the user if this fails |
| KPI targets | Rows from §3 that apply, with workflow-specific limits |

### MVP workflows (agreed)

| ID | Name | Example intent | Tool sequence | R/W | Success criteria | Criticality |
|---|---|---|---|---|---|---|
| WF-1 | Get version | "Which version of the app is running?" | `get_app_info` | R | Returns the product name + version matching the app's About dialog | Medium: also the **session handshake**; the adapter refuses unsupported versions |
| WF-2 | Viewport & objects | "What's in the current view?" | `get_active_view` → `list_elements_in_view(viewId, filter?, page)` → `get_element_properties(ids)` | R | Element list matches the visible elements; paginated; within the response-size cap | High: the source of the **stable element IDs** used by WF-3/4/5 |
| WF-3 | Paint the box red | "Paint the box red" | (WF-2 or WF-4 to resolve the ID) → `set_element_color(ids, color)` | **W** | The element's colour is red in the model; re-running gives the same result | High: first write; highest blast radius |
| WF-4 | Find & inspect elements | "How many columns are on level 2, and what are their sizes?" | `query_elements(filter: type/level/layer, page)` → `get_element_properties(ids)` | R | Count and properties match the app's own UI/report | High: core value (answering questions about the model) |
| WF-5 | Zoom & capture view | "Show me the box you just painted" | `zoom_to_elements(ids)` → `capture_view(viewId)` | View only | The image shows the target elements filling the view | Medium: visual verification loop for WF-3; tests the heaviest UI-thread work |

**Write rules for WF-3** (constraints, see also D7, E4):
- W1 `set_element_color` is a **set** (absolute colour), never a toggle, so it is idempotent and may be marked safe to retry.
- W2 Writes act only on **explicit element IDs**, never on an implicit "current selection".
- W3 **Decided (2026-10-14):** no confirmation for agent writes in the prototype; the `model:write` scope is the gate. Revisit with the MCP transport at M4 (e.g. MCP elicitation) (D7).
- W4 _(open)_ Undo: does the COM API offer undo/transaction grouping? If it does, add `undo_last_change`; if not, record the previous colour in the tool result so the change can be reversed.
- W6 **Decided (2026-10-14):** `set_element_color` returns `previousReliable: false` when a retry followed a lost session, because an earlier attempt may already have applied the colour, so `previous` may show the new colour. Busy rejections (`0x80010001`) never ran, so they keep `previousReliable: true`. Rejected alternative: read colours in a separate COM call before writing (not atomic, and doubles the UI-thread time). Tests 10, 10b and 10d.
- W5 Telemetry for writes records the element count and `callerType`, but not element contents.

### Tool catalogue (derived from the workflows)

| Tool | Effect (P10) | Retry-safe | Licence | Workflows | Notes |
|---|---|---|---|---|---|
| `get_app_info` | read | yes | base | WF-1, session start | Version gate |
| `get_active_view` | read | yes | base | WF-2, WF-5 | Returns a stable view ID |
| `list_elements_in_view` | read | yes | base | WF-2 | Filters + pagination + size cap |
| `query_elements` | read | yes | base | WF-4 | Filter by type/level/layer; pagination |
| `get_element_properties` | read | yes | base | WF-2, WF-4 | Batch by IDs; cap per call |
| `set_element_color` | **model** (modifier) | yes (idempotent set) | base | WF-3 | Explicit IDs; returns the previous colour; user-idle only |
| `zoom_to_elements` | **view** (modifier) | yes | base | WF-5 | Changes the user's view; user-idle only |
| `capture_view` | read | yes | base | WF-5 | Image payload; size cap; slow on the UI thread |
| _`undo_last_change`_ | **model** (modifier) | no | base | WF-3 safety | _(open, W4)_ |
| _`render_view`_ _(future)_ | **heavy** (modifier) | no | base + `rendering` | — | Long-running; user-idle only; cancel/confirm (P13) |

## 3. Validation suite & KPIs

### 3.1 Hard gates (must hold at every milestone; any violation blocks release)

| KPI | Limit | Measured by |
|---|---|---|
| Unauthorized / out-of-scope calls that reach COM | **0** | L1, L2 |
| Tool calls with exactly one telemetry event | **100%** | L1, L2, L5 |
| Raw COM error text in agent-facing responses | **0** | L1, L2 |
| Non-retry-safe calls retried automatically (writes are retry-safe only if declared idempotent, W1) | **0** | L1 (needs telemetry field `retrySafe`) |
| Calls attributed to the wrong caller type (`agent` vs `app`) | **0** | L1, L3 |
| Feature-licensed calls (e.g. rendering) that reach COM without that feature licence | **0** | L1, L2 |
| Licence seats still held after the call/session ends | **0** | L1, L5 (ground truth: fake provider `seatsHeld` counter) |
| Calls that bypass the per-session rate limit or the scheduler | **0** | L1, L2 (ground truth: fake `ComClient.maxInFlight ≤ 1`, not telemetry alone) |
| Modifiers (view/model/heavy) **started** while the user is active | **0** | L1, L2, L5 |
| Licence secrets (serial, password, server credentials) in tool I/O, logs or telemetry | **0** | L1, L3 |
| Rendering seats consumed twice for one render (MCP + app) | **0** | L3 |
| Leaked app processes / COM references after a soak run | **0** | L5 |

### 3.2 Performance & reliability _(provisional targets, accepted 2026-10-14; re-baseline against real COM at M5)_

| KPI | Proposed limit | Notes |
|---|---|---|
| MCP overhead (p95, excluding COM execution) | < 50 ms | Pipeline + auth cache hit |
| Remote auth latency (p95) | Baseline first | Drives the caching decision (A4) |
| Queue wait (p95) under the workflow load profile | < 1 s | S2/S3 |
| End-to-end tool latency (p95), per tool | Baseline + agreed margin | Can't be set before measuring real COM |
| Non-user error rate (`app_*`, `timeout`, `internal`) | < 1% | Excludes `invalid_input` and auth denials |
| Transient-retry recovery rate | Tracked | Shows whether the retry policy is right |
| Session recovery after app restart | < 10 s | S5/E5 |
| Tool response size | ≤ agreed cap (e.g. 25k tokens), else paginate | Protects agent context |
| UI responsiveness under MCP load: added p95 input latency for the human user | < 100 ms _(proposed)_ | L5: scripted UI interaction + N MCP sessions × hundreds of calls |
| Longest single MCP-caused UI-thread block | < 1 s _(proposed)_ | P1/P3 |
| MCP share of UI-thread time while the user is active | ≤ duty-cycle budget | P1 |
| Fairness: max wait of a light session behind a flooding one | Bounded (≤ N calls) | P6 |
| Modifier wait time while the user is active (p95) | Tracked; bounded by the deadline | P11; high values mean the agent should retry later or change its UX |
| Render cancellation latency after the user becomes active | < 500 ms _(proposed, if cancellable)_ | P13 |
| Licence check latency (p95), per activation method | Baseline first | LIC7/LIC12; seat checkout may be slow |

### 3.3 Agent effectiveness (per workflow)

| KPI | Proposed limit |
|---|---|
| Workflow task success rate on the eval set | ≥ 90% |
| Correct tool chosen first time | ≥ 90% |
| Tool calls per completed workflow | ≤ expected sequence length + 2 |

### 3.4 Validation layers

| Layer | What | Where / when |
|---|---|---|
| L1 Contract | Pipeline, taxonomy, delegation, telemetry on fakes | Any OS, every commit |
| L2 Fault injection | Fake COM is scripted to be busy, slow, crash or leak; deadlines | Any OS, every commit |
| L3 Integration | Real app + real COM on Windows, each tool | Windows runner, nightly |
| L4 Workflow evals | Agent runs WF-n scenarios; scored against §3.3. "Correct tool chosen first time" can **only** be measured here (with a real agent), not in scripted L1/L2 runs | Pre-milestone |
| L5 Soak / load | N hours at the workflow load profile; leak and latency drift | Pre-release |

## 4. Identity & delegated authentication

Goal: every tool call is attributable to **the user (subject)** and **who acted on their behalf (actor)**, so agent-initiated calls are distinguishable from app/human-initiated calls.

| ID | Constraint | Design implication |
|---|---|---|
| D1 | Calls carry a **delegated token**: subject = user, actor = calling client (agent or app) | e.g. OAuth token exchange / on-behalf-of with an actor claim _(open: what the remote auth service supports)_ |
| D2 | `callerType` (`agent` \| `app`) is derived **only from the verified token**, never from a client-supplied field | `AuthClient.verify` returns `{ subject, actor, callerType, scopes, entitlements }` |
| D3 | Effective permission = **user entitlements ∩ actor's granted scopes** | An agent can never do more than the user, and may do less (e.g. read-only) |
| D4 | Tokens are audience-bound to this MCP server and **never passed through** to COM or other services | COM runs in the app's session; the delegation is recorded in telemetry instead |
| D5 | Missing scope is distinct from a missing licence | New error code `forbidden` (actor lacks scope) vs `unlicensed` (user lacks entitlement) |
| D6 | **Decided (2026-10-14):** verify the delegated token **per call** in the prototype. With stdio, identity is effectively per process/session | Revisit at M4 once auth latency is baselined: verify at session start + re-verify on expiry |
| D7 | **Decided (2026-10-14):** no explicit confirmation for agent writes in the prototype (W3) | Revisit at M4 with the transport (MCP elicitation) |
| D8 | Telemetry records `subject` (pseudonymised), `actor`, `callerType` | T1 fields |

_(open: auth caching TTL vs revocation delay; which identity wins if the MCP subject differs from the app's signed-in user.)_

## 4a. Licensing tiers

Every MCP user must authenticate. Some capabilities need **additional licence layers** on top of the base product licence. Agreed example: **rendering** in the desktop software.

| ID | Constraint | Design implication |
|---|---|---|
| LIC1 | **Tier 0: base access.** Authenticated + base product licence. Required for every tool. | Checked for every call, after auth |
| LIC2 | **Tier 1+: feature licence.** A tool may declare one or more additional `licenseFeatures` (e.g. `rendering`) | `ToolDef.licenseFeatures: string[]`; each is checked in order after the base licence |
| LIC3 | Feature licences are checked **before** queueing for COM | A denied render never occupies the UI thread |
| LIC4 | Denial says **which layer** failed, without leaking licence internals | `unlicensed` with `detail.feature` (`base` \| `rendering` \| …) and `detail.reason` (`not_activated` \| `expired` \| `no_seat_available` \| `invalid_credentials`) |
| LIC5 | A licence source being unreachable → fail closed | `license_unavailable` (distinct from `unlicensed`) |
| LIC6 | Telemetry records the feature checked, the activation method, the outcome and the seat hold time; **never** serials, passwords or licence files | Feeds licence usage reporting; must match the Python MCP |

### Rendering licence: activation methods (Unity-style)

The rendering feature licence can be satisfied by one of several **activation methods**, configured per installation:

| Method | How it works | Online? | Consumption | MCP behaviour |
|---|---|---|---|---|
| **Serial number** | Machine/user activated once with a serial key | Offline after activation | Node-locked; no per-call consumption | Check activation state + expiry; cacheable for the MCP session |
| **Local licence server** | Floating seats on a LAN server | LAN required | **Seat checkout** with a lease; must be released | `acquire` → render → `release` in `finally`; lease renewal (heartbeat) for long renders; `no_seat_available` if the pool is empty |
| **User / password** | Named-user licence via an online account | Online (token refresh) | Per user | Check the account licence token; refresh on expiry |

| ID | Constraint | Design implication |
|---|---|---|
| LIC7 | **Pluggable providers**: one `LicenseProvider` per method behind a common `check` / optional `acquire`/`release`/`renew` interface; the active method comes from installation config, not from the agent | `SerialLicenseProvider`, `LicenseServerProvider`, `NamedUserLicenseProvider` |
| LIC8 | **Licence secrets never pass through MCP.** Serials, passwords and server credentials are never tool inputs, outputs, logs or telemetry | Activation is a human/admin action done out-of-band (the app's own licence UI or an admin tool). MCP only *checks* or *consumes* an existing activation. Secrets live in the OS credential store / the app's licence store |
| LIC9 | **Agents cannot activate, deactivate or change licences** | No licence-management tools in the MCP catalogue |
| LIC10 | **Avoid double consumption**: if the desktop app already checks out a rendering seat when `Render` is called via COM, the MCP must not check one out as well | _(open, critical)_ Does the app enforce rendering licensing inside its COM call? If yes, the MCP does a pre-check only (fail fast) and lets the app consume |
| LIC11 | Long renders hold seats: lease renewal while running; seats are always released on success, failure, timeout, cancel and MCP session close | Ties to P4 session cleanup and the §3.1 "0 seats held" gate |
| LIC14 | **Decided (2026-10-14): leases are released when the COM work really finishes**, not when the caller gets `timeout`, so seat usage isn't under-counted while the app is still rendering. Every release emits a `license_released` event (features, seat hold time, failed releases), so a failed release, which could be a seat leak, is visible | `ComSession.execute(…, onSettled)`; tests 14a–14d |
| LIC12 | Caching per method: serial → per MCP session; named-user → until token expiry; licence server → no caching of seats (lease only) | _(open: revocation delay acceptable?)_ |
| LIC13 | _(open)_ Is the rendering licence tied to the **subject** (the delegated user), the machine, or the app's signed-in user? | With named-user licensing, the MCP subject and the app user must match (see A5) |

Tool mapping (rendering is **not** in the MVP tool list unless agreed):

| Tool | Licence layers |
|---|---|
| All MVP tools (§2) | `base` |
| `render_view` _(future)_ | `base` + `rendering` (via the configured activation method; long-running; a modifier, see P10) |

## 5. Constraints

### Session & threading

| ID | Constraint | Why | Design implication |
|---|---|---|---|
| S1 | A single **session manager** owns the COM connection. No tool touches COM directly. | COM lifetime and threading rules must be enforced in one place | `ComSession` is the only thing that holds the COM client |
| S2 | **One COM call in flight at a time.** Calls run first-in, first-out from a queue. | Assumed single-threaded COM server (STA) running on the app's UI thread _(open: confirm the threading model)_ | Concurrent MCP requests wait in the queue |
| S3 | The queue is **bounded**. When it is full, reject straight away with `app_busy`. | A stuck call must not pile up unlimited work | Max queue length is configurable _(proposed: 10)_ |
| S4 | Every tool call has a **deadline** that covers queue wait + execution + retries | The agent must always get an answer | Per-call timeout _(proposed: 30s)_ → `timeout` |
| S5 | Explicit session **lifecycle**: `disconnected → connecting → ready → faulted → reconnecting` | The app can be closed, restarted or crash | Connect lazily; reconnect when the app is gone; emit an event on every state change |
| S6 | No COM object references cross the MCP boundary. Tools take **stable IDs**. | MCP calls carry no state between them; references become invalid on reconnect | The adapter looks objects up again per call |
| S7 | Release every COM reference, including on error paths | Leaked references keep the app process alive | The adapter cleans up in `finally`; L5 checks for leaks |

### Load, fairness & UI priority

Context: MCP clients can send **hundreds of calls**, but there is **one** COM connection on the app's UI thread (S1/S2), shared with a **real human** using the app.

Terminology: **COM session** = the single connection to the app (S1, one per app process). **MCP session** = one connected MCP client (many). Each MCP session gets its own state and quotas.

| ID | Constraint | Why | Design implication |
|---|---|---|---|
| P1 | **The human UI user always has priority.** MCP traffic must never make the UI unresponsive | Every COM call runs on the UI thread and blocks it while executing | Bound the MCP share of UI-thread time: per-call execution cap (S4), a **duty-cycle budget** (e.g. MCP busy ≤ X% per window) and a short yield gap between consecutive MCP calls _(proposed values TBD after baseline)_ |
| P2 | **Back off when the user is active.** COM exposes user-activity state ✅ (confirmed) | The app is busy or modal while the user works | `UserActivityMonitor` reads the COM activity signal; "call rejected / app busy" (`0x80010001`) is a second back-off signal. _(open: is it an event (preferred) or must we poll? Polling is itself a COM call on the UI thread, so it must be cheap and counted in the budget)_ |
| P3 | A running COM call **cannot be pre-empted**. Priority only applies when choosing the next call | STA execution is atomic from our side | Keep each call short: batch by IDs with a cap per call; long operations (render, capture) are chunked or need explicit approval |
| P4 | **Per-MCP-session state**: identity, rate limit, in-flight count, queue share, idle timeout | Hundreds of calls from several clients must be isolated from each other | `McpSessionRegistry`: created at MCP initialize, closed on disconnect/idle timeout; releases any held licence seats |
| P5 | **Per-MCP-session rate limit** (token bucket) and **max queued calls per session** | One agent must not monopolise the queue | Over limit → `rate_limited` with `retryAfterMs`; COM not called _(proposed: e.g. 10 calls/s burst 20, 5 queued per session; TBD)_ |
| P6 | **Fair scheduling across MCP sessions** (round-robin per session, not a global FIFO) | A flood from one session must not starve others | The scheduler picks the next call from sessions in turn, within priority classes |
| P7 | **Priority classes**: human UI (implicit, always wins) > `callerType: app` > `agent` interactive > `agent` background/bulk | Derived from the verified delegation (D2), never from client input | The scheduler serves higher classes first; ageing prevents starvation of lower classes |
| P8 | **Global admission limit**: when the total queue is full, reject new work immediately | Protects the app under overload | `app_busy` (global) vs `rate_limited` (per session) |
| P10 | **Modifiers yield to the desktop app.** Tools are classified by effect: `read` (queries, capture), `view` (zoom: changes what the user sees), `model` (set colour: changes the drawing), `heavy` (render: long-running, licensed) | `view`, `model` and `heavy` are **modifiers**: they disrupt or change the user's work | `ToolDef.effect`; the scheduler checks it before dispatch |
| P11 | **Modifiers only start while the user is idle** (no activity for an idle grace period) | A zoom or colour change in the middle of the user's interaction hijacks their view or edit | Gate on `UserActivityMonitor.idleFor >= grace` _(proposed grace: 2 s)_. If the user is active, the modifier waits in the queue until the deadline, then fails with `user_active` + `retryAfterMs` |
| P12 | **Reads may run while the user is active**, within the duty-cycle budget (P1) | Reads don't change the user's state, but they still occupy the UI thread | Reads are throttled, not blocked |
| P13 | **Heavy modifiers (render) need extra protection**: start only when idle; must be cancellable, or must not start if the expected duration exceeds the budget | A render can block the UI thread for a long time and can't be pre-empted (P3) | _(open: does the COM render API support async/progress/cancel?)_ If cancellable: cancel when the user becomes active and return `user_active`. If not: require explicit user confirmation for agent-initiated renders |
| P14 | Within modifiers, `callerType: app` beats `agent` (P7). The **human always beats both** | "Priority to the desktop app" | The scheduler orders modifiers by class; none dispatch while the user is active |
| P9 | One COM connection is shared by all MCP sessions _(proposed)_. Alternative: one COM connection per MCP session | STA serialises calls anyway, so extra connections add no throughput and add more leak/lifecycle risk | Revisit only if the COM server is multi-threaded (MTA) or out-of-process per instance _(open)_ |

### Error handling

| ID | Constraint | Design implication |
|---|---|---|
| E1 | **Stable error taxonomy**, aligned with the Python MCP _(open)_ | `invalid_input`, `unauthenticated`, `auth_unavailable`, `forbidden`, `unlicensed`, `license_unavailable`, `rate_limited`, `user_active`, `app_busy`, `app_unavailable`, `timeout`, `app_error`, `internal`. **Adopted 2026-10-14:** `not_found` for stale or unknown element/view IDs, so agents can re-plan; mapped from a not-found HRESULT (placeholder `0x80070490` until the CAD team confirms) and never retried. `result_too_large` for results over the size cap; that call already reached COM, so it isn't `invalid_input`. Both are agent-side, so neither counts in the non-user error rate |
| E2 | COM failure codes (HRESULTs) are **classified** as transient, session-lost, not-found or permanent | `0x80010001` → transient; `0x800706BA` → session-lost; not-found → `not_found`; otherwise `app_error` |
| E3 | **Retry only transient errors**, bounded attempts + backoff + jitter, inside the deadline | _(proposed: 3 attempts, 200ms base)_ |
| E4 | Automatic retry is only allowed for read-only / idempotent tools | `access: "read" \| "write"` per tool |
| E5 | Session-lost → one reconnect + one retry; then `app_unavailable` | |
| E6 | Raw COM codes and messages are never returned to the agent | Raw HRESULT goes to telemetry only |
| E7 | Fail closed on auth | `auth_unavailable` ≠ `unauthenticated` |

### Telemetry

| ID | Constraint | Design implication |
|---|---|---|
| T1 | **Exactly one** `tool_call` event per call, emitted in `finally` | `tool`, `correlationId`, `callerType`, `actor`, `subject` (pseudonymised), `outcome`, `errorCode`, `hresult?`, `durationMs`, `queueWaitMs`, `attempts`, `retrySafe`, `resultBytes`, `sessionId`, `workflowId?` |
| T2 | A `session_state` event on every lifecycle change | `from`, `to`, `reason` |
| T3 | Telemetry failures never fail a tool call | Fire-and-forget, guarded |
| T4 | _(open)_ Schema and PII rules match the Python MCP | Assumption: no tool inputs or outputs logged |
| T5 | Telemetry is enough to **compute every KPI in §3** from production data | Each KPI maps to the event fields above |
| T6 | Load and licensing events | `tool_call` adds `mcpSessionId`, `priorityClass`, `licenseFeatures`; `license_released` carries the seat hold time and failed releases (LIC14); separate `rate_limited`, `admission_rejected`, `mcp_session_opened/closed` events |

## 6. Request pipeline

```
MCP request (within an MCP session, P4)
  → lookup tool                    (unknown → invalid_input)
  → validate input                 (→ invalid_input)
  → delegated auth                 (→ unauthenticated | auth_unavailable)   → subject, actor, callerType
  → per-session rate limit         (→ rate_limited + retryAfterMs)           P5
  → scope check (actor)            (→ forbidden)
  → base licence (tier 0)          (→ unlicensed{feature:base} | license_unavailable)
  → feature licences (tier 1+)     (→ unlicensed{feature} | license_unavailable; acquire seat if needed)
  → Scheduler.enqueue(priority class, session, effect)   (global full → app_busy; session full → rate_limited)  P6–P8
      → modifier? wait for user idle (P11)   (still active at deadline → user_active)
      → ComSession.execute with UI-priority budget (P1–P3), retry/reconnect policy (E2–E5), deadline (S4)
  → release licence seat (finally) (LIC11)
  → map result / error             (E1, E6)
  → emit tool_call telemetry       (T1, always)
```

## 7. Components _(proposed)_

- `ToolDef` table: declarative entries (name, validation, access, required scope, licence feature, COM method).
- `AuthClient` (delegated; returns subject/actor/callerType/scopes): remote call behind an interface.
- `LicenseCheck`: tiered (`base` + feature licences), with optional `acquire`/`release` for seat-based features.
- `McpSessionRegistry`: per-MCP-session state, rate limiter, idle timeout, cleanup.
- `Scheduler`: priority classes + round-robin across sessions + global admission + UI-time budget + **user-idle gate for modifiers**, feeding `ComSession`.
- `UserActivityMonitor`: wraps the COM user-activity signal (`isActive`, `idleForMs`).
- `LicenseProvider` implementations for rendering: serial, local licence server (seat lease), named user.
- `ComClient`: thin layer over real COM, with a scriptable fake for L1/L2.
- `ComSession`: queue, lifecycle, reconnect, deadline.
- `RetryPolicy` + `classifyComError(hresult)`.
- `Telemetry`: sink interface.
- `handleToolCall`: the pipeline, independent of transport. The MCP SDK stdio transport is added later _(needs approval: new package)_.

## 8. Test plan (first slice, L1/L2)

1. Happy path: COM is called with the mapped arguments, the result is returned, one `success` event with the correct `callerType`.
2. Agent vs app tokens: the same tool produces `callerType: agent` vs `app` in telemetry; a client-supplied caller field is ignored.
3. Agent lacks scope while the user is entitled → `forbidden`, COM not called.
4. Auth rejected / unreachable → `unauthenticated` / `auth_unavailable`, COM not called, one `denied` event.
5. Transient busy then success → `attempts: 2`, `success`.
6. Busy past the deadline → `timeout`; no retries after the deadline.
7. App gone → one reconnect + retry; on second failure `app_unavailable`; session events emitted.
8. Concurrency: parallel calls never overlap inside `ComClient`.
9. Raw HRESULT text never appears in the agent-facing error.
10. `set_element_color` called twice with the same input leaves the same final state; it returns the previous colour.
11. A write tool without explicit IDs → `invalid_input`; an agent without a write scope → `forbidden`.
12. `list_elements_in_view` / `query_elements` paginate and never exceed the response-size cap.
13. A tool requiring the `rendering` feature: user has the base licence but not `rendering` → `unlicensed{feature: rendering}`, COM not called; base-only tools never call the feature check.
14. A seat acquired for a feature licence is released when the call succeeds, fails or times out.
15. A session exceeding its rate limit → `rate_limited` with `retryAfterMs`; other sessions are unaffected.
16. Fairness: session A floods 100 calls and session B sends 1; B's call runs within a bounded number of A's calls (round-robin).
17. Priority: with both queued, `callerType: app` is served before `agent` background work; low-priority work still runs (no starvation).
18. UI budget: under sustained MCP load, the fake clock shows MCP occupancy ≤ the configured duty cycle, with a yield gap between calls.
19. MCP session close/idle timeout drops its queued calls (`app_unavailable`/cancelled) and releases its seats.
20. User active: a `read` tool runs (within budget); `set_element_color` and `zoom_to_elements` wait and, if still active at the deadline, fail with `user_active` + `retryAfterMs`; COM is never called for them.
21. User becomes idle for the grace period → the queued modifier dispatches; the user becoming active again blocks the next modifier.
22. Rendering licence per activation method (fake providers): serial activated/expired; licence server seat acquired + released, pool empty → `unlicensed{reason: no_seat_available}`; named-user token expired → refresh, invalid → `unlicensed{reason: invalid_credentials}`; server unreachable → `license_unavailable`.
23. Licence secrets: a provider configured with a serial/password never exposes it in results, errors or telemetry (assert on captured telemetry).
24. Render (fake, cancellable): the user becomes active mid-render → cancel, seat released, `user_active`.

## 9. Milestones

0. ~~Agree the MVP workflows (§2)~~ ✅ done. Still to do: KPI limits (§3) and the delegation model (§4).
1. Pipeline + taxonomy + delegation + telemetry with `get_app_info` + `query_elements` on fakes (tests 1–4, 9, 12).
2. `ComSession` queue, deadline, retry, reconnect (tests 5–8).
2b. Tiered licensing + rendering activation providers on fakes (tests 13–14, 22–23); MCP session registry + rate limits + fair priority scheduler + UI budget + user-activity gating for modifiers (tests 15–21, 24).
3. Remaining read/view tools (WF-2, WF-5), then the WF-3 write (tests 10–11).
4. MCP stdio transport (adds a package; needs approval).
5. Real `ComClient` on Windows (winax vs .NET helper process: decision pending); L3 integration + baseline the §3.2 numbers.
6. L4 workflow evals and L5 soak against the KPI gates.

## 10. Open questions

- **Product owners:** confirm the WF-1..5 success criteria and criticality. (W3, W6 and E1 were decided for the prototype on 2026-10-14; see §11.)
- **Licensing team:** confirm the LIC14 decision (§11); which capabilities beyond rendering need feature licences; whether the app already consumes the rendering licence inside its COM render call (LIC10, critical); which activation methods must be supported in v1; licence binding to user vs machine (LIC13); caching/revocation rules (LIC12).
- **Product/UX:** acceptable impact on the human user (UI latency budget, MCP duty cycle); priority between `app` and `agent` callers; rate-limit defaults per session (P1, P5, P7).
- **Architects (CAD/COM):** whether the user-activity signal is an event or must be polled, and its cost (P2); whether render supports async/progress/cancel (P13); undo/transaction support (W4); how elements are identified stably across sessions; the colour model (index vs RGB); whether view capture is supported headless.
- **Identity/auth team:** whether the remote auth service supports delegated tokens with an actor claim, what scopes exist per actor, token lifetime, and the stdio session-vs-call identity model (D6).
- **Architects:** whether the COM server is in-process or out-of-process and its threading model; whether a type library exists; whether dialogs can be suppressed; supported app versions.
- **Python MCP team:** error format, telemetry schema, PII rules, existing KPI dashboards to align with.

## 11. Decision log

Decisions taken by the candidate on 2026-10-14 for the prototype. The external owners in §10 still need to confirm them; they are recorded here so the code and the plan agree.

| Ref | Decision | Rejected alternative | Where |
|---|---|---|---|
| E1 | Adopt `not_found` and `result_too_large` | Keep stale IDs as `app_error`; report oversized results as `invalid_input` | `src/errors.ts`, `src/comSession.ts`, tests 10c and 12c |
| W6 | `previousReliable: false` when a write was retried after a lost session | Read colours before writing (two COM calls, not atomic); document only | `src/tools.ts` (`mapResult`), tests 10/10b/10d |
| LIC14 | Release licence leases when COM really finishes; emit `license_released` with hold time and failed releases | Release at caller timeout (under-counts seat usage) | `src/pipeline.ts`, `ComSession.execute(…, onSettled)`, tests 14a–14d |
| W3 / D7 | No confirmation for agent writes in the prototype; scope `model:write` is the gate | Require `confirm: true` now | Revisit at M4 |
| D6 | Verify the delegated token per call | Per session + re-verify on expiry | Revisit at M4 |
| §3.2 | KPI limits are provisional targets for the fake-backed gates | Leave unsigned | Re-baseline at M5 |
| CI | `npm run validate` stays a separate CI step, not part of `npm run check` | Fold it into `check` and the pre-push hook | `package.json`, `.github/workflows/ci.yml` |
| Telemetry | Unknown tool names are recorded as sent (not bucketed) | Bucket to `"unknown"` to bound cardinality | Known risk; revisit with the Python MCP telemetry schema |
