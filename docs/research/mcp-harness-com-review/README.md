# Review follow-up: harness readiness, COM bridging, user interference

This folder holds the research behind my answers to three review questions about this prototype. It also covers the observation that PRs were merged before the full CI matrix had finished.

| Question | Short answer | Evidence |
|---|---|---|
| **Q1.** Used from an agent harness such as Claude via MCP, what's missing? Where is it awkward, especially authentication and `capture_view` image data? | The pipeline doesn't depend on any transport, but the MCP layer is missing, and so is OAuth. Today `capture_view` would return base64 inside JSON; it should return an MCP image block instead. | [1-mcp-harness-auth-images.md](1-mcp-harness-auth-images.md) |
| **Q2.** How would Node talk to the CAD app's COM API? What happens when a person and the automation drive the same app? How do we pick the right instance? | Through a small out-of-process .NET helper that owns an STA thread and a message filter. Attach only to a running copy, choose it explicitly, and reconnect only to the same process. In any conflict the user wins: the automation backs off, uses explicit IDs, and leaves one undoable step per change. | [2-node-com-bridging.md](2-node-com-bridging.md), [3-shared-instance-targeting.md](3-shared-instance-targeting.md) |
| **Q3.** How do we stop automation interfering with an active user, and what are the biggest risks? | Detect user activity, budget how much UI-thread time automation gets, and protect the user's state. The biggest risk is a long COM call that can't be interrupted and freezes the UI. Measure first, then set hard limits. | [4-user-interference-risks.md](4-user-interference-risks.md) |

## How these notes were produced

- Four AI research agents worked in parallel, one per angle. Each read this repository read-only and checked primary sources: the MCP specification (revision 2026-07-28), Microsoft COM documentation, Claude client documentation, the RFCs, and project pages for winax and edge-js.
- Every claim is labelled as one of: a spec or doc statement, behaviour of this repo's code, or a recommendation. Anything that could not be confirmed is marked unverified.
- Other CAD and Office products (AutoCAD, Revit, Office, MicroStation) appear only as **analogues**. **Nothing here has been tested against the target CAD app.** That app's COM behaviour is the main open item.
- I checked the CI timeline below against the GitHub API. The other findings are the agents' work, which I reviewed but did not re-test.

## Merge observation

| PR | Merged | ubuntu-latest finished | windows-latest finished |
|---|---|---|---|
| #2 | 18:05:52Z | 18:05:36Z | 18:06:16Z (passed) |
| #3 | 18:22:13Z | 18:22:15Z (passed) | 18:22:53Z (passed) |

I merged PRs #2 and #3 without waiting for the full matrix so the outcome would be shareable within the one-hour timebox. I watched the jobs to completion, ready to revert or fix forward. Both passed, and so did the follow-up `main` runs.

The safeguard was my attention, not the pipeline: `main` has no required checks, so nothing would have blocked a red build. The structural fix:

- add a ruleset on `main` that requires the matrix checks, ideally through one aggregator job;
- enable auto-merge, so a PR lands only once every leg is green.

Details are in note 1, section "GitHub merge gating".

## Q1: harness readiness

**What exists.** `handleToolCall` already does delegated-identity checks (subject plus actor, scopes), licence layers, deadlines, the error taxonomy and telemetry, with no transport attached.

**What's missing:**
- the MCP layer: transport, JSON Schemas for inputs, mapping results to MCP content with `isError`, tool annotations, and cancellation;
- OAuth integration. Today the prototype verifies an already-issued token on each call; nothing obtains, refreshes or steps up a token.

**Proposed authentication model:**
- The client follows the MCP authorization flow: OAuth 2.1 with PKCE, Protected Resource Metadata, and the token bound to this server as its audience.
- The client receives a short-lived token with scopes. RFC 8693 token exchange records the agent as the actor (the `act` claim), so the server can tell an agent from the app.
- The server validates the token on every call. When a workflow needs more access (a first write, or a rendering licence), it returns an `insufficient_scope` challenge so the client can step up with the user's consent.
- Interactive steps, such as licence activation, use URL-mode elicitation. They never go through tool arguments.
- Licences remain a separate check, made before a call is queued.

**One process per Claude client.** Each Claude client starts its own stdio server. Several clients would therefore mean several COM queues driving one single-threaded app. Running a single local MCP server on 127.0.0.1 over Streamable HTTP fixes both problems: clients get the standard OAuth flow, and one process owns the COM queue with configurable per-client limits and monitoring. The spec requires such a server to validate `Origin` and bind to localhost.

**Images.** `capture_view` should return an MCP image block (`{type:"image", data, mimeType}`). The image should be sized at the source (`maxDimension`, `format`) and have its own byte cap, separate from the cap on text results.

**Unverified:**
- whether the organisation's auth service supports token exchange and the `act` claim;
- whether Claude Desktop supports OAuth for a localhost server, and elicitation.

## Q2: Node to COM, shared use, instance targeting

