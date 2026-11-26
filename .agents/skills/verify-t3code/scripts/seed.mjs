// Bring a fresh verify-t3code instance to a usable baseline through the real UI:
// first-run wizard -> add the fixture project -> send one message with the mock Cursor
// provider. Each step logs its sub-feature ID and asserts the end state.
//   node seed.mjs RUN_DIR
import { execFileSync } from "node:child_process";
import { start, check } from "./lib.mjs";

const { run, t, p, step, finish } = await start("seed.mjs", 90000);

// The Projects step offers to import projects from Claude Code and Codex session history.
// Skip it: a verify run must not read a person's transcripts.
await step("onboarding.connect", "wait for the wizard, read step 1", async () => {
  await p.getByRole("button", { name: "Continue" }).waitFor({ timeout: 180000 });
  const text = await p.locator("body").innerText();
  check(/Connected/.test(text) && /primary-asus|Computers to set up/.test(text), "Connect step does not show a connected computer");
  return `${new URL(p.url()).pathname} | ${text.replace(/\s+/g, " ").slice(0, 160)}`;
});
await step("onboarding.agents", "Continue -> Your agents", async () => {
  await p.getByRole("button", { name: "Continue" }).click();
  await p.getByRole("heading", { name: "Your agents" }).waitFor();
  const text = (await p.locator("body").innerText()).replace(/\s+/g, " ");
  check(/Ready/.test(text), "no agent shows Ready");
  return text.slice(text.indexOf("Your agents"), text.indexOf("Your agents") + 160);
});
await step("onboarding.projects-skip", "Continue, then Do not import projects", async () => {
  await p.getByRole("button", { name: "Continue" }).click();
  await p.getByRole("button", { name: "Do not import projects" }).click();
  await p.getByRole("button", { name: "New project" }).waitFor();
  check(new URL(p.url()).pathname.startsWith("/draft/"), "did not land on a /draft/ page");
  return new URL(p.url()).pathname;
});

await step("projects.add.sources", "click New project, read the sources", async () => {
  await p.getByRole("button", { name: "New project" }).click();
  await p.getByRole("option", { name: /Local folder/ }).waitFor();
  const text = (await p.locator('[role="dialog"]').first().innerText()).replace(/\s+/g, " ");
  for (const s of ["Local folder", "Git URL", "GitHub repository"]) check(text.includes(s), `source "${s}" missing`);
  return text.slice(0, 200);
});
await step("projects.add.local", "Local folder, type the fixture path, Add", async () => {
  await p.getByRole("option", { name: /Local folder/ }).click();
  await p.getByRole("combobox").first().fill(`${run}/fixture/demo-app`);
  await p.getByRole("button", { name: /^Add/ }).click();
  await p.getByRole("heading", { name: /What should we build in/ }).filter({ hasText: "demo-app" }).waitFor();
  return "draft heading names demo-app";
});

await step("composer.model-picker", "open the model picker, Cursor tab", async () => {
  await p.getByRole("button", { name: /routing group|Luna|Codex|Claude/ }).first().click();
  await p.getByRole("button", { name: "Cursor", exact: true }).click();
  const auto = p.getByRole("option", { name: /^Auto Cursor/ });
  await auto.waitFor();
  const models = (await p.getByRole("option").allInnerTexts()).map((s) => s.replace(/\s+/g, " "));
  return JSON.stringify(models.slice(0, 4));
});
await step("composer.send", "choose Auto, type a prompt, Send message", async () => {
  await p.getByRole("option", { name: /^Auto Cursor/ }).click();
  await p.locator('[data-testid="composer-editor"]').first().click();
  await p.keyboard.type("verify-t3code: first message");
  await p.getByRole("button", { name: "Send message" }).click();
  await p.waitForFunction(() => document.body.innerText.includes("verify-t3code mock reply"), null, { timeout: 120000 });
  check(/^\/[^/]+\/[^/]+$/.test(new URL(p.url()).pathname), "URL is not /<environmentId>/<threadId>");
  return `reply "verify-t3code mock reply" visible at ${new URL(p.url()).pathname}`;
});
await step("composer.worktree", "git worktree list in the fixture repo", async () => {
  const out = execFileSync("git", ["-C", `${run}/fixture/demo-app`, "worktree", "list"], { encoding: "utf8" });
  check(/\[t3code\/[0-9a-f]+\]/.test(out) && out.includes(`${run}/home/worktrees/`), "no t3code/<id> worktree under $RUN/home/worktrees");
  return out.trim().split("\n").slice(1).join(" ; ");
});
finish();
