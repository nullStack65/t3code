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
  await p.locator('[data-testid="sidebar-settled-shelf-toggle"]').click();
  await p.waitForTimeout(800);
  await menu("renamed", "Un-settle thread");
  return JSON.stringify({ ...(await section()), rows: await rowTitles() });
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