**Bridge.**
- Libraries like winax run COM on Node's main thread. That thread has no message filter and no way to time out a hung call.
- A .NET helper that owns an STA thread with an `IOleMessageFilter`, called over stdio JSON-RPC, would sit behind the existing `ComClient` interface.
- A watchdog that kills a hung helper feeds the existing reconnect path. This is captured as a direction for M5, not built.

**Sharing the app with a person:**
- While a dialog is open, rejected calls (`RPC_E_CALL_REJECTED`) are normal.
- Re-entrant calls and races are expected on the active document, the selection and the undo stack.

**Targeting:**
- Attach only to a copy the user already has open; never launch a hidden one.
- Choose the copy explicitly, by open document or process ID, and refuse to guess if more than one matches.
- Reconnect only to the same process, identified by a stored fingerprint (PID plus process start time).

### Resolving conflicts with the user

Spotting conflicts is half the answer. The rule for resolving them is that **the person using the app always wins**. The automation yields, and any change it does make should be easy to see and easy to undo.

| Conflict | Resolution | Status |
|---|---|---|
| The app rejects a call because the user has a dialog or command open (`RPC_E_CALL_REJECTED` / `RETRYLATER`) | The helper's message filter fails fast instead of showing a "server busy" dialog. Retry and backoff stay in `ComSession`. Repeated rejections count as "user active", so the server stops retrying and reports `user_active` instead of `app_busy` | Rejected calls are classified as transient and retried for retry-safe tools today (`src/errors.ts`, `src/comSession.ts`); the helper and the `user_active` mapping are proposed |
| The user is working while the agent wants to change the model or the view | Modifying calls (`view`, `model`, `heavy`) start only after an idle grace period, with hysteresis. Read calls run within a UI-time budget. Long calls are refused while the user is active (see Q3) | Designed (plan.md P10–P14), not built |
| The user switches document, view or selection between two agent calls | Agent tools never act on "the current selection" or the active view. Writes take explicit element IDs, and should also take the document ID, checked before every write. A stale ID returns `not_found` instead of touching something else | Explicit IDs and `not_found` in code; the document ID check is proposed |
| The user and the agent edit the same element | Optimistic concurrency: the write succeeds only if the element hasn't changed since the agent read it, otherwise it returns a conflict. If the COM API has no version stamps, compare inside the same COM call | Proposed; depends on what the COM API exposes (unconfirmed) |
| Agent and user changes interleave on the undo stack | Each agent change should be one named undo step ("Agent: set colour (3)"), so the user can undo it in one go. `set_element_color` already returns the previous colours as a fallback | Previous colours returned in code; undo grouping is unconfirmed (plan.md W4), with analogues in Revit `TransactionGroup` and AutoCAD undo markers |
| The agent would move the user's view (e.g. `zoom_to_elements` → `capture_view`) | Capture an off-screen or named view where possible. Otherwise save the camera, zoom, capture and restore, all within one idle window | Proposed |
| Locking the user out to make automation safe | Rejected. Office-style `Interactive = false` blocks keyboard and mouse input, and stays set if the automation crashes. That reverses "the user always wins" | Design decision |
| A risky write from an agent | Writes need the `model:write` scope today. A first write triggers step-up consent (see Q1), and there are no save, close or open tools, so the agent can't commit or discard the user's work | Scope check and the tool catalogue in code; step-up proposed |

Evidence: note 3 covers rejected calls, reentrancy and Office's interactive-app guidance. Note 4 Q4 covers state protection and undo-grouping analogues, and its risk register covers risks 4, 6, 7 and 9.

## Q3: user interference and risks

**Current state.** Calls are serialised and have deadlines. Writes use explicit IDs only. Idle gating and fair scheduling are designed (plan.md P1–P14, M2b) but not built.

**Approach:**
- *Activity detection:* an app event or a cheap property, plus busy rejections, with hysteresis.
- *Scheduling:* tools that change the model or view run only after an idle grace period, and automation gets a capped share of UI-thread time.
- *State protection:* explicit IDs, undo grouping, saving and restoring the view, and write confirmation.

**Top risks:**
1. A COM call that can't be interrupted freezes the UI.
2. Modal dialogs, in both directions.
3. Writes to the wrong document.
4. COM capabilities nobody has confirmed: the activity signal, undo grouping, cancel.

**Next step.** A stress and timing run against the real app, to set hard limits before building the scheduler.

## Gaps in this repo found during the research

These are known and will be corrected in a follow-up PR:

1. The README says the pipeline depends on a `UserActivityMonitor` interface. So far it exists only in `docs/plan.md`.
2. `maxPending` is one global limit. One busy client can starve the others, and there are no per-client limits yet.
3. `capture_view` is classified as `read`, so a costly capture can be retried up to three times.
4. The result-size cap is applied after the COM call, so the UI-thread time has already been spent.
5. `src/main.ts` prints to stdout. That would corrupt a stdio MCP stream; no server exists yet.
6. The plan's "MCP session" concept predates the stateless MCP 2026-07-28 revision, and the README names the v1 SDK package.

Also, the README's line that CI "cannot" be bypassed holds only once checks are required.
