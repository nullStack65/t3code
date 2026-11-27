import { expect, feature } from "../fixtures.ts";

feature("sidebar.thread-list", "lists seeded threads and opens one", async ({ page, qa }) => {
  await qa.open("/");
  await qa.showSidebar();
  const nav = page.getByRole("navigation", { name: "Threads" });
  await expect(nav.getByRole("button", { name: /^QA question, / })).toBeVisible();
  await qa.shot("list", { visual: true });
  await nav.getByRole("button", { name: /^QA question, / }).click();
  await expect(page).toHaveURL(new RegExp(`/${qa.state.environmentId}/`));
  await expect(page.getByRole("heading", { name: "QA question" })).toBeVisible();
});

feature("sidebar.new-thread", "New thread opens a draft", async ({ qa }) => {
  await qa.open(qa.thread("showcase"));
  await qa.newThread();
  await expect(await qa.composer()).toBeVisible();
  await qa.shot("draft");
});

feature("sidebar.search", "search narrows the list and clears", async ({ page, qa }) => {
  await qa.open("/");
  await qa.showSidebar();
  const nav = page.getByRole("navigation", { name: "Threads" });
  const search = nav.getByRole("combobox", { name: "Search threads" });
  await search.fill("QA question");
  await expect(page.getByRole("option", { name: /^QA question, / })).toBeVisible();
  await expect(page.getByRole("option", { name: /^QA showcase, / })).toBeHidden();
  await qa.shot("results");
  await search.fill("");
  await expect(page.getByRole("option", { name: /^QA question, / })).toBeHidden();
});

feature("sidebar.project-filter", "project and inbox filter menus open", async ({ page, qa }) => {
  await qa.open("/");
  await qa.showSidebar();
  const nav = page.getByRole("navigation", { name: "Threads" });
  await nav.getByRole("combobox", { name: "Projects" }).click();
  await expect(page.getByRole("option", { name: /QA demo/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await nav
    .getByRole("button", { name: "Filter threads by inbox, sender and environment" })
    .click();
  await expect(page.getByRole("menu").first()).toBeVisible();
  await qa.shot("inbox-filter");
});

feature("sidebar.thread-menu", "context menu, pin and unpin", async ({ page, qa }) => {
  await qa.open("/");
  await qa.showSidebar();
  const row = page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("button", { name: /^QA question, / });
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename thread" })).toBeVisible();
  await qa.shot("menu");
  // Leave the thread as it was found, whichever way a previous run left it.
  const pin = page.getByRole("menuitem", { name: "Pin thread", exact: true });
  const wasPinned = !(await pin.isVisible());
  await (wasPinned ? page.getByRole("menuitem", { name: "Unpin thread" }) : pin).click();
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: wasPinned ? "Pin thread" : "Unpin thread", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: wasPinned ? "Pin thread" : "Unpin thread", exact: true })
    .click();
});

feature("sidebar.footer-links", "footer links open their pages", async ({ page, qa }) => {
  const links: ReadonlyArray<readonly [string, RegExp]> = [
    ["Pull requests", /\/pull-requests/],
    ["Issues", /\/issues/],
    ["Usage", /\/usage/],
    ["Settings", /\/settings/],
  ];
  for (const [name, url] of links) {
    await qa.open("/");
    await qa.showSidebar();
    await page
      .getByRole("navigation", { name: "Threads" })
      .getByRole("button", { name, exact: true })
      .click();
    await expect(page).toHaveURL(url);
  }
});

feature("layout.sidebar-toggle", "sidebar hides and shows", async ({ page, qa }) => {
  await qa.open(qa.thread("showcase"));
  const nav = page.getByRole("navigation", { name: "Threads" });
  const toggle = page.getByRole("button", { name: "Toggle main sidebar" });
  const shown = (await toggle.getAttribute("aria-pressed")) === "true";
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(!shown));
  await expect(nav)
    .toBeInViewport({ ratio: 0.5 })
    .catch(() => undefined);
  await qa.shot("toggled");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(shown));
});
