# Using the COM-backed MCP prototype from an agent harness (Claude Code / Claude Desktop): gaps, auth, image results, merge gating

Research date: 2026-10-15. Spec revisions relied on:
- **MCP 2026-07-28** (the current revision; `/specification/latest` resolves to it). The previous revision is 2025-11-25.
- **Claude Code MCP docs** as published on code.claude.com, fetched 2026-10-15.
- **Claude API vision docs** on platform.claude.com, fetched 2026-10-15.

Labels used throughout: **[SPEC]** = what the MCP spec or an RFC says. **[CLAUDE]** = documented behaviour of Claude clients. **[CODE]** = what this repo does today, read from source. **[REC]** = my recommendation or inference.

Codebase facts this note relies on [CODE]:
- There is no transport. `src/main.ts` only imports `./validation/cli.ts`, which does `console.log(formatReport(report))`.
- `handleToolCall(deps, req)` in `src/pipeline.ts` takes `ToolRequest { tool, input, token, correlationId, workflowId? }` and returns `ToolResult = {ok:true,data} | {ok:false,error:{code,message,correlationId,detail?}}`.
- The size check is `Buffer.byteLength(JSON.stringify(data))` against `MAX_RESULT_BYTES = 100_000` (`src/tools.ts`). The comment there reads "≈25k tokens at ~4 bytes/token".
- `ToolDef` (`src/tools.ts`) has `name`, `description`, `effect`, `retrySafe`, `scope`, `licenseFeatures`, `comMethod`, imperative `toArgs` validators, and optional `mapResult` and `elementCount`. It has no JSON Schema.
- `CAPTURE_VIEW` has no `mapResult`. Its description is "PNG image of a view (WF-5)" and it takes only `viewId`. `FakeCadModel` `View.Capture` returns `{ mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==" }`.
- `AuthClient.verify(token)` returns `Principal {subject, actor, callerType, scopes}`.
- `ComSession` has a 30 s `deadlineMs`. `execute(method,args,retrySafe,onSettled)` takes no AbortSignal.
- CI (`.github/workflows/ci.yml`) runs a matrix over `[ubuntu-latest, windows-latest]` with `fail-fast: false`. The job is named `Typecheck + tests (${{ matrix.os }})`, and `concurrency: cancel-in-progress: true` is set.

## 1. Gap analysis: what's missing to be a working MCP server for Claude

### Takeaway
The pipeline is transport-independent and already has most of the hard behaviour: auth, licensing, deadline, error taxonomy and telemetry. What's missing is a thin MCP adapter, and that adapter is where the friction appears:
- **Schemas:** the imperative validators have no JSON Schema.
- **Results:** `ToolResult` is JSON-only and capped at 100 KB, so it can't carry an image.
- **Identity:** the per-request `token` field has no MCP equivalent on stdio.
- **Cancellation:** there's no way to propagate it.
- **Protocol era:** the plan's "MCP session" notion predates the 2026-07-28 stateless protocol.

