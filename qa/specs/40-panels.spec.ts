import type { Page } from "playwright/test";

import { expect, feature } from "../fixtures.ts";

// Panel state is saved by the server, so a run can start with a panel already open: ask for a
// state, never toggle blindly.
const openRight = async (page: Page) => {
  const panel = page.getByRole("region", { name: /^Workspace panel/ }).first();
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: "Toggle right panel" }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
};

const openSurface = async (page: Page, name: "Files" | "Browser" | "Diff") => {
  await openRight(page);
  const surface = page.getByRole("region", { name: `Workspace panel: ${name}` });
  if (await surface.isVisible()) return surface;
  await page.getByRole("button", { name: "Add panel surface" }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name} `) }).click();
  await expect(surface).toBeVisible();
  return surface;
};

feature("panel.right", "right panel opens and closes", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const panel = await openRight(page);
  await qa.shot("open");
  // On a phone the panel is a modal sheet that covers its own toggle.
  if (qa.phone) await page.keyboard.press("Escape");
  else await page.getByRole("button", { name: "Toggle right panel" }).click();
  await expect(panel).toBeHidden();
});

feature("panel.files", "files tab lists and previews", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  await openSurface(page, "Files");
  await expect(page.getByRole("tree")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /README/ })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "src" })).toBeVisible();
  await page.getByRole("treeitem", { name: /README/ }).click();
  await expect(page.getByText("A project for the feature QA suite.").first()).toBeVisible();
  await qa.shot("files");
});

feature("panel.diff", "diff panel opens", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const diff = page.getByRole("region", { name: /Workspace panel: Diff/ });
  if (!(await diff.isVisible())) await page.keyboard.press("ControlOrMeta+d");
  await expect(diff).toBeVisible();
  await expect(page.getByText("No net changes in this selection.")).toBeVisible();
  await qa.shot("diff");
});

feature("panel.browser", "browser tab shows its URL bar", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  await openSurface(page, "Browser");
  await expect(page.getByRole("textbox", { name: "Search or enter URL" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await qa.shot("browser");
});

feature("terminal.drawer", "terminal drawer opens and closes", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const toggle = page.getByRole("button", { name: "Toggle terminal drawer" });
  await toggle.click();
  const terminal = page
    .getByRole("region", { name: /terminal/i })
    .or(page.locator(".xterm"))
    .first();
  await expect(terminal).toBeVisible();
  await qa.shot("terminal");
  await toggle.click();
  await expect(terminal).toBeHidden();
});

feature("palette.open", "palette finds a thread and opens it", async ({ page, qa }) => {
  await qa.open("/");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
  await input.fill("QA todo");
  await expect(page.getByRole("option", { name: /QA todo list/ }).first()).toBeVisible();
  await qa.shot("palette");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "QA todo list" })).toBeVisible();
});

feature("palette.add-project", "add project options", async ({ page, qa }) => {
  await qa.open("/");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
  await input.fill("Add project");
  await page
    .getByRole("option", { name: /Add project/ })
    .first()
    .click();
  await expect(
    page.getByText(/Add existing project|Clone from a remote URL/).first(),
  ).toBeVisible();
  await qa.shot("add-project");
});
