// @effect-diagnostics nodeBuiltinImport:off - Playwright's runner owns this process, outside the server's Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test as base, type Locator, type Page, type TestInfo } from "playwright/test";

import { readRunState, type RunState } from "./run-state.ts";

export { expect };

const REPORT_DIR = NodePath.join(import.meta.dirname, "report", "shots");

export interface Qa {
  readonly state: RunState;
  /** Path of a seeded replay thread, or `undefined` when driving a deployment. */
  readonly thread: (key: string) => string;
  /** A thread only this project's run sends into, so projects never share a growing conversation. */
  readonly ownThread: (key: string) => string;
  /** Opens a path and waits for the app shell to mount. */
  readonly open: (path: string) => Promise<void>;
  /**
   * Saves a screenshot as report evidence. With `visual`, it also compares against the committed
   * baseline for this viewport and color scheme.
   */
  readonly shot: (
    name: string,
    options?: { visual?: boolean; mask?: ReadonlyArray<string>; page?: Page },
  ) => Promise<void>;
  /** Skips this project's run (shown as not applicable, not as unverified) unless the viewport matches. */
  readonly only: (viewport: "phone" | "desktop") => void;
  /** The page's uncaught errors so far. */
  readonly pageErrors: ReadonlyArray<string>;
  /** True in the 390 px projects, where the sidebar is a drawer and the composer starts collapsed. */
  readonly phone: boolean;
  /** Makes the thread list visible: a no-op on desktop, opens the drawer on a phone. */
  readonly showSidebar: () => Promise<void>;
  /** Starts a draft from the sidebar's New thread button, choosing the project if the app asks. */
  readonly newThread: () => Promise<void>;
  /** Focuses the composer's editor, expanding it first on a phone. */
  readonly composer: () => Promise<Locator>;
}

const featureOf = (info: TestInfo) =>
  info.annotations.find((annotation) => annotation.type === "feature")?.description ?? "unmapped";

export const test = base.extend<{ qa: Qa }>({
  baseURL: async ({ browserName: _browserName }, use) => {
    await use(readRunState().origin);
  },
  qa: async ({ page }, use, info) => {
    const state = readRunState();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
    });
    const qa: Qa = {
      state,
      pageErrors,
      phone: (page.viewportSize()?.width ?? 1440) < 600,
      showSidebar: async () => {
        // On desktop the sidebar is open from first paint; only a phone needs the drawer.
        if (!(page.viewportSize()!.width < 600)) {
          await expect(page.getByRole("navigation", { name: "Threads" })).toBeVisible();
          return;
        }
        const threads = page.getByRole("navigation", { name: "Threads" });
        if (await threads.isVisible()) return;
        await page.getByRole("button", { name: "Toggle main sidebar" }).click();
        await expect(threads).toBeVisible();
      },
      newThread: async () => {
        await qa.showSidebar();
        await page
          .getByRole("navigation", { name: "Threads" })
          .getByRole("button", { name: "New thread" })
          .click();
        // Depending on where it is pressed, the app starts a draft or asks which project first.
        const picker = page.getByRole("dialog", { name: "Command palette" });
        await Promise.race([
          page.waitForURL(/\/draft\//),
          picker.waitFor({ state: "visible" }),
        ]).catch(() => undefined);
        if (await picker.isVisible())
          await picker.getByRole("option", { name: /^QA demo/ }).click();
        await expect(page).toHaveURL(/\/draft\//);
      },
      composer: async () => {
        const expand = page.getByRole("button", { name: "Expand composer" });
        const editor = page.getByRole("textbox", { name: /^Message / });
        await expect(editor.or(expand)).toBeVisible();
        if (await expand.isVisible()) await expand.click();
        await expect(editor).toBeVisible();
        return editor;
      },
      thread: (key) => {
        const id = state.threads[key];
        if (id === undefined) {
          info.annotations.push({
            type: "unverified",
            description: `no seeded "${key}" thread on this target`,
          });
          info.skip(true, `no seeded "${key}" thread on this target`);
          return "/";
        }
        return `/${state.environmentId}/${id}`;
      },
      ownThread: (key) => qa.thread(`${key}@${info.project.name}`),
      open: async (path) => {
        await page.goto(path);
        await page.waitForLoadState("domcontentloaded");
        // The splash screen has an image and no text; the mounted app always has some. A page that
        // stays on the splash is a failure worth naming, so this wait is the only generous one.
        await expect(page.locator("body")).toContainText(/\S/, { timeout: 45_000 });
        const bootFailed = page.getByRole("heading", { name: "T3 Code failed to start" });
        if (await bootFailed.isVisible()) {
          throw new Error(
            `The app showed "T3 Code failed to start" on ${path}. Console: ${consoleErrors.slice(0, 3).join(" | ")}`,
          );
        }
      },
      only: (viewport) => {
        const skip = (viewport === "phone") !== qa.phone;
        if (skip) info.annotations.push({ type: "not-applicable", description: viewport });
        info.skip(skip, `only runs at ${viewport} width`);
      },
      shot: async (name, options = {}) => {
        const target = options.page ?? page;
        const dir = NodePath.join(REPORT_DIR, featureOf(info));
        NodeFS.mkdirSync(dir, { recursive: true });
        await target.screenshot({
          path: NodePath.join(dir, `${info.project.name}--${name}.png`),
          animations: "disabled",
          caret: "hide",
        });
        // A visual compare needs a baseline made on the same machine image: fonts and the browser
        // build change pixels. Without one it is reported as pending, never as a pass or a failure.
        const baseline = NodePath.join(
          import.meta.dirname,
          "baselines",
          process.env.T3_QA_BASELINES ?? "ci",
          info.project.name,
          `${featureOf(info)}--${name}.png`,
        );
        if (
          options.visual === true &&
          !NodeFS.existsSync(baseline) &&
          process.env.T3_QA_UPDATE_BASELINES !== "1"
        ) {
          info.annotations.push({ type: "baseline-pending", description: name });
        } else if (options.visual === true) {
          await expect(target).toHaveScreenshot(`${featureOf(info)}--${name}.png`, {
            mask: (options.mask ?? []).map((selector) => target.locator(selector)),
            animations: "disabled",
            caret: "hide",
          });
        }
      },
    };
    await use(qa);
    // A page that throws while a feature is exercised is a bug even if the assertions passed.
    expect(pageErrors, "uncaught page errors").toEqual([]);
  },
});

/**
 * One test per feature id from features.ts, run in every viewport and color scheme.
 * `check-map.ts` fails when a spec names an id the map does not have, or a map entry has no spec.
 */
export const feature = (
  id: string,
  title: string,
  run: (context: { page: Page; qa: Qa }) => Promise<void>,
) =>
  test(
    `${id}: ${title}`,
    { annotation: { type: "feature", description: id } },
    async ({ page, qa }) => {
      await run({ page, qa });
    },
  );
