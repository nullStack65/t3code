// Drive the thread lifecycle through the sidebar context menu and record what a user sees.
// Run after seed.mjs (one thread titled "verify-t3code: first message" exists).
//   node drive-threads.mjs RUN_DIR
// Each step logs "<sub-feature id>: <action> -> <observed end state>" and throws (FAIL)
// when the end state is not reached; the script continues so one bug does not hide the
// next, and exits 1 if any step failed.
import { start, ROW, rowTitles, check, searchPalette } from "./lib.mjs";

const { t, p, step, finish } = await start("drive-threads.mjs");

const section = () =>
  p.evaluate(() => {
    const q = (s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ").trim() ?? null;
    return {
      settled: q('[data-testid="sidebar-settled-shelf-toggle"]'),
      snoozed: q('[data-testid="sidebar-snoozed-shelf-toggle"]'),
    };
  });

// Open the row's context menu and click an item. Retries the right-click once: on a busy
// host the previous menu may still be closing and swallow the first one.
const menu = async (rowText, item) => {
  const entry = p.getByText(item, { exact: true }).first();
  for (let attempt = 0; attempt < 2; attempt++) {
    await p.keyboard.press("Escape");
    await p
      .locator(ROW)
      .filter({ hasText: rowText })
      .first()
      .click({ button: "right", timeout: 45000 });
    if (
      await entry.waitFor({ state: "visible", timeout: 30000 }).then(
        () => true,
        () => false,
      )
    )
      break;
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

await step("threads.list", "read sidebar rows", async () => {
  const rows = await rowTitles(p);
  check(
    rows.length === 1 && rows[0].includes("first message"),
    "expected one row titled with the first message",
  );
  return JSON.stringify(rows);
});

await step("sidebar-lifecycle.pin", "context menu > Pin thread", async () => {
  await menu("first message", "Pin thread");
  const n = await pinned();
  check(n >= 1, "no pin marker on the row after Pin thread");
  return `pin markers: ${n}`;
});
await step("sidebar-lifecycle.unpin", "context menu > Unpin thread", async () => {
  await menu("first message", "Unpin thread");
  const n = await pinned();
  check(n === 0, "pin marker still present after Unpin thread");
  return `pin markers: ${n}`;
});

await step("threads.rename", "context menu > Rename thread, type new title", async () => {
  await menu("first message", "Rename thread");
  await p.keyboard.press("Control+A");
  await p.keyboard.type("verify-t3code: renamed");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1200);
  const crumb = await p
    .locator('button[aria-label^="Thread actions for"]')
    .first()
    .getAttribute("aria-label");
  const rows = await rowTitles(p);
  check(
    crumb?.includes("verify-t3code: renamed") && rows[0]?.includes("verify-t3code: renamed"),
    "title not renamed in header and row",
  );
  return JSON.stringify({ breadcrumb: crumb, rows });
});

await step("sidebar-lifecycle.settle", "context menu > Settle thread", async () => {
  await menu("renamed", "Settle thread");
  const s = await section();
  const rows = await rowTitles(p);
  check(
    /Settled \(1\)/.test(s.settled ?? "") && rows.length === 0,
    `expected Settled (1) and no active rows, got ${JSON.stringify({ s, rows })}`,
  );
  return JSON.stringify({ ...s, activeRows: rows.length });
});
await step(
  "sidebar-lifecycle.unsettle",
  "expand Settled shelf, context menu > Un-settle thread",
  async () => {
    await expand("sidebar-settled-shelf-toggle");
    await menu("renamed", "Un-settle thread");
    const s = await section();
    const rows = await rowTitles(p);
    check(
      rows.length === 1 && !/\(\d+\)/.test(s.settled ?? ""),
      `expected one active row and no settled count, got ${JSON.stringify({ s, rows })}`,
    );
    return JSON.stringify({ ...s, rows });
  },
);

const searchStep = async (what) => {
  const opts = await searchPalette(p, "renamed");
  check(
    opts.some((o) => o.includes("verify-t3code: renamed")),
    `no palette result for ${what}`,
  );
  return JSON.stringify(opts.slice(0, 4));
};
await step("search.active", "Control+K, search the title of an active thread", () =>
  searchStep("an active thread"),
);

await step("sidebar-lifecycle.snooze", "context menu > Snooze > In 1 hour", async () => {
  await p
    .locator(ROW)
    .filter({ hasText: "renamed" })
    .first()
    .click({ button: "right", timeout: 45000 });
  await p.getByText("Snooze", { exact: true }).first().hover();
  await p
    .getByText(/^In 1 hour/)
    .first()
    .click({ timeout: 45000 });
  await p.waitForTimeout(1500);
  const s = await section();
  const rows = await rowTitles(p);
  check(
    /Snoozed \(1\)/.test(s.snoozed ?? "") && rows.length === 0,
    `expected Snoozed (1) and no active rows, got ${JSON.stringify({ s, rows })}`,
  );
  return JSON.stringify({ ...s, activeRows: rows.length });
});
await step("search.snoozed", "Control+K, search the title of the snoozed thread", () =>
  searchStep("a snoozed thread"),
);
await step("sidebar-lifecycle.wake", "Snoozed shelf: Wake thread now", async () => {
  await expand("sidebar-snoozed-shelf-toggle");
  // Wake is revealed by row hover (group-hover), which needs the browser's hover capability.
  await p.locator('[data-testid="sidebar-row-slim"]').first().hover();
  await p.locator('[aria-label="Wake thread now"]').first().click({ timeout: 45000 });
  await p.waitForTimeout(1500);
  const s = await section();
  const rows = await rowTitles(p);
  check(
    s.snoozed === null && rows.length === 1,
    `expected no snoozed shelf and one active row, got ${JSON.stringify({ s, rows })}`,
  );
  return JSON.stringify({ ...s, rows });
});

await step("threads.mark-unread", "context menu > Mark unread", async () => {
  await menu("renamed", "Mark unread");
  const rows = await rowTitles(p);
  check(rows[0]?.includes("Done"), 'row does not show the "Done" chip');
  return JSON.stringify(rows);
});

await step("archive.thread", "context menu > Archive thread", async () => {
  await menu("renamed", "Archive thread");
  const maybeConfirm = p.getByRole("button", { name: /^(Archive|Confirm)/ }).first();
  if (await maybeConfirm.isVisible().catch(() => false)) await maybeConfirm.click();
  await p.waitForTimeout(1500);
  const rows = await rowTitles(p);
  const path = new URL(p.url()).pathname;
  check(
    rows.length === 0 && path.startsWith("/draft/"),
    `expected no rows and a /draft/ URL, got ${JSON.stringify({ rows: rows.length, path })}`,
  );
  return JSON.stringify({ rows: rows.length, url: path });
});

finish();
