# Preventing automation from interfering with an active user, and biggest risks: research notes

_Research notes, 2026-10-15. Compiled by AI research agents from primary sources and a read-only review of this repository. Unverified claims are tagged. See the [README](README.md) for how to read them._

Repo paths are relative to the repository root. Autodesk, Office and Revit appear as analogues only. Researched 2026-10-15.

## Q1. What the repo already does vs only plans

**Takeaway:** protection against interfering with the user exists only on paper (plan.md P1–P14). The code is a plain FIFO queue with one call in flight, a bounded queue and a deadline. There is no activity gating, priority, fairness or duty cycle. The `UserActivityMonitor` that the README lists as an interface does not exist in src/.

**Implemented:**
- `ComSession` runs one call at a time in FIFO order (S2). Its limits are maxPending 10, deadlineMs 30_000, retryAttempts 3 and retryBaseMs 200, all proposed values. (src/comSession.ts)
- The queue advances only when the COM call really ends, even after its caller has timed out. Work is never started after its deadline. (src/comSession.ts)
- Transient 0x80010001 errors are retried with exponential backoff, for retry-safe tools only. A lost session gets 1 reconnect and 1 retry. (src/comSession.ts; plan E2–E5)
- `effect` (read|view|model|heavy) is only a label: the pipeline puts it in telemetry and never uses it for dispatch. set_element_color is `model`; zoom_to_elements is `view`. (src/tools.ts; src/pipeline.ts)
- W2 (explicit IDs only), W1 (idempotent absolute set) and W6 (previousReliable=false after a reconnect-retry) are in place. The write gate is only the `model:write` scope; there is no confirmation step (W3/D7).
- LIC14: the licence lease is released when COM really finishes, via onSettled. (src/pipeline.ts)
- MAX_RESULT_BYTES = 100_000 is checked **after** COM returns, on the JSON-serialised result. (src/pipeline.ts)

**Planned only (M2b):**
- token bucket rate limiting;
- round-robin scheduling with ageing;
- duty cycle and yield gap;
- user_active gating;
- render cancel;
- licence providers;
- injectable clock.

M2b is "Blocked on: duty-cycle / grace / rate numbers (P1, P5, P11), LIC10, and the COM user-activity API shape." (docs/superpowers/plans/2026-10-14-com-mcp-prototype.md, follow-on plans)

**README and test notes:**
- The README's known gaps include P11 (no gating yet) and real-timer tests that "could flake on slow Windows runners".
- The README says the pipeline depends on a `UserActivityMonitor` interface. grep finds none in src/; it appears only in plan.md §7 as a proposal.
- The tests use real timers (e.g. `setTimeout(resolve, 100)` in test/session.test.ts).
- P2 says "COM exposes user-activity state ✅ (confirmed)". Whether that is an event or needs polling, and what it costs, is still open (P2, §10).

**Inferences:**
- The hard gate "0 modifiers started while user active" currently passes vacuously, because no fake models user activity.
- Fix or caveat the README's `UserActivityMonitor` claim.

**Gaps:** the "confirmed" activity signal is not described anywhere: not its type, not whether it's a property or an event, not its semantics.

## Q2. Detecting user activity

**Takeaway:** prefer app-level "quiescent / not in a command / no modal" state from COM, plus the app's busy rejections. Treat OS input-idle only as a supplement, read from a helper running in the user's session. Every input-based signal gives a false idle while the user is just reading the screen, so the grace period is a heuristic and needs protections that don't depend on detection.

**Cited findings:**
- **GetLastInputInfo** is "useful for input idle detection" but "provides session-specific user input information for only the session that invoked the function". Its tick count is "not guaranteed to be incremental". https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo
- **Called from a service,** impersonation doesn't help: the service is still in session 0 and sees no input since boot. The fix is to launch a helper process into the target session. Raymond Chen, Old New Thing, 2026-06-18. https://devblogs.microsoft.com/oldnewthing/20260618-00?p=112444
- **Session 0** is isolated and non-interactive, and a service that waits on UI can hang. https://learn.microsoft.com/fr-fr/previous-versions/bb756986(v=msdn.10)
- **AutoCAD analogue:** `GetAcadState().IsQuiescent` reports whether AutoCAD is idle. External calls into a busy AutoCAD can raise a modal "ActiveX request not handled" dialog, so check first.
  - https://www.afralisp.net/archive/methods/lista/getacadstate_method.htm
  - https://documentation.help/AutoCAD-Land-Desktop-ActiveX-VBA/idh_program_guide_vb.htm
  - https://docs.dev.graebert.com/html/2021.0.1/com/d9/d56/interface_i_acad_state.html
