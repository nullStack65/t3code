// Visit the non-thread surfaces of a verify-t3code instance and record what a user sees:
// settings sections, Archive (restore), command palette search, Usage, Pull Requests,
// terminal drawer, project filter. Run after drive-threads.mjs (one archived thread).
//   node drive-surfaces.mjs RUN_DIR
// Each step logs "<id>: <action> -> <observed>" and throws (FAIL) when the end state is not
// reached; exits 1 if any step failed.
import { start, ROW, rowTitles, check, searchPalette, mainText as mainTextOf } from "./lib.mjs";

const { run, p, step, finish } = await start("drive-surfaces.mjs", 60000);
const mainText = (n) => mainTextOf(p, n);

const LABELS = { general: "General", appearance: "Appearance", keybindings: "Keybindings", providers: "Providers", integrations: "Integrations", "source-control": "Source Control", storage: "Storage", connections: "Connections", archived: "Archive" };

// A string only this section's body contains; the header and URL change before the body.
const MARKER = { general: "New threads", appearance: "Colors & themes", keybindings: "Appearance: Cycle", providers: "Refresh provider status", integrations: "Agent browser access", "source-control": "Repositories", storage: "Worktrees", connections: "Network access", archived: "Archived" };

// Settings has its own sidebar of buttons; enter it once from the footer gear.
const STEP_ID = { archived: "archive.page", connections: "connections.page" };
const EXTRA = { providers: ["Codex v", "Claude v"], keybindings: [" bindings"] };
const settingsRoute = (slug) => async () => {
  if (!new URL(p.url()).pathname.startsWith("/settings")) {
    await p.locator('button[aria-label="Settings"], li button:has-text("Settings")').first().click();
  }
  const t0 = Date.now();
  await p.locator("button", { hasText: new RegExp(`^${LABELS[slug]}$`) }).first().click();
  await p.waitForURL(new RegExp(`/settings/${slug}$`));
  // Settings pages are lazy routes: the URL and header change first, and for a few
  // seconds the body is still the previous page's. Wait for this section's own marker.
  await p.waitForFunction((m) => (document.querySelector("main")?.innerText ?? "").includes(m), MARKER[slug], { timeout: 90000 });
  const bodyMs = Date.now() - t0;
  await p.waitForTimeout(500);
  const body = await mainText(4000);
  for (const needle of EXTRA[slug] ?? []) check(body.includes(needle), `section body lacks "${needle}"`);
  return `${new URL(p.url()).pathname} | body after ${bodyMs} ms | ${await mainText()}`;
};

for (const slug of ["general", "appearance", "keybindings", "providers", "connections", "storage", "source-control", "integrations", "archived"]) {
  await step(STEP_ID[slug] ?? `settings.${slug}`, `open Settings > ${LABELS[slug]}`, settingsRoute(slug));
  if (slug === "archived") {
    await step("archive.restore", "Archive page: unarchive the archived thread", async () => {
      await p.getByRole("button", { name: /unarchive|restore/i }).first().click();
      await p.waitForTimeout(1500);
      const text = await mainText(160);
      check(text.includes("No archived threads"), "Archive page still lists a thread after Unarchive");
      return text;
    });
  }
}

// Leave Settings through its Back button before using the thread sidebar again.
await step("archive.returns", "after Unarchive, click Back and read the sidebar", async () => {
  await p.locator("button", { hasText: /^Back$/ }).first().click();
  await p.waitForTimeout(1500);
  const rows = await rowTitles(p);
  check(rows.length === 1 && rows[0].includes("renamed"), `expected the unarchived thread in the sidebar, got ${JSON.stringify(rows)}`);
  return JSON.stringify(rows);
});

await step("search.palette", "Control+K, type the thread title (after archive + unarchive)", async () => {
  const opts = await searchPalette(p, "renamed");
  check(opts.some((o) => o.includes("verify-t3code: renamed")), 'palette has no result for a thread that is in the sidebar');
  return JSON.stringify(opts.slice(0, 4));
});

const home = () =>
  p.locator('a[aria-label="Go to threads"], a[href="/"]').first().click().then(() => p.waitForTimeout(2000)).catch(() => {});

await step("usage.page", "open Usage from sidebar footer", async () => {
  await p.getByRole("button", { name: "Usage", exact: true }).click();
  await p.waitForURL(/\/usage$/);
  await p.waitForTimeout(2500);
  const text = await mainText();
  for (const w of ["Cost", "Tokens", "Limits"]) check(text.includes(w), `Usage page lacks "${w}"`);
  return `${new URL(p.url()).pathname} | ${text}`;
});
await home();

await step("pull-requests.page", "open Pull Requests from sidebar footer", async () => {
  await p.getByRole("button", { name: "Pull Requests", exact: true }).click();
  await p.waitForURL(/\/pull-requests(\?.*)?$/);
  // The list is a skeleton first: wait for either rows ("#<number>") or the error.
  await p.waitForFunction(() => /#\d+ |Could not load pull requests/.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 60000 });
  const text = await mainText(300);
  if (/Could not load pull requests/.test(text)) throw new Error(`first visit shows: ${text.slice(text.indexOf("Could not load"), text.indexOf("Could not load") + 90)}`);
  return `${new URL(p.url()).pathname} | ${text}`;
});
await home();

await step("projects.filter", "open 'Filter threads by project' and read the options", async () => {
  await p.locator('[aria-label="Filter threads by project"]').first().click();
  await p.waitForTimeout(1200);
  const opts = (await p.locator('[role="option"]').allInnerTexts()).map((s) => s.replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  check(opts.some((o) => o.includes("demo-app")) && opts.some((o) => o.includes("server")), "filter lacks demo-app or server");
  return JSON.stringify(opts);
});

await step("threads.new", "click New thread", async () => {
  await p.locator('[data-testid="new-thread-button"], button[aria-label="New thread"]').first().click();
  await p.waitForURL(/\/draft\//);
  await p.waitForTimeout(1500);
  const text = await mainText(160);
  check(text.includes("What should we build in demo-app"), "draft heading does not name demo-app");
  return `${new URL(p.url()).pathname.split("/")[1]} | ${text}`;
});

await p.keyboard.press("Escape");
await p.waitForTimeout(500);
await step("terminal.drawer", "toggle the terminal drawer, run a command that writes a file", async () => {
  await p.locator('button[aria-label="Toggle terminal drawer"]').first().click();
  await p.waitForTimeout(4000);
  // Keystrokes must reach the shell. If the composer has focus instead, Enter would send a
  // turn with the default (real, paid) model, so refuse to type.
  const inComposer = await p.evaluate(() => !!document.querySelector('[data-testid="composer-editor"]')?.contains(document.activeElement));
  check(!inComposer, "composer has focus, not the terminal; refusing to type");
  const marker = `${run}/fixture/terminal-proof-${Date.now()}.txt`;
  await p.keyboard.type(`echo verify-t3code-terminal > ${marker}`);
  await p.keyboard.press("Enter");
  const { readFileSync } = await import("node:fs");
  let body = "";
  for (let i = 0; i < 30 && !body; i++) {
    await p.waitForTimeout(1000);
    body = (() => { try { return readFileSync(marker, "utf8").trim(); } catch { return ""; } })();
  }
  if (!body) throw new Error("command typed in the drawer never wrote " + marker);
  return `file written by the drawer shell: ${marker.split("/").slice(-1)[0]} = "${body}"`;
});

finish();
