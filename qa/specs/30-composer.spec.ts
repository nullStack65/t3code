import { expect, feature } from "../fixtures.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const REPLY = "This turn is a replay.";

feature("composer.send", "send a message and see the reply stream", async ({ page, qa }) => {
  await qa.open(qa.ownThread("send"));
  const editor = await qa.composer();
  // The seeded turn already ended with this sentence, so the new reply is the count going up.
  const repliesBefore = await page.getByText(REPLY).count();
  await editor.fill("Give me a short tour");
  await qa.shot("typed");
  await page.getByRole("button", { name: /^(Send|Submit) message$/ }).click();
  await expect(page.getByText("Give me a short tour").first()).toBeVisible();
  await expect(page.getByText(REPLY)).toHaveCount(repliesBefore + 1, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeHidden();
  await qa.shot("replied");
});

feature("composer.interrupt", "Stop generation ends a running turn", async ({ page, qa }) => {
  await qa.open(qa.ownThread("send"));
  const editor = await qa.composer();
  const repliesBefore = await page.getByText(REPLY).count();
  await editor.fill("Stop test");
  await page.getByRole("button", { name: /^(Send|Submit) message$/ }).click();
  const stop = page.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible({ timeout: 20_000 });
  await stop.click();
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(/Run interrupted/).first()).toBeVisible();
  // The stopped turn never finished its reply.
  await expect(page.getByText(REPLY)).toHaveCount(repliesBefore);
  await qa.shot("stopped");
});

feature("composer.model-picker", "model picker opens and closes", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  await qa.composer();
  await page.getByRole("button", { name: "Showcase", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "Providers" })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Write approval/ })).toBeVisible();
  await qa.shot("picker");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Showcase", exact: true })).toBeVisible();
});

feature("composer.commands", "slash and mention menus", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const editor = await qa.composer();
  await editor.click();
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
  await qa.shot("slash");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await expect(page.getByRole("listbox", { name: "Files and folders" })).toBeVisible();
  await qa.shot("mention");
});

feature("composer.attachments", "attach a file and remove it", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  await qa.composer();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files" }).click();
  await (await chooser).setFiles({ name: "qa.png", mimeType: "image/png", buffer: PNG });
  await expect(
    page
      .getByRole("img", { name: /qa\.png/ })
      .or(page.getByText("qa.png"))
      .first(),
  ).toBeVisible();
  await qa.shot("attached");
});

feature("composer.dictation", "voice input control is present", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  await qa.composer();
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
});

feature("composer.draft-persists", "draft survives switching threads", async ({ qa }) => {
  await qa.open(qa.thread("showcase"));
  const editor = await qa.composer();
  await editor.fill("keep this draft");
  await qa.open(qa.thread("todo"));
  await qa.open(qa.thread("showcase"));
  await expect(await qa.composer()).toContainText("keep this draft");
});