### Cited Findings
- [SPEC] The latest revision is 2026-07-28. It removes protocol-level sessions and `Mcp-Session-Id`. Servers that need cross-call state "use explicit, server-minted handles passed as ordinary tool arguments". — [MCP changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [SPEC] 2026-07-28 also makes MCP stateless:
  - It removes the `initialize` handshake; every request carries protocol version and client capabilities in `_meta`.
  - It adds `server/discover`, which servers MUST implement.
  - It removes `ping` and `logging/setLevel`.
  - It deprecates Roots, Sampling and Logging. The suggested migration is to "log to `stderr` (stdio) or use OpenTelemetry instead of Logging".
  - It introduces Multi Round-Trip Requests (`resultType: "input_required"`), which replace server-initiated `elicitation/create` requests.
  - It adds a required `resultType` field to all results.
  - It moves tasks to an extension.
  - Source: [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [SPEC] Servers with tools MUST declare the `tools` capability. The `tools/list` result "MUST NOT vary per-connection" but "MAY vary by the authorization presented on the request — for example, returning only the tools the caller's granted scopes permit". Servers SHOULD return tools in a deterministic order. — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [SPEC] Each `Tool` has `name`, optional `title`, `description`, `icons`, `inputSchema`, optional `outputSchema` and optional `annotations`.
  - `inputSchema` "MUST be a valid JSON Schema object (not `null`)" and defaults to 2020-12.
  - For tools with no parameters, `{ "type": "object", "additionalProperties": false }` is "Recommended".
  - Source: [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [SPEC] Structured results go in `structuredContent`. "A tool that returns structured content SHOULD also return the serialized JSON in a TextContent block". If an `outputSchema` is given, "Servers MUST provide structured results that conform to this schema". — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [SPEC] The spec defines two error paths. "Protocol Errors" are JSON-RPC errors for an unknown tool, malformed requests or server errors (example code `-32602`). "Tool Execution Errors" are results with `isError: true` for API failures, input validation errors and business-logic errors. "Clients SHOULD provide tool execution errors to language models to enable self-correction." — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [SPEC] `ToolAnnotations` are **hints**, and "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers". Defaults:
  - `readOnlyHint`: false.
  - `destructiveHint`: true. Meaningful only when `readOnlyHint == false`. "If false, the tool performs only additive updates".
  - `idempotentHint`: false. "Calling the tool repeatedly with the same arguments will have no additional effect".
  - `openWorldHint`: true.
  - Source: [MCP schema.ts 2026-07-28](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)
- [SPEC] Progress and cancellation:
  - A request opts into progress with `_meta.progressToken`, and "The receiver is not obligated to provide these notifications".
  - `notifications/progress` carries `{progressToken, progress, total?, message?}`.
  - `notifications/cancelled` carries `{requestId, reason?}` and "MAY arrive after the request has already finished".
  - In 2026-07-28, request-scoped notifications such as progress "continue to flow on the response stream of the request they relate to".
  - Sources: [schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts); [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [SPEC] On stdio, the server "MUST NOT write anything to its `stdout` that is not a valid MCP" message. It "MAY write UTF-8 strings to `stderr` for any logging purposes". — [stdio transport spec source](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/stdio.mdx)
- [SPEC] Servers expose an `instructions` string intended to describe the server, and it "should not duplicate information already in tool descriptions". In 2026-07-28 it appears in the `server/discover` result. — [schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)
- [SPEC] Stateful tools guidance: "MCP has no protocol-level session". A handle "is a name, not a capability", and the server "should validate the caller's authorization against the handle on every call". — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [CLAUDE] Claude Code has two client runtimes:
  - v1 is built on TS SDK 1.x.
  - v2 is built on TS SDK 2.0, "which adds MCP protocol revision 2026-07-28".
  - v2 "asks HTTP, stdio, and claude.ai connector servers whether they support the newer revision… It connects to every other server as v1 does."
  - The runtime can be forced with `MCP_SDK_GENERATION=v1|v2`.
  - Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude Code limits tool descriptions and server instructions:
  - Server instructions and upfront tool descriptions are cut at 4,096 chars. Deferred (tool-search) tool descriptions are cut at 16,384 chars.
  - "Only tool names and server instructions load at session start" when tool search is on, which is the default.
  - Server authors should write instructions that say what category of tasks the tools handle and when Claude should search for them.
  - Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude Code validates tool input schemas:
  - It excludes tools whose top-level property names aren't 1–64 chars of `[A-Za-z0-9_.-]`, and tools whose schema isn't valid draft 2020-12.
  - It flattens root-level `anyOf`/`oneOf`/`allOf`. "Your server receives whichever arguments Claude chose, so keep validating the combination server-side."
  - Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] `_meta["anthropic/requiresUserInteraction"]: true` on a tool makes Claude Code prompt on every call, "even in `acceptEdits`, `auto`, and `bypassPermissions`", with no "don't ask again" option. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude Code timeouts and long calls:
  - `MCP_TOOL_TIMEOUT` is "about 28 hours" when unset, and a per-server `timeout` (ms) overrides it.
  - The idle timeout is 30 min for stdio.
  - Main-conversation calls still running after 2 minutes are auto-backgrounded, and the task entry "shows the latest progress the server has reported".
  - Stopping the task cancels the call, but "Stopping doesn't guarantee the server stops".
  - Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] The TS SDK `main` branch is v2, split into `@modelcontextprotocol/server` and `@modelcontextprotocol/client` and "implementing the 2026-07-28 MCP spec". v1 is `@modelcontextprotocol/sdk` (branch `v1.x`), which gets "bug fixes and security updates for at least six months after the v2 release". Tools are registered with `server.registerTool(name, {description, inputSchema: z.object(...)}, handler)`; Standard Schema covers Zod v4, Valibot and ArkType. Transport: `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. — [typescript-sdk README](https://github.com/modelcontextprotocol/typescript-sdk)

### Inferences
These are my recommendations [REC]. The concrete changes, by file:

**1. Transport and entry point (M4).** Add a new `src/mcpServer.ts` and change `src/main.ts`.
- Adding the SDK is a dependency; per `CLAUDE.md`, ask first. Today the choice is between v2 `@modelcontextprotocol/server` (2026-07-28) and v1 `@modelcontextprotocol/sdk`. Plan §9 M4 names the v1 package, which is now the legacy line.
- `main.ts` must stop routing to the validation CLI. The `console.log` in `src/validation/cli.ts` would corrupt the stdio stream if it ran in the server process.
- Telemetry sinks must write to stderr or a file, never stdout.

**2. Schemas.** `ToolDef` has validators (`toArgs`) but no declarative schema.
- Add an `inputSchema` field per tool, or define each tool's input with Zod or Standard Schema and derive both the JSON Schema and `toArgs` from it, so the two can't drift.
- Encode limits the model should see: `pageSize` 1..`MAX_PAGE_SIZE`, `ids` maxItems `MAX_IDS_PER_CALL`, colour `pattern ^#[0-9a-fA-F]{6}$`, cursor as an opaque string.
- `get_app_info` and `get_active_view` should use `{type:"object", additionalProperties:false}`.
- Keep server-side validation. Claude Code may flatten combinators, and the spec says servers MUST validate inputs.

**3. Result mapping.** Add `toCallToolResult(ToolResult)` in the adapter.
- On success, return `content: [{type:"text", text: JSON.stringify(data)}]` plus `structuredContent: data`. Add `outputSchema` for the JSON tools.
- On failure, return `isError: true` with text that keeps the stable `code`, `message`, `correlationId` and `detail.feature`. Optionally also put them in `structuredContent` so the agent can branch on the code.
- Edge case: the pipeline turns an unknown tool name into `invalid_input` (`pipeline.ts`). Under MCP the SDK answers an unknown tool with a JSON-RPC protocol error before the pipeline runs, so the T1 "exactly one telemetry event per call" invariant won't see those calls. Decide whether that matters.
- `capture_view` needs a different content type; see §3.

**4. Annotations derived from `effect` and `retrySafe`.**

| Tool(s) | `effect` | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|---|
| read tools, incl. `capture_view` | read | true | – | – | false |
| `zoom_to_elements` | view | false | false | true | false |
| `set_element_color` | model | false | debatable, see below | true (`retrySafe`, W1) | false |

- `openWorldHint` should be false everywhere: the domain is a single local app. The spec default is true, so it must be set explicitly.
- For `set_element_color`, the spec default for `destructiveHint` is true. Overwriting a colour loses the old value, but the tool returns `previous`, so the candidate must choose. I'd leave it true until undo (W4) exists.
- `title` gives a human-readable label.
- Annotations are hints only, so the server-side scope check (D3) stays the real gate.
- Optionally set `_meta["anthropic/requiresUserInteraction"]` on `set_element_color`. That gets a per-call human prompt in Claude Code without implementing elicitation, which is relevant to W3/D7.

**5. Progress and cancellation.**
- The 30 s `deadlineMs` is far below Claude Code's defaults (about 28 h tool timeout, 2 min auto-background), so client timeouts are not the issue for the MVP tools.
- The issue is cancellation. A `notifications/cancelled` or a stopped background task can't reach `ComSession.execute`, which has no AbortSignal. A queued call should be dropped on cancel. A running STA call can't be pre-empted (P3), so a cancel must not release licence leases early (LIC14 already covers the timeout path).
- Progress notifications are useful mainly for queue wait. A modifier waiting for user idle (P11) could report "waiting for user to go idle".

**6. Pagination.** The tool-level `cursor` and `pageSize` arguments for `query_elements` and `list_elements_in_view` are fine; MCP's own `tools/list` cursor is unrelated. Return `nextCursor` inside `structuredContent` and say in the description that it's opaque. Per the "handles" guidance, cursors should be opaque, bound to the caller, and expire.

**7. "MCP session" vocabulary.** Plan items P4, P9, D6 and the per-MCP-session rate limits assume a protocol session. Under 2026-07-28 there is no protocol session.
- On stdio, the process is the de-facto session.
- Over HTTP, per-request auth is the only identity. Key rate limits by `(subject, actor)` from the token, not by a session id.

**8. Server instructions.** Write them, staying under 4,096 chars. They are the only thing Claude sees upfront under tool search. Cover:
- "CAD app via COM; one shared UI thread".
- "Writes only by explicit IDs from `list_elements_in_view` or `query_elements`".
- "`user_active` means retry after `retryAfterMs`".
- "`capture_view` returns an image".

**9. Logging.** Use stderr per the stdio spec. MCP Logging is deprecated in 2026-07-28.

### Gaps
- I didn't verify which protocol revision Claude Desktop (as opposed to Claude Code) negotiates today, or whether it is on SDK v2.
- I didn't verify how Claude Code surfaces `structuredContent` versus the text block to the model, for example which one the model sees when both are present.

## 2. Authentication: spec vs the plan's delegated per-call token

### Takeaway
MCP authorization (OAuth 2.1 resource server with RFC 9728 metadata, RFC 8707 audience binding, no token passthrough) applies **only to HTTP transports**. A stdio server "SHOULD NOT" use it and should get credentials "from the environment".

The plan's D1–D8 (delegated token with subject plus actor, audience-bound, never passed through, `callerType` only from the verified token) aligns with the spirit of the spec. The **mechanics** clash with stdio: `ToolRequest.token` has no place in an MCP `tools/call`, and it must never become a tool argument. On stdio, the token must come from the launch environment or a local broker, typically the signed-in desktop app.

The agent-vs-app distinction should come from an RFC 8693 `act` claim minted by the auth service. It must not come from MCP `clientInfo`, which is self-asserted.

### Cited Findings
- [SPEC] "Authorization is OPTIONAL… Implementations using an HTTP-based transport SHOULD conform… Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment." — [MCP Authorization (2026-07-28)](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- [SPEC] The MCP server is an OAuth 2.1 resource server.
  - It "MUST implement OAuth 2.0 Protected Resource Metadata (RFC9728)". Clients MUST use it for authorization-server discovery.
  - A 401 includes `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource", scope="…"`.
  - On insufficient scope the server returns 403 with `error="insufficient_scope"` and the scopes needed. Servers "SHOULD include all scopes required for the current operation in a single challenge".
  - Source: [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- [SPEC] Client registration and audience binding:
  - Client ID Metadata Documents are the SHOULD.
  - Dynamic Client Registration is a MAY and is **deprecated** in 2026-07-28.
  - Clients MUST send the RFC 8707 `resource` parameter (the server's canonical URI) in authorization and token requests.
  - Servers "MUST validate that access tokens were issued specifically for them as the intended audience", and "MUST NOT accept or transit any other tokens".
  - Tokens go in `Authorization: Bearer` on every HTTP request, never in the query string.
  - Sources: [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization); [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [SPEC] Token passthrough: "If the MCP server makes requests to upstream APIs, it may act as an OAuth client to them. The access token used at the upstream API is a separate token… The MCP server MUST NOT pass through the token it received from the MCP client." — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [SPEC] Confused deputy: "MCP proxy servers using static client IDs MUST obtain user consent for each dynamically registered client before forwarding to third-party authorization servers." Also: "Authorization servers SHOULD issue short-lived access tokens… For public clients, authorization servers MUST rotate refresh tokens." — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [SPEC] Localhost HTTP: Streamable HTTP servers "MUST validate the `Origin` header… to prevent DNS rebinding attacks" and "When running locally, servers SHOULD bind only to localhost (127.0.0.1)". — [Streamable HTTP spec source](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)
- [SPEC/RFC] RFC 8693 Token Exchange:
  - Delegation is when "A still has its own identity separate from B". Impersonation is when A "is indistinguishable from B".
  - Request parameters: `subject_token` (required, the party on whose behalf), `actor_token` (optional, the acting party), `resource`, `audience`, `requested_token_type`.
  - The `act` claim (§4.1): "The outermost act claim represents the current actor while nested act claims represent prior actors". Prior actors are "informational only" for access control.
  - The `may_act` claim (§4.4) states who is authorized to become the actor.
  - Source: [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html)
- [CLAUDE] Claude Code, stdio: credentials are passed with `claude mcp add --env KEY=value --transport stdio …`, and `.mcp.json` supports `${VAR}` and `${VAR:-default}` expansion in `command`, `args` and `env`. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude Code, remote:
  - OAuth via `/mcp` or `claude mcp login <name>`; it supports DCR and auto-discovers CIMD.
  - A pre-registered client uses `--client-id`, `--client-secret` and `--callback-port`, with redirect `http://localhost:PORT/callback`. `oauth.scopes` pins scopes, and `authServerMetadataUrl` overrides discovery.
  - `headersHelper` runs a command that prints JSON headers. It runs "fresh on each connection" with a 10 s limit, and again after a 401 or 403 before one retry.
  - The v2 runtime rejects issuer mismatch and non-HTTPS token endpoints (except localhost).
  - Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude Desktop local extensions (MCPB): `manifest.json` `user_config` fields marked `"sensitive": true` are stored in OS secure storage (macOS Keychain, Windows Credential Manager). — [Anthropic Engineering: Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions); [Claude Help Center: local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [SPEC] Elicitation: servers "MUST NOT use form mode elicitation to request sensitive information such as passwords, API keys, access tokens" and "MUST use URL mode" for those. — [Elicitation spec source](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/client/elicitation.mdx)
- [CODE] Plan positions:
  - D4 says tokens are "audience-bound to this MCP server and never passed through to COM or other services".
  - D6 says to verify per call, adding "With stdio, identity is effectively per process/session".
  - §4 open questions include "which identity wins if the MCP subject differs from the app's signed-in user". LIC13 asks whether the rendering licence is tied to the subject or the app's user.
  - Source: `docs/plan.md` §4, §4a

### Inferences
These are my recommendations [REC].

**Where the plan already fits the spec.**
- D4 is the spec's audience-binding and anti-passthrough rule.
- D2 (callerType only from the verified token) is the right defence against a client claiming to be "app".
- D3 (entitlements ∩ actor scopes) maps naturally onto OAuth scopes (`model:read`, `view:write`, `model:write`).
- `forbidden` versus `unlicensed` (D5) maps to 403 insufficient_scope versus a tool-level error.

**Clash 1: where the token lives.**
- `ToolRequest.token` is a per-call parameter, but MCP `tools/call` carries only `name` and `arguments`.
- Do **not** add a `token` tool argument. The model would see it, it would land in transcripts and Claude Code's `tool-results` files, and an agent could forge or swap it.
- On stdio, the adapter supplies the token from process-level state and calls `handleToolCall({…, token: currentToken()})`. The per-call `verify` (D6) still works; it re-verifies a cached credential.
- Over Streamable HTTP, the token comes from the `Authorization` header of each request, which is a natural fit for per-call verify.

**Clash 2: where a stdio token comes from.** Options, from weakest to strongest:
- **(a) Static env var** (`CAD_MCP_TOKEN`) set via `claude mcp add --env` or `.mcp.json`. Simple, but long-lived secrets end up in config files, and there's no refresh. Fine for the prototype only.
- **(b) OS credential store.** The server reads a refresh token from the keychain or Credential Manager (or Claude Desktop MCPB `sensitive` config) and refreshes on its own.
- **(c) Local auth broker, preferred.** The desktop CAD app is already signed in, so it acts as the broker over a local named pipe or loopback channel. The server asks for a short-lived token audience-bound to the MCP server, and the app may ask the user to consent once per agent client.
  - This also answers the open question "MCP subject vs app's signed-in user": by construction they are the same.
  - That matters for named-user licensing (LIC13).
  - Caveat: the broker channel must authenticate the calling process, for example by checking the pipe client's signed binary or user SID. Any local process could otherwise ask for a token.
- **(d) Remote MCP over HTTP** with full OAuth (Claude Code `/mcp` login). This is the spec-conformant path, but COM is local-only, so it would need a local relay. That's out of scope (plan §1 excludes remote transport).

**How the server knows it's an agent.**
- Self-asserted signals are not trustworthy: MCP `clientInfo`, the parent process name, or "I was launched by Claude".
- Make the auth service mint the delegated token with RFC 8693 token exchange:
  - `subject_token` = the user's token (from the app session);
  - `actor_token` = a credential identifying the MCP server or agent client (e.g. a registered client id "cad-mcp-agent", or the harness's CIMD client id over HTTP);
  - `resource` = the MCP server's identifier.
- The resulting JWT carries `sub=user` and `act={sub:"claude-code"}` or similar. `AuthClient.verify` sets `callerType="agent"` when `act` is present and `actor = act.sub`. Nested `act` is informational only.
- The in-app (non-agent) path either calls with a token without `act`, or with `act` naming the app itself.
- Simplification: because this MCP server is only ever reached through agent harnesses, the broker could always mint `act` = MCP-server client id. The finer "which agent" (Claude Code vs Desktop) is then best-effort, from the client registration.

**D6 and token expiry.** With stdio the identity is per process, so per-call verify mainly adds latency and catches revocation. Cache the verification until `exp`, with a short TTL. That's the "revisit at M4" item.

**Telemetry.** Log `actor` and `callerType` from the token, never the raw token (T-rules, LIC8).

### Gaps
- I didn't verify whether the (hypothetical) remote auth service supports RFC 8693 or an `act` claim. This is already plan §10's identity-team question.
- I didn't verify Claude Desktop's current support for remote MCP OAuth (custom connectors): its CIMD/DCR behaviour, whether it uses the RFC 8707 `resource` parameter, and enterprise-managed restrictions. Only Claude Code's behaviour is sourced here.
- I didn't fetch the MCP "Security Best Practices" tutorial page itself, only the normative security-considerations page that points to it.
- I didn't fetch RFC 9728 itself; it's cited via the MCP spec.

## 3. Returning image data from capture_view

### Takeaway
MCP has a first-class `ImageContent` block (`{type:"image", data:<base64>, mimeType}`), and Claude Code shows such images inline to the model. Today's prototype would put base64 inside JSON text and check it against a 100 KB JSON byte cap. That is the wrong content type, and the cap would reject most real viewport PNGs. The fix:
- Return an image block, not JSON.
- Size the image at the source (COM helper side): downscale to the model's useful resolution, and use JPEG or WebP when appropriate.
- Apply a separate byte cap to images.
- Expose `maxDimension` and `format` parameters.
- Optionally offer a `resource_link` for full resolution.

### Cited Findings
- [SPEC] `ImageContent { type: "image"; data: string /* base64, @format byte */; mimeType: string; annotations?; _meta? }`. "Different providers may support different image types." — [schema.ts 2026-07-28](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)
- [SPEC] Tool results may mix `text`, `image`, `audio`, `resource_link` and embedded `resource` blocks. All of them support annotations (`audience`, `priority`). A `resource_link` returns "a URI that can be subscribed to or fetched by the client". Resource links "are not guaranteed to appear in the results of a `resources/list` request". — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [CLAUDE] "When an MCP tool returns a PNG, JPEG, GIF, or WebP image, Claude sees the image inline in the conversation. The inline copy may be scaled down or compressed to fit the model's image size limits. Claude Code also saves the original bytes to a file in the session's `tool-results` directory… and gives Claude the path" (requires v2.1.283+). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude Code output limits:
  - Warning when "MCP tool output exceeds 10,000 tokens". The default max is 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`).
  - `_meta["anthropic/maxResultSizeChars"]` raises the text threshold up to 500,000 chars, but "Tools that return image data are still subject to `MAX_MCP_OUTPUT_TOKENS`".
  - Text results over 50,000 chars are saved to a file.
  - HTTP and SSE responses over 16 MiB fail.
  - Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CLAUDE] Claude API vision limits:
  - Formats: JPEG, PNG, GIF, WebP.
  - Max 8000×8000 px. When a request has more than 20 images, keep each one ≤2000 px per side.
  - Max size per image is 10 MB base64 on the direct API and 5 MB on Bedrock and Google Cloud. The request limit is 32 MB.
  - Cost is `⌈w/28⌉×⌈h/28⌉` visual tokens.
  - Max native resolution: Claude 4.7 and later models are "High-resolution", with long edge 2576 px and at most 4784 visual tokens. Other models have long edge 1568 px and at most 1568 tokens.
  - Larger images are downscaled. For example, 1920×1080 becomes 1456×819 on the standard tier (1560 tokens) and is not resized on high-res (2691 tokens).
  - Lossy JPEG or WebP "can reduce latency… However, this can introduce artifacts… heavy JPEG compression can make text difficult to read."
  - In agentic loops "each request resends the full conversation history".
  - Source: [Claude Vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)
- [CODE] `capture_view` currently returns `{mimeType, base64}` as `data`. The pipeline measures `JSON.stringify(data)` against 100,000 bytes and the adapter would serialize it as text. `ToolDef` has no notion of result kind.

### Inferences
These are my recommendations [REC].

**Why the current shape fails.**
- Base64 inflates bytes by 4/3, so a 100,000-byte JSON cap admits roughly 75 KB of raw image.
- A 1920×1080 CAD viewport PNG (many edges and anti-aliasing) will commonly exceed that. That's an estimate; there's no measurement in the repo, and real sizes must be measured at M5.
- `result_too_large` would then make the WF-5 verification loop fail.
- Even if it fit, sending the image as JSON text means the model receives ~100k characters of base64 as **text tokens**. It doesn't see a picture, it wastes context, and it trips the 10k-token warning and the 25k-token or 50k-char file-spill rules.

**Design.**
1. Add `resultKind: "json" | "image"` (or a `toContent` hook) to `ToolDef`. `CAPTURE_VIEW.mapResult` returns `{bytes|base64, mimeType, width, height}`. The adapter emits `content: [{type:"image", data, mimeType}, {type:"text", text: "view-1 1456×819 JPEG, 210 KB, zoomedTo=3"}]`.
2. Apply a separate cap to images. Size it to the client limits, not the text-token heuristic: well under 5 MB base64 to be safe on Bedrock/Vertex-backed Claude, and in practice target a few hundred KB, because the image re-sends every turn.
3. Add input params: `maxDimension` (default ≈1568; allow up to 2576 for high-res models), `format` (`png` for line work and text legibility, `jpeg`/`webp` for shaded views), optional `quality`. Also consider capturing at the target size in COM, which is cheaper on the UI thread (P3), rather than capturing full-res and resizing in Node.
4. Resize at the source, in the COM helper or .NET side, or in Node with a dependency (needs approval). Plain Node has no built-in image resizer, so this is a real dependency decision.
5. Optionally offer full resolution: write the full-res capture to a temp file or an in-memory resource and return a `resource_link` (with an `audience`/`priority` annotation). The server must then implement `resources/read` with authorization and expiry. Claude Code already saves the inline image's original bytes to disk, so full-res via a resource link is rarely needed for Claude Code.
6. Telemetry: record `resultBytes`, width, height and format for the image KPI. Keep the 100 KB cap for JSON tools; its "≈25k tokens" rationale matches Claude Code's 25k default.
7. Fix the description. "PNG image of a view (WF-5)" should say what the image shows, its default size, and to call `zoom_to_elements` first.

### Gaps
- I didn't find documentation on exactly how Claude Code counts an image block against `MAX_MCP_OUTPUT_TOKENS` (base64 length vs visual tokens), or what it does when an image result exceeds the limit. The docs say only that images "are still subject to" it.
- I didn't verify Claude Desktop's handling of MCP image results: its inline rendering, size cap, and whether it supports `resource_link`.
- Typical PNG/JPEG byte sizes for this CAD app's captures are unknown until measured on the real app (M5).

## 4. Other friction points (process model, long calls, tool selection, write confirmation)

### Takeaway
The biggest structural friction is that **each Claude client spawns its own stdio server process**. Several Claude Code sessions plus Claude Desktop would mean several independent `ComSession` queues, rate limiters and licence leases all driving the **same** STA app. That silently breaks P9 ("one COM connection shared by all MCP sessions") and the fairness and idle-gating assumptions.

Elicitation now exists in the spec (form and URL modes, delivered via MRTR in 2026-07-28), and Claude Code supports it. That makes W3/D7 write confirmation implementable. Claude Code's `requiresUserInteraction` is a cheaper alternative.

### Cited Findings
- [CLAUDE] Claude Code config scopes: local (`~/.claude.json`), project (`.mcp.json`, shared via git, needs approval) and user. stdio servers are local processes launched per session; on shutdown Claude Code "closes the server's stdin, then ends the server's process tree" after 300 ms. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [CODE] P9 (plan §5): "One COM connection is shared by all MCP sessions _(proposed)_… STA serialises calls anyway". `ComSession` is an in-process object, so sharing works only within one process.
- [CLAUDE] Elicitation in Claude Code: "Form mode: Claude Code shows a dialog with form fields… URL mode: Claude Code asks whether to open a link in your browser." The v2 runtime "declares `elicitation: {form: {}, url: {}}`". An `Elicitation` hook can auto-respond. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- [SPEC] In 2026-07-28, a `tools/call` can return `resultType:"input_required"` with `inputRequests` (for example `elicitation/create` with a `requestedSchema`). The client retries the call with `inputResponses` and `requestState`, and the JSON-RPC `id` "MUST be different". — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools); [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [SPEC] Tools guidance: "there SHOULD always be a human in the loop with the ability to deny tool invocations", and clients "SHOULD… Prompt for user confirmation on sensitive operations". Servers MUST "Rate limit tool invocations". — [MCP Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
- [CLAUDE] Tool search defers tool definitions, so Claude finds tools by name and description. Descriptions are cut at 4,096 or 16,384 chars, so put "the words Claude would search for near the start". — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

### Inferences
These are my recommendations [REC].

**Process model.** Choose one of these explicitly.
- **(a) Single local daemon** that owns COM, with thin stdio shims per client forwarding over a named pipe. This keeps P9, fairness and seat accounting.
- **(b) One localhost Streamable HTTP server**, shared by all clients. This brings the HTTP authorization spec, plus the Origin-validation and bind-to-127.0.0.1 rules.
- **(c) An exclusive lock** (named mutex), so a second instance fails fast with `app_busy`.

The prototype implicitly assumes one process. Also: fakes can't reveal this, so the L5 soak test should run two server processes.

**Long calls.** MVP calls are bounded at 30 s, so Claude client timeouts are not hit. The future `render_view` (heavy) would exceed this. Options are progress notifications, or the tasks extension (`io.modelcontextprotocol/tasks`, moved out of core in 2026-07-28), or Claude Code's 2-minute auto-background. Cancellation must not free licence seats while COM is still rendering (LIC14).

**Write confirmation (W3/D7).** Options, in order of effort:
1. `_meta["anthropic/requiresUserInteraction"]` on `set_element_color`. Claude Code only, zero protocol work.
2. MRTR elicitation (form: "Paint 12 elements #FF0000? previous colours will be returned"). Portable, but it needs client support and a `requestState` design.
3. A `confirm: true` argument. The plan rejected this, and the model can just set it.

Don't use form elicitation for credentials; the spec forbids it.

**Tool selection quality.** The current descriptions are terse and reference internal IDs ("(WF-4)"), which mean nothing to a model. Rewrite them to say when to use each tool, what it returns, ID provenance, limits (`pageSize` ≤100, ≤100 ids), and the error-recovery hint (`not_found` means re-list IDs; `user_active` means wait `retryAfterMs`). Eight tools is a small, healthy count.

**Rate-limit identity.** Without a protocol session, key limits by `(subject, actor)` from the token, plus the process.

### Gaps
- I didn't verify whether Claude Desktop supports elicitation (form or URL) or the 2026-07-28 MRTR flow.
- I didn't verify Claude Desktop's behaviour on multiple windows (one server process per app, or per conversation).

## 5. GitHub: PR #2 merged while the windows-latest job was still running

### Takeaway
Nothing in GitHub stops a merge while checks are pending unless the branch has a **required status check**, configured in a branch protection rule or (preferably) a **ruleset**. Configure both `Typecheck + tests (ubuntu-latest)` and `Typecheck + tests (windows-latest)` as required. Better still, require a single aggregator job that `needs:` the matrix. Then use **auto-merge** ("Enable auto-merge") so a PR merges itself only once every required check passes. The later green `main` run shows the outcome was fine this time, but nothing enforced it.

### Cited Findings
- [GitHub] "Require status checks to pass before merging": required checks "must have a `successful`, `skipped`, or `neutral` status" before merging.
  - Strict mode ("Require branches to be up to date before merging") "is the default behavior for required status checks".
  - Job names should be unique across workflows, because duplicates cause ambiguous results.
  - Admins bypass branch protection by default unless "Do not allow bypassing the above settings" is enabled.
  - "Only a single branch protection rule can apply at a time… This restriction does not apply to rulesets", and existing rules can be converted to rulesets.
  - Source: [GitHub Docs: About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub] "A required status check must have completed successfully in the chosen repository during the past seven days" to be selectable. A job skipped by a conditional reports "Success". The fix for dependent jobs is `always()` with `needs`. Workflows skipped by path or branch filters leave checks "Pending" and block merging ("Waiting for status to be reported"). — [GitHub Docs: Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
- [GitHub] Auto-merge "must be enabled for the repository" first. The "Enable auto-merge" button appears only when a PR can't merge yet because required reviews or status checks are pending. It needs write permission, and it turns off if someone without write access pushes to the head branch. — [GitHub Docs: Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
- [CODE] The workflow's matrix job is named `Typecheck + tests (${{ matrix.os }})` with `fail-fast: false`, and `concurrency.cancel-in-progress: true` keyed on `github.ref`.
- [CODE/context] Per the caller's brief, PR #2 merged while windows-latest was pending, and the subsequent `main` run passed. I did not verify this myself: the local checkout isn't a git repo, and I didn't query GitHub.

### Inferences
These are my recommendations [REC].

**Setup steps.**
1. In Settings → Rules → Rulesets, add a branch ruleset targeting `main` (default branch).
2. Enable "Require a pull request before merging" and "Require status checks to pass".
3. Add the checks `Typecheck + tests (ubuntu-latest)` and `Typecheck + tests (windows-latest)`. This is the expanded matrix job name; confirm the exact strings in the PR checks UI. Each must have run in the last 7 days to be pickable.
4. Optionally enable "Require branches to be up to date", and "Block force pushes".
5. Keep the bypass list empty so admins can't bypass. Equivalent classic path: Settings → Branches → branch protection rule with "Require status checks to pass before merging" and "Do not allow bypassing the above settings".
6. In Settings → General → Pull Requests, tick "Allow auto-merge". Then on each PR use "Enable auto-merge", or `gh pr merge --auto --squash` (the CLI flag is from my knowledge, not verified in the fetched page).

**More robust variant.** Add an aggregator job `ci-ok: needs: [check], if: always()` that fails unless `needs.check.result == 'success'`, and require only `ci-ok`. Adding an OS to the matrix then doesn't need a settings change, and skipped or cancelled matrix legs can't count as success.

**Optional merge queue.** With "Require merge queue", GitHub re-runs required checks on the merged result. The workflow would need an `on: merge_group` trigger. That's from my knowledge, not fetched.

**How to frame it.** "Local hooks are bypassable (`--no-verify`); CI being green on `main` afterwards was luck, not policy. Branch protection plus auto-merge makes 'all matrix legs pass' a merge precondition rather than a convention, which matters here because Windows is the only OS the real COM adapter will run on."

### Gaps
- I didn't fetch GitHub Docs pages specifically on rulesets, merge queue or the `gh pr merge --auto` flag. Those details come from general knowledge and should be checked in the UI.
- I didn't verify the repository's actual current protection settings or the PR #2 timeline.
