# AI-assisted sessions: how this repo was built

This project was built on 2026-10-14 in two **Claude Code** sessions that ran in parallel and coordinated by sending each other messages. I (the candidate) gave the direction and made every decision recorded in [`docs/plan.md` §11](../plan.md#11-decision-log). The sessions proposed options, wrote the plan and code, verified the results and flagged what they couldn't decide.

| Session | Role | Record |
|---|---|---|
| `mcp-com-api-design` | Problem framing, design constraints, workflows, KPIs, licensing and load model; owned `docs/plan.md`, README, CLAUDE.md, CI and hooks; later executed the implementation plan | [01-mcp-com-api-design.md](01-mcp-com-api-design.md) |
| `mcp-com-prototype-validation` | Turned the design into a verified, task-by-task implementation plan and validation suite; reviewed the plan for validation gaps; published the PRs; made the final-decisions PR | [02-mcp-com-prototype-validation.md](02-mcp-com-prototype-validation.md) |

These records are **curated summaries**, not raw transcripts. They contain my prompts (lightly trimmed), what each session proposed, what I decided and what was verified. They leave out tool noise, local file paths and system prompts.

## Timeline (UTC, approximate)

| Time | Event |
|---|---|
| 16:57 | Design session: I shared the problem diagram (MCP for a desktop app with a COM API, mirroring a Python-API MCP) and asked for help scoping it |
| 17:01–17:17 | Design session: remote auth, a 10-call prototype, Python-vs-COM differences, session/error/telemetry constraints, delegated auth, "workflows → KPIs → design" ordering. First `docs/plan.md` drafted |
| ~17:45 | Validation session started: "keep capturing information for the goal and create a plan to build a working prototype with the validation suite" |
| 17:48–17:58 | Design session: MVP workflows WF-1…WF-5 agreed; licensing tiers; load/UI priority; rendering activation methods; user-activity gating. Each update was pushed to the validation session |
| ~17:58 | Validation session: implementation plan written, with every code block verified in a scratch copy (63/63 tests, 18/18 gates); 7 validation gaps sent back to the design session |
| ~18:01 | Validation session: design-stage snapshot published as PR #1 (CI green on Ubuntu and Windows); I merged it |
| 18:00–18:04 | Design session: executed the implementation plan in the repo and reproduced 63/63 and 18/18; found one task-ordering bug in the plan (fixed) |
| ~18:06 | Validation session: implementation published as PR #2; I merged it; CI on `main` green, including the first Windows `validate` run |
| ~18:15 | Validation session: asked me the remaining open questions; the final PR implements and records the answers (71/71 tests, 18/18 gates) and adds this record |

## How the two sessions coordinated

- **One owner per file.** The design session owned `docs/plan.md`, README, CLAUDE.md, `package.json`, CI and hooks. The validation session owned the implementation plan and, until execution, the scratch prototype. Before touching a shared file, each one announced it and waited ("don't edit X until I report it's pushed").
- **Corrections went to the owner.** The validation session sent validation gaps to the design session instead of editing its plan. The design session applied four of them and recorded the rest as decisions for me (W6, LIC14, E1 codes).
- **Results were reproduced before they were repeated.** The 63/63 and 18/18 numbers first came from a scratch copy. The design session kept them out of the README until it had reproduced them in the repo, and the validation session independently re-ran them after execution.

## Honesty notes

- Every KPI number in the plan is a **provisional target**. All validation results come from **in-memory fakes** and say nothing about real COM performance (§3.2, decision log).
- There is no real COM adapter and no MCP transport yet (M4 and M5).
- **No independent agent reviewed the code.** Both sessions reviewed their own work. The mutation checks (deliberately breaking code to confirm the tests fail) are recorded in the session files.
- The repo has no real CAD app. COM method names, the not-found HRESULT and the licence feature IDs are placeholders until the architects and the licensing team confirm them.
