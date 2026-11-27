// @effect-diagnostics nodeBuiltinImport:off - Playwright's runner owns this process, outside the server's Effect runtime.
import * as NodePath from "node:path";

import { defineConfig } from "playwright/test";

import { AUTH_FILE } from "./run-state.ts";

const remote = process.env.T3_QA_BASE_URL;
const chromium = process.env.T3_QA_CHROMIUM;
const cfId = process.env.CF_ACCESS_CLIENT_ID;
const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET;

const viewport = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

const variant = (size: keyof typeof viewport, colorScheme: "light" | "dark") => ({
  name: `${size}-${colorScheme}`,
  use: { ...viewport[size], colorScheme },
});

export default defineConfig({
  testDir: ".",
  testMatch: "specs/**/*.spec.ts",
  globalSetup: "./global-setup.ts",
  // One app and one database serve the whole run, so specs share it one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" },
  },
  // Baselines are per machine image: fonts and the browser build change pixels. CI and local
  // runs name their own set; see docs/FEATURES.md.
  snapshotPathTemplate: NodePath.join(
    "baselines",
    process.env.T3_QA_BASELINES ?? "ci",
    "{projectName}",
    "{arg}{ext}",
  ),
  outputDir: "test-results",
  reporter: [["list"], ["json", { outputFile: NodePath.join("test-results", "results.json") }]],
  use: {
    baseURL: remote ?? undefined,
    storageState: AUTH_FILE,
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "off",
    extraHTTPHeaders:
      cfId && cfSecret ? { "CF-Access-Client-Id": cfId, "CF-Access-Client-Secret": cfSecret } : {},
    launchOptions: {
      ...(chromium ? { executablePath: chromium } : {}),
      args: ["--no-sandbox"],
    },
  },
  projects: [
    variant("desktop", "light"),
    variant("phone", "light"),
    variant("desktop", "dark"),
    variant("phone", "dark"),
  ],
});
