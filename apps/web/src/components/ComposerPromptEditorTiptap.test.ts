import { describe, expect, it } from "vite-plus/test";

import { isOpenableSkillPath } from "./ComposerPromptEditorTiptap";

describe("isOpenableSkillPath", () => {
  it("opens filesystem paths, including Windows drives", () => {
    expect(isOpenableSkillPath("/Users/matt/.codex/skills/review/SKILL.md")).toBe(true);
    expect(isOpenableSkillPath("C:/Storage/.omp/skills/tdd/SKILL.md")).toBe(true);
    expect(isOpenableSkillPath("C:\\Storage\\.omp\\skills\\tdd\\SKILL.md")).toBe(true);
    expect(isOpenableSkillPath(".omp/skills/tdd/SKILL.md")).toBe(true);
  });

  it("refuses internal URLs and blank paths", () => {
    expect(isOpenableSkillPath("skill://tdd/SKILL.md")).toBe(false);
    expect(isOpenableSkillPath("https://example.com/SKILL.md")).toBe(false);
    expect(isOpenableSkillPath("   ")).toBe(false);
  });
});
