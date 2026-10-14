// Declarative tool table (plan.md §2 tool catalogue). Adding a COM call = adding one entry here.
import type { CallResult } from "./comSession.ts";
import { ToolError } from "./errors.ts";

/** plan.md P10: view/model/heavy are "modifiers". `heavy` (render) is not in the MVP catalogue. */
export type Effect = "read" | "view" | "model" | "heavy";

export interface ToolDef {
  name: string;
  description: string;
  effect: Effect;
  retrySafe: boolean; // reads and idempotent writes only (E4, W1)
  scope: string; // required actor scope (D3)
  licenseFeatures: string[]; // licence layers beyond "base", checked in order (L2); [] for all MVP tools
  comMethod: string; // PLACEHOLDER names until the architects confirm the real COM API
  /** Validates the input and maps it to COM arguments. Throws ToolError("invalid_input"). */
  toArgs(input: unknown): unknown[];
  /** Shapes the agent-facing result from the raw COM value; defaults to the value itself. */
  mapResult?(value: unknown, call: CallResult): unknown;
  /** Element count for write telemetry (W5); never element contents. */
  elementCount?(args: unknown[]): number;
  /** A valid sample input; the contract tests run every tool with it. */
  example: unknown;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100; // (proposed)
export const MAX_IDS_PER_CALL = 100; // (proposed)
export const MAX_RESULT_BYTES = 100_000; // (proposed) ≈25k tokens at ~4 bytes/token, plan.md §3.2

export const SCOPES = { read: "model:read", view: "view:write", write: "model:write" } as const;

function invalid(message: string): ToolError {
  return new ToolError("invalid_input", message);
}

/** Missing input counts as {} so tools without parameters accept an empty call. */
function asObject(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("Input must be an object.");
  return input as Record<string, unknown>;
}

export function requireString(input: unknown, key: string): string {
  const value = asObject(input)[key];
  if (typeof value !== "string" || value.trim() === "") throw invalid(`"${key}" must be a non-empty string.`);
  return value;
}

export function optionalString(input: unknown, key: string): string | null {
  const value = asObject(input)[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") throw invalid(`"${key}" must be a non-empty string if given.`);
  return value;
}

/** Writes act only on explicit IDs, never on an implicit selection (W2). */
export function requireIds(input: unknown, key: string): string[] {
  const value = asObject(input)[key];
  if (!Array.isArray(value) || value.length === 0) throw invalid(`"${key}" must be a non-empty array of element IDs.`);
  if (value.length > MAX_IDS_PER_CALL) throw invalid(`"${key}" can hold at most ${MAX_IDS_PER_CALL} IDs per call.`);
  if (!value.every((id) => typeof id === "string" && id.trim() !== "")) {
    throw invalid(`"${key}" must contain only non-empty strings.`);
  }
  return value as string[];
}

export function pageArgs(input: unknown): [pageSize: number, cursor: string | null] {
  const obj = asObject(input);
  const pageSize = obj.pageSize ?? DEFAULT_PAGE_SIZE;
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalid(`"pageSize" must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return [pageSize, optionalString(input, "cursor")];
}

/** (open) Colour model: index vs RGB. The prototype assumes "#RRGGBB". */
export function requireColor(input: unknown, key: string): string {
  const value = requireString(input, key);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw invalid(`"${key}" must be a colour like "#FF0000".`);
  return value.toUpperCase();
}

export function createRegistry(defs: ToolDef[]): Map<string, ToolDef> {
  const registry = new Map<string, ToolDef>();
  for (const def of defs) {
    if (registry.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    registry.set(def.name, def);
  }
  return registry;
}

const read = { effect: "read", retrySafe: true, scope: SCOPES.read, licenseFeatures: [] as string[] } as const;

export const GET_APP_INFO: ToolDef = {
  ...read,
  name: "get_app_info",
  description: "Product name and version of the running CAD app (WF-1).",
  comMethod: "App.GetInfo",
  toArgs: (input) => (asObject(input), []),
  example: {},
};

export const QUERY_ELEMENTS: ToolDef = {
  ...read,
  name: "query_elements",
  description: "Find elements by type, level and/or layer, one page at a time (WF-4).",
  comMethod: "Model.QueryElements",
  toArgs: (input) => {
    const filter = {
      type: optionalString(input, "type"),
      level: optionalString(input, "level"),
      layer: optionalString(input, "layer"),
    };
    return [filter, ...pageArgs(input)];
  },
  example: { type: "column", level: "L2", pageSize: 20 },
};

export const GET_ACTIVE_VIEW: ToolDef = {
  ...read,
  name: "get_active_view",
  description: "Stable ID of the active view (WF-2, WF-5).",
  comMethod: "View.GetActive",
  toArgs: (input) => (asObject(input), []),
  example: {},
};

export const LIST_ELEMENTS_IN_VIEW: ToolDef = {
  ...read,
  name: "list_elements_in_view",
  description: "Elements visible in a view, one page at a time (WF-2).",
  comMethod: "View.ListElements",
  toArgs: (input) => [requireString(input, "viewId"), ...pageArgs(input)],
  example: { viewId: "view-1", pageSize: 20 },
};

export const GET_ELEMENT_PROPERTIES: ToolDef = {
  ...read,
  name: "get_element_properties",
  description: "Properties of elements by stable ID (WF-2, WF-4).",
  comMethod: "Element.GetProperties",
  toArgs: (input) => [requireIds(input, "ids")],
  example: { ids: ["box-1"] },
};

export const SET_ELEMENT_COLOR: ToolDef = {
  name: "set_element_color",
  description: "Set (not toggle) the colour of elements by explicit ID. Returns each previous colour (WF-3).",
  effect: "model",
  retrySafe: true, // absolute set → idempotent (W1)
  scope: SCOPES.write,
  licenseFeatures: [],
  comMethod: "Element.SetColor",
  toArgs: (input) => [requireIds(input, "ids"), requireColor(input, "color")],
  elementCount: (args) => (args[0] as string[]).length,
  // W6: after a retry that followed a lost session, an earlier attempt may already have applied
  // the colour, so the reported previous colours may be the new ones. Busy rejections never ran.
  mapResult: (value, call) => ({ ...(value as object), previousReliable: !call.reconnected }),
  example: { ids: ["box-1"], color: "#FF0000" },
};

export const ZOOM_TO_ELEMENTS: ToolDef = {
  name: "zoom_to_elements",
  description: "Fit the view to the given elements. Changes the view only (WF-5).",
  effect: "view",
  retrySafe: true,
  scope: SCOPES.view,
  licenseFeatures: [],
  comMethod: "View.ZoomTo",
  toArgs: (input) => [requireString(input, "viewId"), requireIds(input, "ids")],
  example: { viewId: "view-1", ids: ["box-1"] },
};

export const CAPTURE_VIEW: ToolDef = {
  ...read,
  name: "capture_view",
  description: "PNG image of a view (WF-5).",
  comMethod: "View.Capture",
  toArgs: (input) => [requireString(input, "viewId")],
  example: { viewId: "view-1" },
};

/** Milestone 1 slice. */
export const M1_TOOLS: ToolDef[] = [GET_APP_INFO, QUERY_ELEMENTS];

export const ALL_TOOLS: ToolDef[] = [
  GET_APP_INFO,
  GET_ACTIVE_VIEW,
  LIST_ELEMENTS_IN_VIEW,
  QUERY_ELEMENTS,
  GET_ELEMENT_PROPERTIES,
  SET_ELEMENT_COLOR,
  ZOOM_TO_ELEMENTS,
  CAPTURE_VIEW,
];
