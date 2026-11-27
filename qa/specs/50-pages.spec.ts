import { expect, feature } from "../fixtures.ts";

feature("page.home", "home mounts", async ({ page, qa }) => {
  await qa.open("/");
  await qa.showSidebar();
  await expect(page.getByRole("navigation", { name: "Threads" })).toBeVisible();
  await qa.shot("home", { visual: true });
});

const simple: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["page.pull-requests", "/pull-requests", /Pull requests/],
  ["page.usage", "/usage", /Usage/],
  ["page.issues", "/issues", /Issues/],
  ["page.workflows", "/workflows", /Workflows/],
];
for (const [id, path, heading] of simple) {
  feature(id, `${path} renders`, async ({ page, qa }) => {
    await qa.open(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await qa.shot("page", { visual: true });
  });
}

feature("page.new-thread-link", "prompt link opens a draft", async ({ page, qa }) => {
  await qa.open("/new?prompt=Hello%20from%20a%20link");
  await expect(page).toHaveURL(/\/draft\//, { timeout: 20_000 });
  await expect(page.getByText("Hello from a link").first()).toBeVisible();
  await qa.shot("link");
});

feature("onboard.welcome", "welcome renders", async ({ page, qa }) => {
  await qa.open("/welcome");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await qa.shot("welcome", { visual: true });
});

feature("onboard.pair", "bad token is rejected", async ({ page: signedIn, qa }) => {
  const context = await signedIn
    .context()
    .browser()!
    .newContext({
      baseURL: qa.state.origin,
      storageState: { cookies: [], origins: [] },
      viewport: signedIn.viewportSize(),
      colorScheme: "light",
    });
  const page = await context.newPage();
  await page.goto("/pair#token=not-a-real-token");
  await expect(
    page.getByText(/invalid|expired|could not|try again|not valid/i).first(),
  ).toBeVisible({ timeout: 20_000 });
  await qa.shot("rejected", { page });
  await context.close();
});
