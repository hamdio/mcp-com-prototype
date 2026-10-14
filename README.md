# COM-backed MCP: design & prototype

A take-home exercise: introduce an **MCP (Model Context Protocol) server** for a desktop **CAD application** whose capabilities are only available through a **COM API**. It must behave like an existing MCP integration that sits on top of a Python API, using the same authentication, licensing, telemetry and error patterns, so agents and users get a consistent experience.

> **Status: design stage.** The design, constraints, validation suite and plan are complete in [`docs/plan.md`](docs/plan.md). A task-by-task implementation plan for M1–M3 plus the validation runner is in [`docs/superpowers/plans/2026-10-14-com-mcp-prototype.md`](docs/superpowers/plans/2026-10-14-com-mcp-prototype.md), but it has **not been executed yet**. The TypeScript code in `src/` is still the starter scaffold. CI and local gates are already wired, so every milestone lands behind them.

## The problem

```
                 Agent / Human
                /             \
   Desktop App 1               Desktop App 2 (CAD)
   ┌──────────────────┐        ┌──────────────────┐
   │ Python API ← MCP │        │ COM API ← MCP ★  │   ★ = this project
   └──────────────────┘        └──────────────────┘
          │                            │
   Remote API: auth, licensing,  Remote API: auth, licensing,
   telemetry                     telemetry
```

Goal: implement the first useful MCP slice over the COM API. Ask questions, narrow scope, identify what's needed from product owners and architects, then produce contracts, a plan, wrappers, tests, telemetry, deployment and rollout.

## How I approached it

1. **Workflows → KPIs → design.** Agree on what agents should achieve, then on how success is measured, and only then shape the components. The tool list is derived from the workflows, not the other way round.
2. **Capture COM-specific constraints explicitly.** COM differs fundamentally from the Python API: single-threaded UI apartment, reference-counted lifetimes, HRESULT errors, stateful object graphs and shared use with a live human user.
3. **Everything is testable without Windows.** The pipeline depends on interfaces (`ComClient`, `AuthClient`, `LicenseProvider`, `Telemetry`, `UserActivityMonitor`). Fakes drive contract and fault-injection tests on any OS. The real COM adapter is a thin Windows-only layer added last.

## Design at a glance

**MVP workflows** ([§2](docs/plan.md)):

| ID | Workflow | Effect |
|---|---|---|
| WF-1 | Get the app version (also the session handshake / version gate) | read |
| WF-2 | Get the viewport and its objects (source of stable element IDs) | read |
| WF-3 | Paint an element red (idempotent absolute set, explicit IDs only) | **model write** |
| WF-4 | Find and inspect elements by type / level / layer | read |
| WF-5 | Zoom to elements and capture the view (visual verification) | view change |

**Request pipeline** ([§6](docs/plan.md)):

```
validate → delegated auth (user + acting agent/app) → per-session rate limit → scope check
  → base licence → feature licences (e.g. rendering) → priority scheduler
  → user-idle gate for modifiers → single COM session (retry / reconnect / deadline)
  → error mapping → exactly one telemetry event
```

**Key decisions:**

| Area | Decision | Plan ref |
|---|---|---|
| Threading | One shared COM session; one call in flight; bounded queue; per-call deadline | S1–S4, P9 |
| Errors | Stable taxonomy; HRESULTs classified as transient / session-lost / permanent; retry only transient + idempotent; raw COM errors never reach the agent | E1–E7 |
| Identity | Delegated tokens: subject (user) + actor (agent or app); `callerType` comes only from the verified token; permissions = user entitlements ∩ actor scopes | D1–D8 |
| Licensing | Base licence for every tool; feature licences (e.g. rendering) via pluggable providers: serial, local licence server seat, named user. Secrets never pass through MCP | LIC1–LIC13 |
| Human priority | Modifiers (zoom, set colour, render) only start when the user is idle; reads are throttled by a UI-time budget; per-MCP-session rate limits and round-robin fairness | P1–P14 |
| Telemetry | One `tool_call` event per call, plus session, rate-limit and licence events; enough to compute every KPI | T1–T6 |

**Validation** ([§3](docs/plan.md)): hard gates that block a release (e.g. 0 unauthorized calls reach COM, 0 modifiers started while the user is active, 0 licence secrets in telemetry). Proposed performance KPIs are placeholders until baselined against the real app. Five validation layers: L1 contract → L2 fault injection → L3 Windows integration → L4 agent workflow evals → L5 soak / load with scripted UI activity.

**Open questions** for product, architecture, licensing and the Python MCP team are listed in [§10](docs/plan.md).

## Repository layout

```
docs/plan.md              Design, constraints, KPIs, test plan, milestones (source of truth)
docs/superpowers/plans/   Task-by-task implementation plan (M1–M3 + validation runner; not yet executed)
src/                      Implementation (starter scaffold until Milestone 1)
test/                     node:test suites
.github/workflows/ci.yml  CI: typecheck + tests on Ubuntu and Windows
.githooks/                Local gates: pre-commit (typecheck), pre-push (full check)
CLAUDE.md                 Working agreement for AI-assisted development in this repo
```

## Running it

Requires Node.js ≥ 22. No other dependencies beyond the dev toolchain (`typescript`, `tsx`, `@types/node`).

```bash
npm install
npm run hooks:install   # once per clone: enables the local git hooks
npm run check           # typecheck + tests (the same gate CI runs)
npm test
npm run start
```

## Quality gates

| Gate | Runs | Command |
|---|---|---|
| pre-commit hook | Every local commit | `npm run typecheck` |
| pre-push hook | Every local push | `npm run check` |
| CI (GitHub Actions) | Every push to `main` and every PR; Ubuntu + Windows | `npm ci && npm run check` |
| CI validation gates | Same, once `src/validation/cli.ts` exists (Milestone 1) | `npm run validate`: runs the MVP workflows on fakes with seeded fault injection; fails on any §3.1 hard gate |

Notes:
- Hooks can be bypassed with `--no-verify` in an emergency; CI cannot.
- Validation layers L3–L5 need the real CAD application, so they are planned for a self-hosted Windows runner and are not part of CI yet.
- Known risk: session and deadline tests will use short real-time windows, which can flake on slow Windows runners. The planned fix is an injectable clock, which the UI duty-cycle tests need anyway.

## Milestones

| # | Scope | Status |
|---|---|---|
| M0 | Workflows, KPIs, delegation model | Workflows agreed; KPIs and delegation awaiting sign-off |
| M1 | Pipeline, error taxonomy, delegation, telemetry on fakes (`get_app_info`, `query_elements`) | Next: implementation plan written ([Tasks 1–4](docs/superpowers/plans/2026-10-14-com-mcp-prototype.md)), awaiting approval |
| M2 / 2b | COM session (queue, deadline, retry, reconnect); tiered licensing; rate limits; fair scheduler; user-idle gating | Planned |
| M3 | Remaining read/view tools, then the WF-3 write | Planned |
| M4 | MCP stdio transport (adds `@modelcontextprotocol/sdk`) | Planned |
| M5 | Real `ComClient` on Windows; L3 integration; baseline KPIs | Planned |
| M6 | L4 agent workflow evals; L5 soak/load against the KPI gates | Planned |

## AI-assisted workflow

This project was developed collaboratively with Claude Code under the working agreement in [`CLAUDE.md`](CLAUDE.md). I own requirements and decisions. The assistant proposes options, flags assumptions and must not invent results. Anything marked _(proposed)_ or _(open)_ in the plan is explicitly not yet decided.
