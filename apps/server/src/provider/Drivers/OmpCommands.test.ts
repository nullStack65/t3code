import { describe, expect, it } from "vite-plus/test";

import { catalogFromCommandEntries, decodeOmpCommandCatalog } from "./OmpCommands.ts";

const frame = (commands: ReadonlyArray<unknown>) =>
  // @effect-diagnostics-next-line preferSchemaOverJson:off - building a raw RPC frame.
  JSON.stringify({ type: "available_commands_update", commands });

describe("decodeOmpCommandCatalog", () => {
  it("splits skills from slash commands, each sorted by name", () => {
    const stdout = [
      // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
      JSON.stringify({ type: "ready", protocolVersion: 1 }),
      frame([
        { name: "skill:tdd", description: "Test-driven development." },
        { name: "skill:code-review", description: "Review changes." },
        { name: "model", aliases: ["models"], description: "Show current model selection." },
        { name: "compact", description: "Compact the conversation." },
        { name: "skillful", description: "Toggle skill listing." },
      ]),
      "",
    ].join("\n");

    const catalog = decodeOmpCommandCatalog(stdout);

    expect(catalog.skills).toEqual([
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
    expect(catalog.slashCommands).toEqual([
      { name: "compact", description: "Compact the conversation." },
      { name: "model", description: "Show current model selection." },
      { name: "skillful", description: "Toggle skill listing." },
    ]);
  });

  it("keeps a command's argument hint and folds subcommands into the parent", () => {
    const stdout = frame([
      {
        name: "security",
        description: "Run security scans",
        input: { hint: "<plan|scan|status>" },
        subcommands: [
          { name: "plan", description: "Create a plan" },
          { name: "scan", description: "Start a scan" },
        ],
      },
    ]);

    expect(decodeOmpCommandCatalog(stdout).slashCommands).toEqual([
      {
        name: "security",
        description: "Run security scans",
        input: { hint: "<plan|scan|status>" },
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
        data: { commands: [{ name: "skill:deploy" }, { name: "share" }] },
      });

    const catalog = decodeOmpCommandCatalog(stdout);
    expect(catalog.skills).toEqual([
      { name: "deploy", path: "skill://deploy/SKILL.md", enabled: true },
    ]);
    expect(catalog.slashCommands).toEqual([{ name: "share" }]);
  });

  it("skips malformed lines, nameless entries and blank descriptions", () => {
    const stdout = [
      "not json",
      "null",
      frame([
        { name: "skill:" },
        { name: "skill:  " },
        { name: "   " },
        "not-an-object",
        { name: "skill:keep", description: "   " },
        { name: "todo", input: { hint: "   " } },
      ]),
    ].join("\n");

    const catalog = decodeOmpCommandCatalog(stdout);
    expect(catalog.skills).toEqual([
      { name: "keep", path: "skill://keep/SKILL.md", enabled: true },
    ]);
    expect(catalog.slashCommands).toEqual([{ name: "todo" }]);
  });

  it("keeps the last frame's entry when a command is announced twice", () => {
    const stdout = [
      frame([
        { name: "skill:tdd", description: "First." },
        { name: "model", description: "First." },
      ]),
      frame([
        { name: "skill:tdd", description: "Updated." },
        { name: "model", description: "Updated." },
      ]),
    ].join("\n");

    const catalog = decodeOmpCommandCatalog(stdout);
    expect(catalog.skills[0]?.description).toBe("Updated.");
    expect(catalog.slashCommands[0]?.description).toBe("Updated.");
  });

  it("returns empty catalogs when the output carries no command frame", () => {
    // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
    expect(decodeOmpCommandCatalog(JSON.stringify({ type: "ready" }))).toEqual({
      skills: [],
      slashCommands: [],
    });
  });
});

describe("catalogFromCommandEntries", () => {
  it("splits raw live entries with the same skill: rule as the probe", () => {
    const catalog = catalogFromCommandEntries([
      { name: "skill:tdd", description: "Test-driven development." },
      { name: "skillful", description: "Toggle skill listing." },
      { name: "security", description: "Run security scans", input: { hint: "<plan|scan>" } },
      { name: "skill:" },
      { name: "   " },
      "not-an-object",
    ]);

    expect(catalog.skills).toEqual([
      {
        name: "tdd",
        path: "skill://tdd/SKILL.md",
        enabled: true,
        description: "Test-driven development.",
      },
    ]);
    expect(catalog.slashCommands).toEqual([
      { name: "security", description: "Run security scans", input: { hint: "<plan|scan>" } },
      { name: "skillful", description: "Toggle skill listing." },
    ]);
  });

  it("matches decodeOmpCommandCatalog for the same entries", () => {
    const entries = [
      { name: "skill:deploy", description: "Deploy the app" },
      { name: "share", description: "Share the session" },
      { name: "skill:deploy", description: "Deploy the app (updated)" },
    ];
    expect(catalogFromCommandEntries(entries)).toEqual(decodeOmpCommandCatalog(frame(entries)));
  });
});
