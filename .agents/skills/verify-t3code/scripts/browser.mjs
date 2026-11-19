// Headless Chromium for an isolated verify-t3code instance, driven over a loopback
// DevTools port so one browser (and its logged-in state) survives across drive scripts.
//
//   node browser.mjs up RUN_DIR        start Chromium, pair it with the instance, record CDP port
//   import { connect } from "./browser.mjs";
//   const t = await connect(RUN_DIR);  // attach to the running browser
//   await t.page.getByRole("button", { name: "Continue" }).click();
//   await t.shot("welcome-connect");   // RUN_DIR/evidence/welcome-connect.png
//   t.note("welcome.connect: Continue -> Agents step");  // RUN_DIR/evidence/observed.log
//   await t.detach();                  // leaves the browser running
//
// Uses the playwright-core already in the repo's pnpm store and the Chromium in
// ~/.cache/ms-playwright, with a throwaway profile under RUN_DIR. It never touches a
// person's browser profile. cleanup.sh kills the browser by the PID recorded in
// RUN_DIR/browser.env.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function readEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

export const readInstance = (runDir) => readEnvFile(join(runDir, "instance.env"));

function loadPlaywright(repo) {
  const store = join(repo, "node_modules/.pnpm");
  const dir = readdirSync(store).find((d) => d.startsWith("playwright-core@"));
  if (!dir) throw new Error("playwright-core not found in " + store);
  return createRequire(join(store, dir, "node_modules/playwright-core/"))("playwright-core");
}

function chromiumPath() {
  const root = join(homedir(), ".cache/ms-playwright");
  const dirs = readdirSync(root).filter((d) => d.startsWith("chromium-")).sort();
  const p = join(root, dirs.at(-1), "chrome-linux64/chrome");
  if (!existsSync(p)) throw new Error("no Chromium at " + p);
  return p;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

export async function up(runDir, { width = 1440, height = 900 } = {}) {
  const inst = readInstance(runDir);
  const port = await freePort();
  const profile = join(runDir, "profile");
  mkdirSync(profile, { recursive: true });
  const log = openSync(join(runDir, "browser.log"), "a");
  const child = spawn(
    chromiumPath(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      // Headless Chromium reports no hover or fine pointer, so every Tailwind hover: and
      // group-hover: style stays off and hover-only controls (Wake, Un-settle) never show.
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  writeFileSync(join(runDir, "browser.env"), `BROWSER_PID=${child.pid}\nCDP_PORT=${port}\n`, { mode: 0o600 });
  const t = await connect(runDir, { retries: 40 });
  // Dev mode serves hundreds of modules, so "domcontentloaded" can exceed 30 s on a busy
  // host. Return at "commit" and let callers wait for real UI.
  await t.page.goto(inst.PAIR_URL, { waitUntil: "commit", timeout: 120000 });
  await t.detach();
  return { pid: child.pid, port };
}

export async function connect(runDir, { retries = 1 } = {}) {
  const inst = readInstance(runDir);
  const { CDP_PORT } = readEnvFile(join(runDir, "browser.env"));
  const { chromium } = loadPlaywright(inst.REPO);
  let browser;
  for (let i = 0; ; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      break;
    } catch (e) {
      if (i + 1 >= retries) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(60000);
  const evidence = join(runDir, "evidence");
  mkdirSync(evidence, { recursive: true });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  return {
    page, context, inst, consoleErrors,
    base: `http://localhost:${inst.WEB_PORT}`,
    async shot(name) {
      const path = join(evidence, `${name}.png`);
      // A saturated host can stall a screenshot; a missing image is reported, never fatal.
      return page.screenshot({ path, timeout: 90000 }).then(() => path, (e) => `SCREENSHOT-FAILED ${name}: ${String(e).split("\n")[0]}`);
    },
    note(line) {
      appendFileSync(join(evidence, "observed.log"), line + "\n");
    },
    // Drop this script's connection; the browser keeps running for the next script.
    async detach() {
      await browser._connection?.close?.();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "up") {
  const r = await up(process.argv[3]);
  console.log(`browser pid=${r.pid} cdp=127.0.0.1:${r.port}`);
  process.exit(0);
}
