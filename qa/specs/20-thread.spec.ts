import { expect, feature } from "../fixtures.ts";

feature("thread.header", "breadcrumb and actions menu", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const crumb = page.getByRole("navigation", { name: "Thread breadcrumb" });
  await expect(crumb.getByRole("button", { name: "New thread in QA demo" })).toBeVisible();
  await expect(crumb.getByRole("heading", { name: "QA showcase" })).toBeVisible();
  await crumb.getByRole("button", { name: "Thread actions for QA showcase" }).click();
  await expect(page.getByRole("menu").first()).toBeVisible();
  await qa.shot("actions");
});

feature("timeline.messages", "a sent message shows in the timeline", async ({ page, qa }) => {
  await qa.open(qa.ownThread("send"));
  const editor = await qa.composer();
  await editor.fill("Timeline hello");
  await page.getByRole("button", { name: /^(Send|Submit) message$/ }).click();
  await expect(
    page.getByRole("region", { name: "Conversation" }).getByText("Timeline hello").first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeHidden({
    timeout: 30_000,
  });
  await qa.shot("timeline", { visual: false });
});

feature("timeline.approval", "approval request actions", async ({ page, qa }) => {
  await qa.open("/");
  await qa.newThread();
  await qa.composer();
  // On a phone the draft's composer can take focus and close the menu under the click, so the
  // choice is retried until the button says it took.
  await expect(async () => {
    await page.getByRole("button", { name: /^Permissions: / }).click({ timeout: 3_000 });
    await page.getByRole("menuitemradio", { name: "Supervised" }).click({ timeout: 3_000 });
    await expect(page.getByRole("button", { name: "Permissions: Supervised" })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Showcase$|^Write approval$/ }).click();
  await page.getByRole("option", { name: /^Write approval/ }).click();
  // The picker stays open after a model is chosen, so the effort choices are in reach.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: "Providers" })).toBeHidden();
  await (await qa.composer()).fill("Edit a file");
  await page.getByRole("button", { name: /^(Send|Submit) message$/ }).click();
  const approve = page.getByRole("button", { name: /^Approve/ }).first();
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Decline/ }).first()).toBeVisible();
  await qa.shot("pending");
  await approve.click();
  await expect(approve).toBeHidden();
});

feature("timeline.user-input", "agent question shows its options", async ({ page, qa }) => {
  await qa.open(qa.thread("question"));
  await expect(page.getByText(/prefer strict schemas or UI flexibility/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Strict schemas/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^UI flexibility/ })).toBeVisible();
  // Choosing an option answers the question, which would change the seeded thread for every run.
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
  await qa.shot("question");
});

feature("timeline.command-output", "command and output are readable", async ({ page, qa }) => {
  await qa.open(qa.thread("command"));
  await page
    .getByRole("button", { name: /agent updates?$/ })
    .first()
    .click();
  await expect(
    page
      .getByRole("region", { name: "Conversation" })
      .getByText("The command printed one JSON line.")
      .first(),
  ).toBeVisible();
  await qa.shot("command");
});

feature("thread.details-panel", "workspace and version control", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  // A side panel on desktop, a modal sheet on a phone.
  const details = page
    .getByRole("region", { name: "Thread details" })
    .or(page.getByRole("dialog", { name: "Thread details" }))
    .first();
  await expect(toggle).toBeVisible();
  if (!(await details.isVisible())) await toggle.click();
  await expect(details.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect(details.getByRole("region", { name: "Version Control" })).toBeVisible();
  await qa.shot("details");
});

feature("thread.find", "find in thread opens and takes a query", async ({ page, qa }) => {
  await qa.open(qa.thread("multi"));
  await page.getByRole("region", { name: "Conversation" }).click({ position: { x: 50, y: 300 } });
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("searchbox", { name: "Find in thread" });
  await expect(find).toBeVisible();
  await find.fill("Second");
  await expect(find).toHaveValue("Second");
  await expect(page.getByRole("button", { name: "Close find" })).toBeVisible();
  await qa.shot("find");
});