- **AutoCAD forum reports (unverified):**
  - Polling the Application object while busy kept AutoCAD busy; caching AcadState helped. https://forums.augi.com/archive/index.php/t-25111.html?pda=1
  - The quiescent flag can stay false during command-line commands. https://forums.autodesk.com/t5/net-forum/quiescent-state-and-command-line/m-p/7143587
- **Office:** `Application.Ready` returns True "when the Microsoft Excel application is ready" (semantics are thin). https://learn.microsoft.com/en-us/office/vba/api/excel.application.ready
- **RetryRejectedCall** return values:
  - -1: cancel (RPC_E_CALL_REJECTED);
  - 0–99: retry now;
  - ≥100: delay that many ms before retrying.

  Retry silently; show the busy dialog only after about 30 s. https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-imessagefilter-retryrejectedcall
- **The repo** already treats 0x80010001 as a back-off signal (P2). P2 also notes that polling is itself a COM call on the UI thread, so it must be cheap and counted in the duty-cycle budget.

**Inferences:**
- **Signal stack, best first:**
  1. app event (push);
  2. a cheap property, polled at about 2–4 Hz only while modifiers are queued, with polls counted in the budget;
  3. busy/rejected HRESULTs;
  4. optional OS idle from a per-session helper.

  The user is active if any signal says so.
- **Hysteresis:** go active immediately; go idle only after the grace period (2 s proposed) of continuous quiet.
- **False idle** (the user is reading) can't be detected. Mitigate it with view save/restore or off-screen capture, plus undo grouping.
- **False active** (a stuck flag) leads to user_active at the deadline. Watch the modifier-wait p95 KPI.
- If the MCP server runs as a stdio child in the user's interactive session, GetLastInputInfo works directly. A service needs the helper.

**Gaps:**
- No public Bentley/MicroStation COM idle or quiescent API docs were found.
- No data on what an out-of-process COM property poll costs on the UI thread. This needs an M5 spike.

## Q3. Scheduling designs and prior art

**Takeaway:** in CAD prior art, the host decides when external work runs (Revit ExternalEvent and Idling; AutoCAD document locks). An out-of-process COM client can only approximate this:
- gate dispatch on idle;
- keep calls short;
- budget UI-thread time.

The M2b design matches this: priority classes with ageing, round-robin per MCP session, token bucket, duty cycle with a yield gap, and an idle gate with a grace period. It needs an injectable clock.

**Cited findings:**
- **Revit ExternalEvent:** after ExternalEvent.Raise(), "Revit will wait for an available Idling timecycle and then call … Execute()". https://help.autodesk.com/cloudhelp/2018/ENU/Revit-API/Revit_API_Developers_Guide/Advanced_Topics/External_Events.html
- **Revit API context:** the API is only valid inside callbacks Revit invokes; calls from a modeless dialog's thread are blocked.
  - https://forums.autodesk.com/t5/revit-api-forum/call-revit-s-api-from-external-thread/td-p/5941308
  - https://blog.autodesk.io/modeless-forms-in-revit/
- **Revit Idling:** `IdlingEventArgs.SetRaiseWithoutDelay()` asks for the next Idling call promptly. https://rvtdocs.com/2025/Autodesk.Revit.UI.Events.IdlingEventArgs
- **AutoCAD:** "modeless dialogs and external process-generated ActiveX requests … must lock the documents". StartUndoMarker and EndUndoMarker take a kWriteLock. https://help.autodesk.com/cloudhelp/2020/ENU/OARX-DevGuide/files/GUID-634ADE0B-35FD-4146-A2D0-3621D2FB5B0C.htm
- **Office Interactive / ScreenUpdating:**
  - `Interactive=False` blocks keyboard and mouse input, and Excel "won't automatically set this property back to True". https://learn.microsoft.com/en-us/office/vba/api/excel.application.interactive
  - `ScreenUpdating=False` must be restored afterwards. https://learn.microsoft.com/en-us/office/vba/api/excel.application.screenupdating
- **Windows "not responding":** an app is treated as not responding if it hasn't called PeekMessage within 5 s (subject to change). https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-ishungappwindow
- **Repo KPIs (proposed):**
  - added p95 input latency < 100 ms;
  - longest single block < 1 s;
  - MCP share of UI-thread time ≤ duty cycle;
  - render cancel < 500 ms.

  P3: a running call can't be pre-empted. Test 18 covers the duty cycle and yield gap with a fake clock; tests 20–21 cover user_active and the grace period.

**Inferences (proposal):**
- **Dispatch loop:**
  1. Choose a class: app > agent-interactive > agent-bulk, with ageing.
  2. Round-robin across sessions within that class.
  3. Skip modifiers unless the user has been idle for the grace period.
  4. Check the budget: busyMs(window) + estCost ≤ dutyCycle × window.
  5. Wait the yield gap after each call.
