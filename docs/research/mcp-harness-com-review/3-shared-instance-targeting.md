# Shared app instance and instance targeting: research notes

_Research notes, 2026-10-15. Compiled by AI research agents from primary sources and a read-only review of this repository. Unverified claims are tagged. See the [README](README.md) for how to read them._

(Items marked [unverified] came from the researcher's own knowledge or from search summaries it could not open.)

## Q1. What goes wrong when a live user and the automation share the app

**Takeaway:** with an out-of-process STA server, every automation call competes with the user for the single UI thread. The app rejects calls whenever it is in a user-controlled state (a modal dialog or prompt) or busy, so rejections are normal while a user is present, not rare faults. The bigger risks sit above COM: the active document, view, selection and undo stack are shared with the user, and any of them can change between two calls.

**Cited findings:**
- **IMessageFilter** "selectively handle[s] incoming and outgoing COM messages while waiting for responses from synchronous calls… [to avoid] deadlocks". While a synchronous call is waiting, "COM enters a modal loop… the caller is still able to receive and dispatch incoming messages". That is how reentrancy happens. Input-synchronized calls must complete before the callee gives up control. During logoff, outgoing LRPC calls are restricted. https://learn.microsoft.com/en-us/windows/win32/api/objidl/nn-objidl-imessagefilter
- **HandleInComingCall (server side)** can return:
  - `SERVERCALL_ISHANDLED`;
  - `SERVERCALL_REJECTED` (e.g. the app is terminating);
  - `SERVERCALL_RETRYLATER` ("when it is in a user-controlled modal state").

  The caller sees `RPC_E_CALL_REJECTED`. Input-synchronized and asynchronous calls are dispatched even if the app rejects. https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-imessagefilter-handleincomingcall
- **RetryRejectedCall (client side)** return values:
  - `-1`: cancel (`RPC_E_CALL_REJECTED`);
  - `0–99`: retry immediately;
  - `≥100`: wait that many milliseconds, then retry.

  Apps "should silently retry" RETRYLATER; after about 30 s an interactive app shows the OLEDLG busy dialog. Silent retry is for "background tasks… nonintrusive". `htaskCallee` is the callee thread id, which maps to a PID via `OpenThread` + `GetProcessIdOfThread`. https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-imessagefilter-retryrejectedcall
- **Visual Studio automation guidance:** out-of-process callers get 0x80010001 "Application is busy" and 0x8001010A "Call was rejected by callee" because of "threading contention". The fix is to register a filter with `CoRegisterMessageFilter` on an STA thread; in-process callers don't hit these errors. Its sample retries immediately and without bound (`return 99`), which is an anti-pattern. https://learn.microsoft.com/en-us/previous-versions/ms228772(v=vs.140)
- **Office prior art:** the apps "assume that they are being run interactively", and a dialog makes the app look hung. Code must "identify and process blocking alerts at any time". A user identity is required, so sign-in prompts can appear. The apps are "non-reentrant, STA-based… for a single client"; multiple instances race; solutions should monitor and restart the app. Automating from NT services is not recommended or supported. https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa
- **AutoCAD forums [search summary only]:**
  - A message filter fixed "call rejected by callee". https://forums.autodesk.com/t5/net-forum/actviex-can-t-create-object-call-rejected-by-callee-problem/td-p/3053724
  - `GetActiveObject` failed while the splash screen was showing and worked after loading. https://forums.autodesk.com/t5/net/get-autocad-application-instance/td-p/10966377

**Inferences mapped to the plan:**
- **Rejections and the client filter:**
  - `errors.ts` already classifies 0x80010001 and 0x8001010A as transient, and `ComSession` retries them for retry-safe tools (E2–E4).
  - Without a client-side message filter, behaviour depends on the COM bridge: it may fail immediately, or show a "Server Busy" dialog in the MCP process, which on a headless host would block forever [unverified; test on Windows].
  - The helper should register a filter that returns -1 (fail fast), so retry, backoff and deadline policy stay in `ComSession` (S1/S4).
- **Rejections as an activity signal:** a sustained run of RETRYLATER means the user is in a modal state. Feed it to `UserActivityMonitor` (P2) and map it to `user_active` rather than `app_busy`.
- **Reentrancy:** COM pumps messages while a call is outstanding, so app events can arrive in the MCP process mid-call. Event handlers must enqueue, never call COM synchronously (S2).
- **RPC_E_CANTCALLOUT_ININPUTSYNCCALL** (0x8001010D) [unverified constant]: classify as permanent and never retry.
- **Races with the user:**
  - The active document or view changes between calls, so use explicit IDs and re-check them on every call (S6 → `not_found`).
  - Selection-based APIs clobber the user's selection.
  - Agent and user edits interleave on the undo stack, so make each modifier one undo group if the app supports it (W4).
  - `Activate`, `Visible` and opening documents steal focus, so gate them on user idle (P11).
  - Batch writes repaint per element; any redraw-suspend must be reset in `finally`.
  - The user closing a document should give `not_found`, not a reconnect. The user closing the app gives 0x800706BA / 0x80010108 (`session_lost`, E5).
  - Licence, sign-in and save prompts keep the app modal until a human answers: return `user_active`, and don't retry past the deadline.

**Gaps:**
- Undo grouping for external COM callers, and a redraw-suspend switch, need the CAD team to confirm.
- Office server-side KB 257757 could not be fetched.
- How winax behaves on a rejection (busy dialog) needs a Windows experiment.

## Q2. How to identify and attach to the correct instance

**Takeaway:** creating the object (`CoCreateInstance` / `new ActiveXObject`) asks COM for an instance. It does not attach to the user's window, and may start a new hidden process, depending on how the class factory was registered. `GetActiveObject` returns the one object registered as active for the class. Two vendors document that this is the *first* instance (AutoCAD officially, Office via a blog), and it may be missing entirely. Reliable targeting needs a key per instance (a document path in the ROT, a PID or an HWND), checked after attaching.

**Cited findings:**
- **REGCLS:**
  - `REGCLS_SINGLEUSE`: after a client connects, the class object is "removed from public view", so the next create starts a new process.
  - `REGCLS_MULTIPLEUSE`: many clients share one instance.

  https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/ne-combaseapi-regcls
- **RegisterActiveObject:**
  - Registers one active object per CLSID in the ROT.
  - A visible app should quit only on an explicit user command or `Quit`.
  - It uses weak registration plus `CoLockObjectExternal`.
  - "Other ActiveX clients may be using the object… should not force the object to shut down".

  https://learn.microsoft.com/en-us/windows/win32/api/oleauto/nf-oleauto-registeractiveobject
- **ROT access and duplicates:**
  - Without `ROTFLAGS_ALLOWANYCLIENT`, "only clients in the window station that registered the object can connect to it"; that flag is only for LocalService or RunAs servers.
  - A duplicate moniker returns `MK_S_MONIKERALREADYREGISTERED`, and then there is "no way to determine which object will be returned".
  - Apps that support linking register their documents under a moniker when they load them.
  - Since Windows Server 2003, COM removes stale entries left by crashed servers.

  https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-irunningobjecttable-register
  The ROTFlags AppID value gives "activate as activator" servers any-client access. https://learn.microsoft.com/en-us/windows/win32/com/rotflags
- **UAC integrity levels:** "COM prevents clients at a lower integrity level from binding to running instances of servers at a higher integrity level, unless the server programmatically allows access". Services run at system integrity in the isolated Session 0. https://learn.microsoft.com/en-us/previous-versions/dotnet/articles/bb625962(v=msdn.10)
  The `GetActiveObject` caller must have the same integrity level as the app [third-party, search summary]. https://libreautomate.com/api/Au.More.ComUtil.GetActiveObject.html
- **Office ROT registration** [KB 238610; the page now returns 404/410, content from a search summary]:
  - Office registers in the ROT not at startup but when it loses focus; calling earlier gives error 429 / 0x800401E3. Microsoft calls this "by design".
  - Office doesn't register a second instance if one is already registered, but it does register documents.
  - Workaround: enumerate the ROT (`GetRunningObjectTable` → `EnumRunning` → `GetDisplayName`), match the document path, bind and use `.Application`. https://andrewbaker.ninja/2021/08/18/how-to-iterate-the-com-running-objects-table-in-c/ (third-party)
- **AutoCAD official docs:** "Use version-dependent ProgIDs." With multiple sessions, "GetObject… will return the first instance of AutoCAD in the Windows Running Object Table." https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-ActiveX/files/GUID-73EC319D-9D7D-43FF-91B7-78CF36284028.htm
- **MicroStation analogue** (community only; Bentley Communities now redirects to ServiceNow):
  - Attach with `GetObject(, "MicroStationDGN.ApplicationObjectConnector")`, then `.Application`.
  - Results vary by product and type library (V8i vs OpenRoads).
  - COM reportedly can't tell multiple MicroStation processes apart and connects to the first opened instance.
  - A moderator advised running a macro or key-in inside each process instead.
  - Don't create the connector with `new`.

  Threads 208260, 239323 and 227846 on communities.bentley.com.

**Inferences: recommended policy:**
- **Where the helper runs:** in the user's interactive logon session, at the same integrity level as the app (usually medium). An MCP server running as a Windows service can't see the user's ROT. The target user comes from the verified identity (plan §4), not from a PID the client supplies.
- **Attach, don't launch:** attach-only by default, because launching silently creates a hidden copy on single-use servers. Return `app_unavailable`; launching is an explicit opt-in tool.
- **Choose the instance explicitly:**
  - Enumerate candidates from the ROT, processes and windows: {pid, hwnd, version, open document paths}. Cross-check against app properties (Hwnd, ProcessID, active document full name) [unverified for the target app].
  - Select by document path, then PID, then "the only instance". If several match, refuse with an ambiguity error listing the candidates; never silently take the first ROT entry.
  - A file moniker (`CoGetObject` / `BindToMoniker` on a path) attaches to the instance that has that file open. Test this: it may open the file instead.
- **Reconnect to the same instance only (S5/E5):**
  - Store a fingerprint on connect: {PID, process start time (to guard against PID reuse), HWND, version, document}.
  - On session loss, if that PID and start time are gone, return `app_unavailable` and ask for a re-selection. Never rebind to whatever `GetActiveObject` returns next.
  - Rebind automatically only if the document and version both match. Even then, keep `reconnected: true`, since stable IDs (S6) may be stale.
- **Version handshake:** re-run WF-1 `get_app_info` on every connect and reconnect, and pin version-dependent ProgIDs.
- **Detecting exit:** wait on the PID handle (`SYNCHRONIZE` is allowed across integrity levels), use an app `OnQuit` event, or rely on 0x800706BA.
- **Code impact:** `ComClient.connect()` takes no target and returns no identity today. It needs a selector argument and must return a fingerprint, so `ComSession` can enforce the same-instance rule.

**Gaps:**
- Unknown for the target app: whether it registers documents in the ROT, whether its class factory is single- or multi-use, when it registers as the active object, and whether it exposes its HWND or PID over COM.
- There are no official Bentley docs on `ApplicationObjectConnector` or multi-instance behaviour.
- The ROT being per logon session is inferred from the documented per-window-station rule.
- SolidWorks and Rhino were not researched.
