// Public entry point for the COM-backed MCP prototype. See docs/plan.md.
export { handleToolCall, type PipelineDeps, type ToolRequest, type ToolResult } from "./pipeline.ts";
export { ComSession, DEFAULT_SESSION_CONFIG, type ComClient, type SessionConfig } from "./comSession.ts";
export { ALL_TOOLS, createRegistry, M1_TOOLS, type ToolDef } from "./tools.ts";
export { BASE_LICENSE, type LicenseClient, type LicenseLease } from "./license.ts";

export { computeKpis, DEFAULT_LIMITS } from "./kpi.ts";
