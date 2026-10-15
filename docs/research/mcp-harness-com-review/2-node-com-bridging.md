# Node ↔ COM bridging: research notes

_Research notes, 2026-10-15. Compiled by AI research agents from primary sources and a read-only review of this repository. Unverified claims are tagged. See the [README](README.md) for how to read them._

**Recommendation:** an out-of-process .NET helper behind `HelperComClient implements ComClient`. The helper owns one STA thread with a message pump and an `IOleMessageFilter`, binds early against the CAD type library, and exposes a whitelist of operations over newline-delimited JSON-RPC on stdio. `ComSession` stays unchanged. Use winax only as an optional M5 spike for baselining.

## 1. winax (node-activex)
- **Releases:** latest npm release is 3.6.9 (2026-03-31). The 3.6.x line also includes 3.6.3 (2026-01-13), 3.6.4 (2026-01-23), 3.6.5 (2026-02-11), 3.6.6 and 3.6.8 (both 2026-03-19), and 3.6.2 (2025-03-27). https://registry.npmjs.org/winax
- **Packaging:** every 3.6.x has `engines node>=10`, `gypfile: true`, `install: node-gyp rebuild`, no dependencies and no prebuilt binaries. [unverified: the registry extract showed 3.6.6 with a "deprecated" field]
- **README** (https://github.com/durs/node-activex):
  - Lists Node 10/12/16/18/20/22/23 on x86/x64.
  - Building needs node-gyp, Python and MSVC; bitness follows the installed Node; Electron needs a rebuild.
  - Events fire only during `WScript.Sleep`.
  - Out-parameters use a byref `Variant`; dates map to VT_DATE.
  - SAFEARRAY: "second dimension is only deduced from the first array".
  - `winax.release()` exists, with the caveat that "other temporary objects may be keep references too".
- **Source** (src/main.cpp):
  - `CoInitialize(0)` (STA) runs in `DllMain` on PROCESS_ATTACH, i.e. on the Node main thread.
  - No message loop, no `CoRegisterMessageFilter`, no worker or async threads.
  - Uses the raw V8 API rather than N-API, so it needs a rebuild for every Node/Electron ABI.
- **Open issues:**
  - #158: Electron 41+ rebuild fails (2026-03).
  - #153: Node 24.2 install fails.
  - #143: Node 23.
  - #141: "Add timeout to COM initialization".
  - #138: Defender flags it as a Trojan.
  - Closed: #145 and #129 (Electron freeze and crash).
- **Inference:**
  - Every cross-process call blocks the event loop, so `ComSession`'s deadline `setTimeout` can't fire during a hung call.
  - There is no message filter.
  - There is no hard timeout short of killing the MCP server.
- **Gaps:** no changelog, no production reports, and it's unclear how winax exposes the HRESULT on errors.

## 2. edge-js (https://github.com/agracio/edge-js)
- Supports Windows on the 4 latest even Node LTS releases (20/22/24/26), with no x86 for 24 and 26.
- Supports .NET Core 3.1–9.x and defaults to .NET 4.5 on Windows; .NET 10 isn't stated.
- The CLR runs in-process and "reconciles threading models".
- Electron needs `electron-edge-js`. The README itself says "Some of the original documentation is outdated".
- **Inference:** you would still write your own STA thread and message pump in C#, without crash isolation.

## 3. Helper and other alternatives
- **Message filter:** Microsoft's documented fix for 0x80010001 / 0x8001010A is an `IOleMessageFilter` on an STA thread. `RetryRejectedCall` returns 99 to retry and -1 to cancel. https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2010/ms228772(v=vs.100)
- **Releasing references:** `Marshal.ReleaseComObject` decrements the RCW reference count. Misuse causes `InvalidComObjectException` or access violations, and Microsoft says to use it "only if absolutely required". `FinalReleaseComObject` is the alternative. https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.marshal.releasecomobject
- **PowerShell per call:** `pwsh -noprofile -command 1` averaged about 1176 ms (PowerShell team blog, 2021), far too slow per call. https://devblogs.microsoft.com/powershell/optimizing-your-profile/
- **pywin32 sidecar:** build 311 (2025-07-14) supports CPython 3.8–3.14. Viable if the organisation already ships Python, and consistent with the Python MCP.
- **koffi / raw vtables:** not recommended; you would hand-roll IDispatch and VARIANT handling, and calls stay synchronous. (Judgement.)
- **Helper pros:**
  - It owns the STA thread and can register the message filter.
  - Node's event loop never blocks.
  - Killing and respawning the helper gives a hard timeout.
  - Crashes and leaks are contained.
  - Bitness is independent of Node.
  - Typed interop through tlbimp or a PIA.
  - Image work happens off the Node thread.
  - Event sinks can supply the P2 user-activity signal.
- **Helper cons:**
  - A second signed deployable.
  - A protocol version handshake.
  - A .NET runtime (or a self-contained build).
  - IPC latency, not yet measured.
  - It must run in the same logon session and at the same integrity level as the CAD app.

## 4. Late vs early binding
- winax binds late via IDispatch, with manual Variant typing.
- Early binding against the type library gives compile-time signatures, type coercion and a source for generating schemas.
- **Proposal:** keep string dispatch in Node (`call(method, args)`); the helper exposes typed, whitelisted operations.
- **Needed from the vendor:**
  - ProgID/CLSID.
  - Whether to attach with `GetActiveObject` or create with `CoCreateInstance`.
  - Whether a type library or PIA exists.
  - Threading model.
  - The real "not found" HRESULT (0x80070490 is a placeholder in src/errors.ts).

## 5. Message filter, cancellation, leaks
- **Message filter limits:** `CoRegisterMessageFilter` allows one filter per thread, and "Threads in multithreaded apartments cannot have message filters." https://learn.microsoft.com/en-us/windows/win32/api/objbase/nf-objbase-coregistermessagefilter
- **Cancelling calls:**
  - `CoCancelCall` only cancels an outbound call pending on a given thread. It returns `CO_E_CANCEL_DISABLED` unless cancellation is enabled, and the server must poll `CoTestCancel`. https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-cocancelcall
  - "S_OK does not mean that the call was canceled". https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-icancelmethodcalls-cancel
  - `CoEnableCallCancellation` is off by default for synchronous calls and causes "serious performance degradation". https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coenablecallcancellation
- **Inference:** this matches plan P3 and LIC14: the CAD UI thread finishes the work regardless of what the client does.
- **Timeout ladder:**
  1. The soft deadline in `ComSession`.
  2. A hard watchdog in `HelperComClient` that kills the helper and rejects with `ComError(RPC_S_SERVER_UNAVAILABLE)`. The existing session_lost path then reconnects and respawns, and `reconnected` flags W6.
- **Caveat:** after a kill the CAD may still be working, which weakens LIC14. Confirm with the vendor that a client dying mid-call leaves no document locks.
- **S7 leaks:**
  - `try/finally` with `ReleaseComObject` per operation.
  - Recycle the helper periodically.
  - Watch the CAD process's memory in the L5 soak.

## 6. Protocol sketch (proposal)
- **Transport:** NDJSON on stdio. Logs go to stderr only, never to agents (E6).
- **connect():** spawn the helper, then `hello{protocol:1}`, then `attach{progId, mode:getActive|create}`. Failure maps to `app_unavailable`.
- **call():** send `invoke{op,args,deadlineMs}`. The helper checks `op` against the whitelist, runs it on the STA thread, and releases intermediates in `finally`.
- **Errors:**
  - The helper returns `{error:{hresult:<unsigned>,message}}`, which becomes `new ComError(hresult,message)`; `classifyComError` stays unchanged.
  - On helper exit, EOF or a bad line, reject everything pending with `RPC_S_SERVER_UNAVAILABLE`, which triggers the E5 reconnect + 1 retry.
- **Retry budget:** keep the helper's `RetryRejectedCall` budget bounded (about 2 s, then -1) and well under the deadline, so it doesn't compound with `ComSession`'s backoff.
- **Events:** the helper pushes notifications without an id.
- **Testing:** a fake helper script tests framing, crash and timeout paths on any OS; L3 runs on Windows against the real app.

**One-line summary:** "winax puts an STA on Node's main thread, so it blocks the event loop, can't register a message filter, and can't time out a hung call. So M5 is a small .NET STA helper with `IOleMessageFilter` and early binding over stdio JSON-RPC. To Node it's just another `ComClient`: HRESULTs become `ComError`, and a hung call trips a watchdog that kills the helper, which our reconnect path already treats as session lost. The cost is a second signed artefact and IPC latency, which we'll baseline at M5."

**Open gaps:**
- IPC vs COM latency hasn't been measured.
- Unknown: the vendor's ProgID, type library, singleton behaviour and HRESULTs.
- Unknown: whether .NET or Python is already deployed on CAD workstations.
- Unknown: whether winax builds on Node 24/26.
