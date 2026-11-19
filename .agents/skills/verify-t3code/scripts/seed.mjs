// Bring a fresh verify-t3code instance to a usable baseline through the real UI:
// first-run wizard -> add the fixture project -> send one message with the mock Cursor
// provider. Prints the thread URL. Every step records its observed end state.
//   node seed.mjs RUN_DIR
import { connect } from "./browser.mjs";

const run = process.argv[2];
if (!run) throw new Error("usage: node seed.mjs RUN_DIR");
const t = await connect(run);
const p = t.page;
p.setDefaultTimeout(90000);

// Wizard: Connect -> Agents -> Projects (skip import: it would scan real transcripts).
await p.getByRole("button", { name: "Continue" }).waitFor({ timeout: 180000 });
await p.getByRole("button", { name: "Continue" }).click();
await p.getByRole("heading", { name: "Your agents" }).waitFor();
await p.getByRole("button", { name: "Continue" }).click();
await p.getByRole("button", { name: "Do not import projects" }).click();
await p.getByRole("button", { name: "New project" }).waitFor();
t.note(`onboarding.wizard: Continue, Continue, Do not import -> ${new URL(p.url()).pathname}`);
await t.shot("seed-1-after-wizard");

// Add the fixture repo as a project.
await p.getByRole("button", { name: "New project" }).click();
await p.getByRole("option", { name: /Local folder/ }).click();
await p.getByRole("combobox").first().fill(`${run}/fixture/demo-app`);
await p.getByRole("button", { name: /^Add/ }).click();
await p.getByRole("heading", { name: /What should we build in/ }).filter({ hasText: "demo-app" }).waitFor();
t.note("projects.add.local: fixture/demo-app added -> draft heading names demo-app");
await t.shot("seed-2-project-added");

// Choose the mock provider (Cursor > Auto) and send.
await p.getByRole("button", { name: /routing group|Luna|Codex|Claude/ }).first().click();
await p.getByRole("button", { name: "Cursor", exact: true }).click();
await p.getByRole("option", { name: /^Auto Cursor/ }).click();
await p.locator('[data-testid="composer-editor"]').first().click();
await p.keyboard.type("verify-t3code: first message");
await p.getByRole("button", { name: "Send message" }).click();
await p.waitForFunction(() => document.body.innerText.includes("verify-t3code mock reply"), null, { timeout: 120000 });
t.note(`threads.send: reply "verify-t3code mock reply" visible at ${new URL(p.url()).pathname}`);
await t.shot("seed-3-first-thread");
console.log(p.url());
process.exit(0);
