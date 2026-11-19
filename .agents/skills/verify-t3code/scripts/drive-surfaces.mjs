// Visit the non-thread surfaces of a verify-t3code instance and record what a user sees:
// settings sections, Archive (restore), command palette search, Usage, Pull Requests,
// terminal drawer, project filter. Run after drive-threads.mjs (one archived thread).
//   node drive-surfaces.mjs RUN_DIR
// Each step appends "<id>: <action> -> <observed>" to RUN_DIR/evidence/observed.log.
import { connect } from "./browser.mjs";

const run = process.argv[2];
if (!run) throw new Error("usage: node drive-surfaces.mjs RUN_DIR");
const t = await connect(run);
const p = t.page;
p.setDefaultTimeout(60000);

const mainText = async (n = 220) =>
  (await p.evaluate(() => (document.querySelector("main")?.innerText ?? document.body.innerText).replace(/\s+/g, " ").trim())).slice(0, n);

async function step(id, action, fn) {
  try {
    const seen = await fn();
    t.note(`${id}: ${action} -> ${seen}`);
    console.log("OK  ", id, "|", seen);
  } catch (e) {
    const why = String(e.message ?? e).split("\n")[0].slice(0, 160);
    t.note(`${id}: ${action} -> FAIL ${why}`);
    console.log("FAIL", id, "|", why);
  }
  await t.shot(id.replace(/[^a-z0-9.]+/gi, "-"));
}

const settingsRoute = (slug) => async () => {
  await p.getByRole("button", { name: "Settings", exact: true }).first().click().catch(() => {});
  const link = p.locator(`a[href="/settings/${slug}"]`).first();
  if (!(await link.isVisible().catch(() => false))) await p.getByRole("button", { name: "Settings", exact: true }).first().click();
  await link.click();
  await p.waitForURL(new RegExp(`/settings/${slug}$`));
  await p.waitForTimeout(1500);
  return `${new URL(p.url()).pathname} | ${await mainText()}`;
};

for (const slug of ["general", "appearance", "keybindings", "providers", "connections", "archived", "projects", "storage", "source-control", "integrations"]) {
  await step(`settings.${slug}`, `open Settings > ${slug}`, settingsRoute(slug));
  if (slug === "archived") {
    await step("threads.archived.restore", "Archive page: unarchive the archived thread", async () => {
      const btn = p.getByRole("button", { name: /unarchive|restore/i }).first();
      await btn.click();
      await p.waitForTimeout(1500);
      return await mainText(160);
    });
  }
}

await step("usage.page", "open Usage from sidebar footer", async () => {
  await p.getByRole("button", { name: "Usage", exact: true }).click().catch(async () => p.locator('a[href="/usage"]').click());
  await p.waitForURL(/\/usage$/);
  await p.waitForTimeout(1500);
  return `${new URL(p.url()).pathname} | ${await mainText()}`;
});

await step("pullrequests.page", "open Pull Requests from sidebar footer", async () => {
  await p.getByRole("button", { name: "Pull Requests", exact: true }).click().catch(async () => p.locator('a[href="/pull-requests"]').click());
  await p.waitForURL(/\/pull-requests$/);
  await p.waitForTimeout(2500);
  return `${new URL(p.url()).pathname} | ${await mainText()}`;
});

await step("search.palette", "Control+K, type the thread title", async () => {
  await p.keyboard.press("Escape");
  await p.keyboard.press("Control+k");
  await p.locator('[data-testid="command-palette"] input, [role="dialog"] input').first().fill("renamed");
  await p.waitForTimeout(2500);
  const opts = await p.locator('[role="option"]').allInnerTexts();
  return JSON.stringify(opts.slice(0, 6).map((s) => s.replace(/\s+/g, " ")));
});
await p.keyboard.press("Escape");

await step("terminal.drawer", "Toggle terminal drawer button", async () => {
  await p.getByRole("button", { name: "Toggle terminal drawer" }).click();
  await p.waitForTimeout(3000);
  return `drawer: ${await p.locator('.xterm, [data-testid*="terminal"]').count()} terminal elements`;
});

process.exit(0);
