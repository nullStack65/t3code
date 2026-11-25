import { assert, describe, it } from "@effect/vitest";

import {
  SECRET_REDACTED,
  containsSecret,
  redactSecretText,
  redactSecretsDeep,
} from "./secretRedaction.ts";

describe("secretRedaction (CLO-1099)", () => {
  it("redacts token values and inline key=value secrets without double-counting", () => {
    const fakeGh = `ghp_${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`;
    const fakeOpenAi = `sk-${"X9y8Z7w6V5u4T3s2R1q0".repeat(2)}`;
    const result = redactSecretText(
      `token=${fakeGh} api=${fakeOpenAi} password=hunter2 client_secret: super_secret_123`,
    );
    assert.equal(result.redactedCount, 4);
    assert.notInclude(result.text, fakeGh);
    assert.notInclude(result.text, fakeOpenAi);
    assert.notInclude(result.text, "hunter2");
    assert.notInclude(result.text, "super_secret_123");
    assert.include(result.text, SECRET_REDACTED);
  });

  it("detects secrets via containsSecret and ignores clean text", () => {
    assert.isFalse(containsSecret("Inspect PR #42 and run unit tests."));
    assert.isTrue(containsSecret("Use sk-proj-1234567890abcdef1234567890 to call the API"));
    assert.isTrue(containsSecret("password=hunter2"));
  });

  it("deep-redacts nested provider tool inputs and credential-named fields", () => {
    const fakeGh = `ghp_${"B2c3D4e5F6g7H8i9J0k1".repeat(2)}`;
    const payload = {
      type: "tool_use",
      name: "Bash",
      input: {
        command: `curl -H "Authorization: Bearer ${fakeGh}" https://api.example.test`,
        api_key: "plain-inline-value",
        safe: "git status",
      },
    };
    const sanitized = redactSecretsDeep(payload) as typeof payload;
    assert.equal(sanitized.input.safe, "git status");
    assert.equal(sanitized.input.api_key, SECRET_REDACTED);
    assert.notInclude(sanitized.input.command, fakeGh);
    assert.include(sanitized.input.command, SECRET_REDACTED);
  });
});
