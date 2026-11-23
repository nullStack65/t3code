import {
  acpPermissionDisposition,
  unknownRecord,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import type * as EffectAcpSchema from "effect-acp/compat";

// Before agy 1.5.8, "Running <tool>" omits the server and can name a different MCP's tool.
const ANTIGRAVITY_T3_MCP_TITLE = /^Run mcp_t3-code_(?<tool>[A-Za-z0-9_]+)\??$/u;

function isAntigravityT3McpRequest(request: EffectAcpSchema.RequestPermissionRequest): boolean {
  const rawInput = unknownRecord(request.toolCall.rawInput);
  if (typeof rawInput?.CommandLine === "string") return false;
  if (rawInput?.ServerName !== undefined) {
    return (
      rawInput.ServerName === "t3-code" &&
      typeof rawInput.ToolName === "string" &&
      T3_MCP_TOOL_NAMES.has(rawInput.ToolName)
    );
  }
  const tool = ANTIGRAVITY_T3_MCP_TITLE.exec(request.toolCall.title?.trim() ?? "")?.groups?.tool;
  return tool !== undefined && T3_MCP_TOOL_NAMES.has(tool);
}

export function antigravityMcpPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
  disposition = acpPermissionDisposition(policy, request),
) {
  if (
    disposition === "ask" &&
    (policy.runtimeMode === "auto" || policy.runtimeMode === "auto-accept-edits") &&
    (policy.approvalPolicy === undefined || policy.approvalPolicy === "never") &&
    isAntigravityT3McpRequest(request)
  ) {
    return "allow";
  }
  return disposition;
}
