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
