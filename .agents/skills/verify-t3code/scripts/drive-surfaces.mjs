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

const LABELS = { general: "General", appearance: "Appearance", keybindings: "Keybindings", providers: "Providers", integrations: "Integrations", "source-control": "Source Control", storage: "Storage", connections: "Connections", archived: "Archive" };

// Settings has its own sidebar of buttons; enter it once from the footer gear.
// A string only this section's body contains; the header and URL change before the body.
const MARKER = { general: "New threads", appearance: "Colors & themes", keybindings: "bindings", providers: "Refresh provider status", integrations: "Agent browser access", "source-control": "Repositories", storage: "Worktrees", connections: "Network access", archived: "Archived" };

// Settings has its own sidebar of buttons; enter it once from the footer gear.
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
  return `${new URL(p.url()).pathname} | body after ${bodyMs} ms | ${await mainText()}`;
};

for (const slug of ["general", "appearance", "keybindings", "providers", "connections", "storage", "source-control", "integrations", "archived"]) {
  await step(`settings.${slug}`, `open Settings > ${LABELS[slug]}`, settingsRoute(slug));
  if (slug === "archived") {
    await step("threads.archived.restore", "Archive page: unarchive the archived thread", async () => {
      await p.getByRole("button", { name: /unarchive|restore/i }).first().click();
      await p.waitForTimeout(1500);
      return await mainText(160);
    });
  }
}

// Leave Settings through its Back button before using the thread sidebar again.
await p.locator("button", { hasText: /^Back$/ }).first().click();
await p.waitForTimeout(1500);

await step("threads.archived.returns", "after Unarchive, leave Settings and read the sidebar", async () => {
  const rows = await p
    .locator('[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]')
    .evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  return JSON.stringify(rows);
});

const home = async () => {
  await p.locator('a[aria-label="Go to threads"], a[href="/"]').first().click();
  await p.waitForTimeout(2000);
};

await step("usage.page", "open Usage from sidebar footer", async () => {
  await p.getByRole("button", { name: "Usage", exact: true }).click();
  await p.waitForURL(/\/usage$/);
  await p.waitForTimeout(2500);
  return `${new URL(p.url()).pathname} | ${await mainText()}`;
});
await home();

await step("pullrequests.page", "open Pull Requests from sidebar footer", async () => {
  await p.getByRole("button", { name: "Pull Requests", exact: true }).click();
  await p.waitForURL(/\/pull-requests(\?.*)?$/);
  await p.waitForTimeout(3500);
  const text = await mainText(300);
  if (/Could not load pull requests/.test(text)) throw new Error(`first visit shows: ${text.slice(text.indexOf("Could not load"), text.indexOf("Could not load") + 90)}`);
  return `${new URL(p.url()).pathname} | ${text}`;
});
await home();

await step("projects.filter", "open 'Filter threads by project' and read the options", async () => {
  await p.locator('[aria-label="Filter threads by project"]').first().click();
  await p.waitForTimeout(1200);
  const opts = await p.locator('[role="option"]').allInnerTexts();
  await p.keyboard.press("Escape");
  return JSON.stringify(opts.map((s) => s.replace(/\s+/g, " ")));
});

await step("threads.new", "click New thread", async () => {
  await p.locator('[data-testid="new-thread-button"], button[aria-label="New thread"]').first().click();
  await p.waitForURL(/\/draft\//);
  await p.waitForTimeout(1500);
  return `${new URL(p.url()).pathname.split("/")[1]} | ${await mainText(120)}`;
});

await step("search.palette", "Control+K, type the thread title (after archive + unarchive)", async () => {
  await p.keyboard.press("Escape");
  await p.mouse.click(800, 200);
  await p.keyboard.press("Control+k");
  await p.locator('input[placeholder^="Search commands"]').first().fill("renamed");
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(1000);
    if (await p.locator('[role="option"]').count()) break;
  }
  const opts = (await p.locator('[role="option"]').allInnerTexts()).map((s) => s.replace(/\s+/g, " "));
  await p.keyboard.press("Escape");
  if (!opts.length) throw new Error('palette says "No matching commands, projects, or threads" for a thread that is in the sidebar');
  return JSON.stringify(opts.slice(0, 4));
});

await step("terminal.drawer", "toggle the terminal drawer, run a command that writes a file", async () => {
  await p.locator('button[aria-label="Toggle terminal drawer"]').first().click();
  await p.waitForTimeout(4000);
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

process.exit(0);
