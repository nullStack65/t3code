// Drive the thread lifecycle through the sidebar context menu and record what a user sees.
// Run after seed.mjs (one thread titled "verify-t3code: first message" exists).
//   node drive-threads.mjs RUN_DIR
// Every step appends "<sub-feature id>: <action> -> <observed end state>" to
// RUN_DIR/evidence/observed.log and saves a screenshot. A step that throws is logged as
// FAIL with the reason; the script continues so one bug does not hide the next.
import { connect } from "./browser.mjs";

const run = process.argv[2];
if (!run) throw new Error("usage: node drive-threads.mjs RUN_DIR");
const t = await connect(run);
const p = t.page;
p.setDefaultTimeout(45000);

const ROW = '[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]';
const rowTitles = async () =>
  p.locator(ROW).evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
const section = async () =>
  p.evaluate(() => {
    const q = (s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim() ?? null;
    return {
      pinnedHeader: q('[data-testid="sidebar-pinned-header"]'),
      settledToggle: q('[data-testid="sidebar-settled-shelf-toggle"]'),
      snoozedToggle: q('[data-testid="sidebar-snoozed-shelf-toggle"]'),
    };
  });
const toast = async () =>
  p.locator('[data-sonner-toast], [role="status"] li, [data-testid="toast"]').allInnerTexts().catch(() => []);

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

// Open the row's context menu and click an item. Retries the right-click once: on a busy
// host the previous menu may still be closing and swallow the first one.
const menu = async (rowText, item) => {
  const entry = p.getByText(item, { exact: true }).first();
  for (let attempt = 0; attempt < 2; attempt++) {
    await p.keyboard.press("Escape");
    await p.locator(ROW).filter({ hasText: rowText }).first().click({ button: "right", timeout: 45000 });
    if (await entry.waitFor({ state: "visible", timeout: 30000 }).then(() => true, () => false)) break;
  }
  await entry.click({ timeout: 45000 });
  await p.waitForTimeout(1200);
};
// Open a shelf only if it is closed: snoozing or settling can leave it open already.
const expand = async (testid) => {
  const toggle = p.locator(`[data-testid="${testid}"]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await p.waitForTimeout(800);
};
const pinned = () => p.locator('[aria-label="Pinned"], button[aria-label="Unpin thread"]').count();

await step("threads.list", "read sidebar rows", async () => JSON.stringify(await rowTitles()));

await step("threads.pin", "context menu > Pin thread", async () => {
  await menu("first message", "Pin thread");
  return JSON.stringify({ pinnedMarkers: await pinned(), ...(await section()), rows: await rowTitles(), toast: await toast() });
});
await step("threads.unpin", "context menu > Unpin thread", async () => {
  await menu("first message", "Unpin thread");
  return JSON.stringify({ pinnedMarkers: await pinned(), ...(await section()), rows: await rowTitles() });
});

await step("threads.rename", "context menu > Rename thread, type new title", async () => {
  await menu("first message", "Rename thread");
  await p.keyboard.press("Control+A");
  await p.keyboard.type("verify-t3code: renamed");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1200);
  const crumb = await p.locator('button[aria-label^="Thread actions for"]').first().getAttribute("aria-label");
  return JSON.stringify({ breadcrumb: crumb, rows: await rowTitles() });
});

await step("threads.settle", "context menu > Settle thread", async () => {
  await menu("renamed", "Settle thread");
  return JSON.stringify({ ...(await section()), activeRows: await rowTitles(), toast: await toast() });
});
await step("threads.unsettle", "expand Settled shelf, context menu > Un-settle thread", async () => {
  await expand("sidebar-settled-shelf-toggle");
  await menu("renamed", "Un-settle thread");
  return JSON.stringify({ ...(await section()), rows: await rowTitles() });
});

await step("search.active", "Control+K, search the title of an active thread", async () => {
  await p.mouse.click(800, 200);
  await p.keyboard.press("Control+k");
  await p.locator('input[placeholder^="Search commands"]').first().fill("renamed");
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(1000);
    if (await p.locator('[role="option"]').count()) break;
  }
  const opts = (await p.locator('[role="option"]').allInnerTexts()).map((s) => s.replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  if (!opts.length) throw new Error("no palette result for an active thread");
  return JSON.stringify(opts.slice(0, 4));
});
await step("threads.snooze", "context menu > Snooze > In 1 hour", async () => {
  await p.locator(ROW).filter({ hasText: "renamed" }).first().click({ button: "right", timeout: 45000 });
  await p.getByText("Snooze", { exact: true }).first().hover();
  await p.getByText(/^In 1 hour/).first().click({ timeout: 45000 });
  await p.waitForTimeout(1500);
  return JSON.stringify({ ...(await section()), activeRows: await rowTitles() });
});
await step("search.snoozed", "Control+K, search the title of the snoozed thread", async () => {
  await p.keyboard.press("Control+k");
  await p.locator('input[placeholder^="Search commands"]').first().fill("renamed");
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(1000);
    if (await p.locator('[role="option"]').count()) break;
  }
  const opts = (await p.locator('[role="option"]').allInnerTexts()).map((s) => s.replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  return JSON.stringify(opts.slice(0, 4));
});
await step("threads.wake", "Snoozed shelf: Wake thread now", async () => {
  await expand("sidebar-snoozed-shelf-toggle");
  // Wake is revealed by row hover (group-hover), which needs the browser's hover capability.
  await p.locator('[data-testid="sidebar-row-slim"]').first().hover();
  await p.locator('[aria-label="Wake thread now"]').first().click({ timeout: 45000 });
  await p.waitForTimeout(1500);
  return JSON.stringify({ ...(await section()), activeRows: await rowTitles() });
});

await step("threads.mark-unread", "context menu > Mark unread", async () => {
  await menu("renamed", "Mark unread");
  return JSON.stringify({ rows: await rowTitles() });
});

await step("threads.archive", "context menu > Archive thread", async () => {
  await menu("renamed", "Archive thread");
  const maybeConfirm = p.getByRole("button", { name: /^(Archive|Confirm)/ }).first();
  if (await maybeConfirm.isVisible().catch(() => false)) await maybeConfirm.click();
  await p.waitForTimeout(1500);
  return JSON.stringify({ rows: await rowTitles(), url: new URL(p.url()).pathname, toast: await toast() });
});

process.exit(0);
