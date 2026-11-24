// Shared helpers for the drive scripts. A step is OK only when its function returns
// without throwing, so every step must throw when the user-visible end state is wrong.
import { connect } from "./browser.mjs";

export const ROW = '[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]';

export async function start(usage, timeout = 45000) {
  const run = process.argv[2];
  if (!run) throw new Error(`usage: node ${usage} RUN_DIR`);
  const t = await connect(run);
  t.page.setDefaultTimeout(timeout);
  let failed = 0;
  async function step(id, action, fn) {
    try {
      const seen = await fn();
      t.note(`${id}: ${action} -> ${seen}`);
      console.log("OK  ", id, "|", seen);
    } catch (e) {
      failed++;
      const why = String(e.message ?? e)
        .split("\n")[0]
        .slice(0, 200);
      t.note(`${id}: ${action} -> FAIL ${why}`);
      console.log("FAIL", id, "|", why);
    }
    await t.shot(id.replace(/[^a-z0-9.]+/gi, "-"));
  }
  const finish = () => process.exit(failed ? 1 : 0);
  return { run, t, p: t.page, step, finish };
}

export const mainText = (p, n = 220) =>
  p.evaluate(
    (len) =>
      (document.querySelector("main")?.innerText ?? document.body.innerText)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, len),
    n,
  );

export const rowTitles = (p) =>
  p.locator(ROW).evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));

export const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Open the command palette from the page body (focus in the terminal swallows Control+K),
// type a query, wait for results and close it. Returns the result rows' text.
export async function searchPalette(p, query) {
  await p.keyboard.press("Escape");
  await p.mouse.click(800, 200);
  await p.keyboard.press("Control+k");
  await p.locator('input[placeholder^="Search commands"]').first().fill(query);
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(1000);
    if (await p.locator('[role="option"]').count()) break;
  }
  const opts = (await p.locator('[role="option"]').allInnerTexts()).map((s) =>
    s.replace(/\s+/g, " "),
  );
  await p.keyboard.press("Escape");
  return opts;
}
