import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityMcpPermissionDisposition } from "./AntigravityMcpPermission.ts";

describe("Antigravity MCP permissions", () => {
  const permission = (
    title: string,
    rawInput?: Record<string, unknown>,
  ): EffectAcpSchema.RequestPermissionRequest => ({
    sessionId: "session-1",
    toolCall: { toolCallId: "call-1", title, kind: "execute", rawInput },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  });
  const qualified = [
    permission("Run mcp_t3-code_t3_thread_list?"),
    permission("MCP Tool delegate_task", { ServerName: "t3-code", ToolName: "delegate_task" }),
  ];

  it.each(["auto", "auto-accept-edits"] as const)(
    "allows T3 MCP in %s while preserving explicit approval and sandbox decisions",
    (runtimeMode) => {
      const policy = { runtimeMode, cwd: "/workspace" };
      for (const request of qualified) {
        expect(antigravityMcpPermissionDisposition(policy, request)).toBe("allow");
        expect(
          antigravityMcpPermissionDisposition({ ...policy, approvalPolicy: "on-request" }, request),
        ).toBe("ask");
        expect(
          antigravityMcpPermissionDisposition(
            { ...policy, sandboxPolicy: { type: "readOnly" } },
            request,
          ),
        ).toBe("deny");
      }
    },
  );

  it("keeps unqualified or ambiguous commands subject to the ACP policy", () => {
    const policy = { runtimeMode: "auto-accept-edits", cwd: "/workspace" } as const;
    for (const request of [
      permission("Running preview_status"),
      permission("Run mcp_github_create_issue"),
      permission("Run mcp_t3-code_nonexistent_tool"),
      permission("Run mcp_t3-code_preview_status", {
        ServerName: "other",
        ToolName: "preview_status",
      }),
      permission("Run mcp_t3-code_preview_status", {
        ServerName: "t3-code",
        ToolName: "preview_status",
        CommandLine: "Run mcp_t3-code_preview_status",
      }),
    ]) {
      expect(antigravityMcpPermissionDisposition(policy, request)).toBe("ask");
    }
    expect(
      antigravityMcpPermissionDisposition(
        { ...policy, runtimeMode: "approval-required" },
        qualified[0]!,
      ),
    ).toBe("ask");
  });
});
