# Collaborative coding mode: COM-backed MCP prototype

A small TypeScript/Node.js project: an MCP server for a desktop CAD application that is only scriptable through a COM API. It mirrors an existing Python-API MCP integration's auth, licensing, telemetry and error patterns. This is a take-home exercise and will be read by interviewers.

## Role boundaries
- The candidate owns all requirements, decisions, coding choices, and final explanations.
- Help me reason about alternatives. Never silently decide unclear domain rules: record them as _(open)_ or _(proposed)_ in `docs/plan.md`.
- When I paste an ambiguous problem, propose at most 3 important clarifying questions, assumptions, and a minimal acceptance test. Then wait for me to choose the scope.
- When I request implementation, make the smallest working change. No architecture astronautics, frameworks, or dependencies unless I explicitly request them.
- Explain non-obvious decisions in plain English; keep code straightforward and readable.
- Highlight assumptions, trade-offs, edge cases, ordering, idempotency, errors, and complexity where relevant.
- Do not invent benchmark results, run outcomes, tool outputs, or external requirements. KPI numbers in the plan are placeholders until measured.
- Run relevant tests and typecheck after code changes and report the actual results, including failures.
- Ask before destructive operations, deleting files, or adding packages (including `@modelcontextprotocol/sdk` at Milestone 4).
- Do not read files outside this project or send secrets / third-party code to external tools.

## Source of truth
- `docs/plan.md` holds the design, constraints, KPIs, test plan, milestones and open questions. Read it before designing or implementing.
- Constraints have stable IDs: S (session/threading), P (load/priority), E (errors), D (delegation), LIC (licensing), W (writes), T (telemetry). Validation layers are L1–L5. Reference these IDs in code comments, tests and commit messages where a constraint drives the behaviour.
- When a decision changes, update `docs/plan.md` in the same change and keep `README.md`'s summary consistent.

## Design invariants (do not break without an explicit decision)
- Tools never touch COM directly; all calls go through the single COM session (S1) and the scheduler.
- One COM call in flight at a time; every call has a deadline (S2, S4).
- `callerType` / actor come only from the verified delegated token, never from client input (D2).
- All auth and licence checks happen before a call is queued for COM (LIC3).
- Modifiers (view/model/heavy effects) never start while the desktop user is active (P11).
- Raw COM errors / HRESULT text never reach the agent; exactly one telemetry event per tool call (E6, T1).
- Licence secrets (serials, passwords, server credentials) never appear in tool I/O, logs or telemetry (LIC8).
- Only retry-safe (idempotent) calls are retried automatically (E3, E4, W1).
- Real COM, auth and licence services sit behind interfaces with fakes; tests must run on any OS.

## Stack
- TypeScript with strict types, Node.js ≥ 22, ESM.
- Built-in `node:test` and `node:assert/strict`; tests live in `test/*.test.ts`.
- `npm run start`, `npm test`, `npm run typecheck`, `npm run check`, `npm run validate` (once `src/validation/cli.ts` lands).
- `src/solution.ts` is the starter scaffold; replace it as Milestone 1 lands.

## Quality gates
- Local: `npm run hooks:install` once per clone. pre-commit runs typecheck; pre-push runs `npm run check`.
- CI (`.github/workflows/ci.yml`): `npm ci && npm run check` on Ubuntu and Windows, plus `npm run validate` once the runner exists.
- Don't bypass hooks (`--no-verify`) unless I explicitly ask.
- Prefer injectable clocks over real timers in session/deadline/duty-cycle tests to avoid CI flakiness.

## Rhythm
1. Confirm problem and success criteria in conversation.
2. Propose minimal interfaces and 2-3 test cases, tied to plan IDs.
3. Implement the smallest vertical slice after my go-ahead.
4. Run tests, examine failure modes, and refine.
5. Summarize limitations and what evidence would justify scaling or redesigning; update `docs/plan.md`.