- **Don't lock input** the way `Interactive=false` does. It inverts "human wins", and a crash would leave the user locked out.
- **Estimate cost per comMethod** with an EWMA of comMs, which CallResult already reports. While the user is active, refuse any call estimated at more than 1 s, returning user_active/app_busy with retryAfterMs.
- **Schedule capture_view like a heavy call,** even though its effect is `read`.
- **1 s KPI vs Windows:** 1 s is well under the 5 s threshold for "not responding".
- **Clock seam:** inject {now, sleep}, or use node:test mock timers, which need no new dependency (not verified this session).

**Gaps:**
- Revit's Idling frequency and the cost of IsQuiescent are not documented.
- It's unknown whether the target app has an in-process hook like ExternalEvent.

## Q4. Protecting user state

**Takeaway:** detection lowers how often collisions happen; state protections limit the damage. The protections:
- explicit document and element IDs;
- never touching the selection or the active document;
- one named undo step per agent write;
- optimistic concurrency;
- a visible "agent acting" indicator;
- write confirmation at M4 via elicitation.

**Cited findings:**
- **Revit undo grouping:** `TransactionGroup.Assimilate()` merges inner transactions into one undo item; `Commit()` keeps one undo item per transaction.
  - https://help.autodesk.com/cloudhelp/2018/CSY/Revit-API/files/GUID-BECA30DB-23B4-4E71-BE24-DC4DD176E52D.htm
  - https://blog.autodesk.io/using-transaction-groups/
- **AutoCAD undo grouping:** undo markers group operations. (ObjectARX guide above)
- **Repo:** W4 (undo) is open, and the previous colour is already returned. zoom_to_elements "Changes the view only", so by design it changes what the user sees.
- **MCP spec 2025-11-25:**
  - Clients: "SHOULD always be a human in the loop with the ability to deny tool invocations", with visual indicators and confirmation prompts.
  - Servers MUST validate inputs, implement access controls, rate-limit and sanitise outputs.
  - Clients MUST treat annotations as untrusted unless the server is trusted.
  - Tool results support `image` content.

  https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- **Elicitation** was added in the 2025-06-18 revision (secondary source, unverified). https://thenewstack.io/how-elicitation-in-mcp-brings-human-in-the-loop-to-ai-tools/
- **Office:** dialogs make automation hang, so code must handle blocking alerts at any time. Office is "non-reentrant, STA-based". https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa

**Inferences (proposals):**
- **WF-5:** capture an off-screen or named view if possible. Otherwise save the camera, zoom, capture and restore, all within one idle window.
- **Explicit documentId** on writes, verified before every write.
- **Concurrency:** compare-and-set with version stamps if COM exposes them; otherwise compare inside the same COM call. A separate pre-read was rejected in W6.
- **Never offer save, close or open tools.** The catalogue complies today.
- **Attribution:** name the undo item ("Agent: set colour (3)") and show a status-bar indicator.
- **Revisit W3:** require confirmation for agent callers on `model` and `heavy` effects, and advertise destructiveHint.

**Gaps:** whether COM offers undo grouping, version stamps, status-bar access or off-screen capture (all open in §10).

## Q5. Ranked risk register

**Takeaway:** the top risks are:
1. UI freezes from long COM calls that can't be pre-empted (P3).
2. Modal dialogs, in both directions.
3. Agent writes hitting the wrong document or unsaved state.
4. Unconfirmed COM capabilities that M2b depends on.

Only these are mitigated in code: serialisation, the deadline, retry classification, explicit-ID writes, LIC14 lease timing and scope separation.

