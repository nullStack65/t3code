import { describe, expect, it } from "vite-plus/test";

import { AuthMcpClientAccess, MCP_PAIRING_SCOPES, mcpClientScopes } from "./auth.ts";

describe("MCP pairing scopes", () => {
  it("grants a linked environment the scopes it needs to drive this one", () => {
    expect(mcpClientScopes("read-only")).toEqual(["orchestration:read"]);
    expect(mcpClientScopes("auto")).toEqual(["orchestration:read", "orchestration:operate"]);
    expect(mcpClientScopes("approval-required")).toEqual(mcpClientScopes("auto"));
    expect(mcpClientScopes("auto-accept-edits")).toEqual(mcpClientScopes("auto"));
    expect(mcpClientScopes("full-access")).toEqual([...MCP_PAIRING_SCOPES]);
    for (const access of AuthMcpClientAccess.literals) {
      for (const scope of mcpClientScopes(access)) {
        expect(MCP_PAIRING_SCOPES).toContain(scope);
      }
    }
  });
});
