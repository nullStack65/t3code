import { describe, expect, it } from "vite-plus/test";

import { decodeOmpSkillCommands } from "./OmpSkills.ts";

const frame = (commands: ReadonlyArray<unknown>) =>
  // @effect-diagnostics-next-line preferSchemaOverJson:off - building a raw RPC frame.
  JSON.stringify({ type: "available_commands_update", commands });

describe("decodeOmpSkillCommands", () => {
  it("keeps only skill commands, sorted by name", () => {
    const stdout = [
      // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
      JSON.stringify({ type: "ready", protocolVersion: 1 }),
      frame([
        { name: "tdd", description: "Not a skill command." },
        { name: "skill:tdd", description: "Test-driven development." },
        { name: "skill:code-review", description: "Review changes." },
        { name: "skillful", description: "Toggle skill listing." },
      ]),
      "",
    ].join("\n");

    expect(decodeOmpSkillCommands(stdout)).toEqual([
      {
        name: "code-review",
        description: "Review changes.",
        path: "skill://code-review/SKILL.md",
        enabled: true,
      },
      {
        name: "tdd",
        description: "Test-driven development.",
        path: "skill://tdd/SKILL.md",
        enabled: true,
      },
    ]);
  });

  it("reads the response payload of an explicit command request", () => {
    const stdout =
      // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
      JSON.stringify({
        type: "response",
        command: "get_available_commands",
        success: true,
        data: { commands: [{ name: "skill:deploy" }] },
      });

    expect(decodeOmpSkillCommands(stdout)).toEqual([
      { name: "deploy", path: "skill://deploy/SKILL.md", enabled: true },
    ]);
  });

  it("skips malformed lines, nameless entries and blank descriptions", () => {
    const stdout = [
      "not json",
      "null",
      frame([
        { name: "skill:" },
        { name: "skill:  " },
        "not-an-object",
        { name: "skill:keep", description: "   " },
      ]),
    ].join("\n");

    expect(decodeOmpSkillCommands(stdout)).toEqual([
      { name: "keep", path: "skill://keep/SKILL.md", enabled: true },
    ]);
  });

  it("keeps the last frame's entry when a skill is announced twice", () => {
    const stdout = [
      frame([{ name: "skill:tdd", description: "First." }]),
      frame([{ name: "skill:tdd", description: "Updated." }]),
    ].join("\n");

    expect(decodeOmpSkillCommands(stdout)).toEqual([
      { name: "tdd", description: "Updated.", path: "skill://tdd/SKILL.md", enabled: true },
    ]);
  });

  it("returns nothing when the output carries no command frame", () => {
    // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
    expect(decodeOmpSkillCommands(JSON.stringify({ type: "ready" }))).toEqual([]);
  });
});