**Cited findings:**
- **STA, non-reentrant, dialog hangs** (Office analogue, above).
- **Busy-app modal on external ActiveX calls** (Land Desktop guidelines, above).
- **Revit dialog interception** (DialogBoxShowing / OverrideResult) exists in-process only. https://rvtdocs.com/2025/Autodesk.Revit.UI.Events.DialogBoxShowingEventArgs
- **The repo already tests the hung-call case** (the prototype plan's Review Focus).
- **MCP token audience:** a server "MUST NOT accept any tokens that were not explicitly issued for the MCP server"; least-privilege, progressive scopes. https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices

**Register.** L = likelihood, I = impact. Status: Code = mitigated on fakes; Plan = designed only; Open = undecided.

| # | Risk | L | I | Mitigation | Status | Detection / de-risking |
|---|---|---|---|---|---|---|
| 1 | UI freeze from a long COM call (capture, big query, render); the deadline frees the caller, not the UI thread (P3) | H | H | cost EWMA per method; refuse calls estimated over 1 s while the user is active; page caps; heavy only when idle + cancel/confirm; duty cycle + yield gap | caps Code; rest Plan | M5 per-method timing on realistic models; L5 soak with scripted UI (p95 added < 100 ms, longest block < 1 s) |
| 2 | Modal dialog blocks automation: the queue stalls and every queued call times out | H | H | deadline and never starting expired work (Code); modal/busy probe; dialog suppression; circuit breaker after N timeouts | deadline Code; rest Open | hung-call fault test exists; L3 provokes known dialogs |
| 3 | An automation-triggered dialog, "server busy" or "not responding" lands on the human | M | H | avoid prompting methods; pass explicit parameters; short calls; honour RETRYLATER | Open | L3 catalogue of methods that raise UI |
| 4 | A modifier hijacks the user's view or edit (no gating today; false idle later) | H today | M–H | idle gate with grace and hysteresis; view save/restore or off-screen capture; undo grouping; explicit IDs | IDs Code; gate Plan; undo Open (W4) | tests 20–21 with a fake clock; L5 "modifiers started while active = 0" |
| 5 | Unconfirmed COM capabilities: activity signal shape/cost, render cancel, undo, version stamps, threading, dialog suppression | H | H | degradation paths: poll within budget, confirm heavy calls, return previous value | Open | ~1-week M5 spike checklist before M2b |
| 6 | Wrong instance or document (multiple instances; the user switches documents between WF-2 and WF-3) | M | H | bind to process and document; documentId in IDs; verify before write | Open | L3 with two instances and a document switch |
| 7 | An agent overwrites a concurrent user edit | M | M | compare-and-set; not_found on stale IDs (Code) | partly Code | L5: user edits the same element |
| 8 | A prompt-injected agent performs writes (element names and properties are untrusted LLM input) | M | H | separate model:write scope (Code); elicitation confirm at M4; rate and volume caps; undo | partly Code; rest Plan | L4 red-team evals |
| 9 | Writes into unsaved user work | M | H | no save/close tools (Code); undo-grouped, attributed writes; optional "saved" pre-check | partly Code | product decision; L3 crash-during-write test |
| 10 | COM reference leaks keep the app alive (S7) | M | M | release in finally; reconnect discards references | Plan (no adapter yet) | L5: process, handle and memory drift (hard gate 0) |
| 11 | Identity mismatch: MCP subject ≠ the app's signed-in user | M | H | compare at the WF-1 handshake; refuse or follow a defined policy | Open (A5/LIC13) | L3 with two accounts |
| 12 | Licence double consumption (LIC10) or seat leak | M | M–H | pre-check only if the app consumes the licence itself; LIC14 release on real finish (Code); license_released events | LIC14 Code; LIC10 Open, critical | L3: watch the seat count during one render |
| 13 | Image payload: base64 inflates ~4/3; the 100 KB cap is applied after COM has already spent UI time | H | M | pass size/resolution into the capture call; MCP `image` content or resource_link; cap before calling | post-hoc cap Code | M5: measure real capture sizes |
| 14 | Flaky real-timer tests on Windows CI | M | L–M | injectable clock | Plan | Windows CI rerun-failure rate |
| 15 | Telemetry PII and cardinality (raw unknown tool names) | L–M | M | pseudonymise; bucket names; align with the Python MCP (T4) | partly Code; logged in §11 | schema review |
| 16 | Starvation: maxPending 10 is global, so one flooding agent fills it and the others get app_busy | H with several agents | M | per-session token bucket and queue cap; round-robin (P5/P6) | Plan | test 16 with a fake clock |

**Inferences:**
- The headline risk is P3. Every user-facing guarantee depends on per-call COM cost, which hasn't been measured. Second is the shape and cost of the activity API. One M5 spike on a real Windows box addresses both.
- **Suggested order:**
  1. M5 capability and timing spike.
  2. Injectable clock, plus the scheduler with the idle gate (tests 18, 20, 21).
  3. View save/restore and undo grouping.
  4. Write confirmation at M4.
  5. L5 soak with scripted UI input.
- **Redesign trigger:** if real calls routinely exceed ~1 s, or idle detection can't be made cheap, move to an in-process add-in that runs on the app's idle callback (the ExternalEvent analogue).

**Gaps:**
- The target app's dialog behaviour, its ROT registration with several instances, and whether render consumes a licence seat all need vendor or architect input.
- The L/I ratings are judgement, not measurements.

## Discrepancies found in the repo (read-only, not fixed)
- The README claims a `UserActivityMonitor` interface exists; it doesn't in src/.
- capture_view is classified `read`, but its UI-thread cost behaves like a heavy call.
- The size cap is applied after COM has already run.
- maxPending is global, so one session can starve the others today.
