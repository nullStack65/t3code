import { expect, feature } from "../fixtures.ts";

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["chat", "Chat"],
  ["diffs", "Diffs & pull requests"],
  ["keybindings", "Keybindings"],
  ["voice", "Voice"],
  ["snap-shot", "SnapShots"],
  ["providers", "Providers"],
  ["threads", "Threads"],
  ["browser", "Browser"],
  ["devices", "Devices"],
  ["scheduled-tasks", "Scheduled tasks"],
  ["projects", "Projects"],
  ["source-control", "Source control & issues"],
  ["worktrees", "Worktrees"],
  ["connections", "Environments"],
  ["access", "Sharing & access"],
  ["maintenance", "Maintenance"],
  ["labs", "Labs"],
  ["about", "About"],
  ["archived", "Archive"],
];

for (const [slug, label] of SECTIONS) {
  feature(`settings.${slug}`, `${label} renders`, async ({ page, qa }) => {
    await qa.open(`/settings/${slug}`);
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("navigation", { name: "Settings breadcrumb" })).toContainText(
      label,
    );
    await expect(dialog.getByRole("heading").first()).toBeVisible();
    await qa.shot(slug, { visual: ["general", "appearance", "chat", "about"].includes(slug) });
  });
}

feature("settings.search", "search finds a setting", async ({ page, qa }) => {
  await qa.open("/settings/general");
  // A combobox in the desktop nav, a button that opens it on a phone.
  const search = page.getByRole("combobox", { name: "Search settings" });
  if (qa.phone) await page.getByRole("button", { name: "Search settings" }).click();
  await search.fill("usage limits");
  await expect(
    page.getByRole("option", { name: /Resume after usage limits/i }).first(),
  ).toBeVisible();
  await qa.shot("search");
});

feature("settings.auto-resume", "toggle auto-resume and persist it", async ({ page, qa }) => {
  await qa.open("/settings/threads");
  const toggle = () => page.getByRole("switch", { name: "Resume after usage limits" });
  await expect(toggle()).toBeVisible();
  const before = await toggle().getAttribute("aria-checked");
  await toggle().click();
  await expect(toggle()).not.toHaveAttribute("aria-checked", before ?? "");
  await page.reload();
  await expect(toggle()).not.toHaveAttribute("aria-checked", before ?? "");
  await toggle().click();
  await expect(toggle()).toHaveAttribute("aria-checked", before ?? "");
});

feature("theme.appearance", "dark and light follow the setting", async ({ page, qa }) => {
  await qa.open("/settings/appearance");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  const html = page.locator("html");
  await page.getByRole("button", { name: "Use dark mode" }).click();
  await expect(html).toHaveClass(/dark/);
  await qa.shot("dark");
  await page.getByRole("button", { name: "Use light mode" }).click();
  await expect(html).not.toHaveClass(/dark/);
  await qa.shot("light");
  await page.getByRole("button", { name: "Follow the system appearance" }).click();
});

feature(
  "env.linked",
  "environments page shows this machine and link controls",
  async ({ page, qa }) => {
    await qa.open("/settings/connections");
    await expect(page.getByRole("heading", { name: "Environments", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add environment" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Linked environments|\d+ machines?, / }).first(),
    ).toBeVisible();
    await qa.shot("environments", { visual: true });
  },
);

feature("layout.phone", "no sideways scroll on core pages", async ({ page, qa }) => {
  qa.only("phone");
  for (const path of ["/", qa.thread("showcase"), "/settings/general"]) {
    await qa.open(path);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await qa.shot("phone");
});
