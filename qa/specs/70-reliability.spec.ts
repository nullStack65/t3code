import { expect, feature } from "../fixtures.ts";

feature(
  "layout.boot-recovery",
  "a failed entry chunk heals itself with reloads",
  async ({ page, qa }) => {
    let documents = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) documents++;
    });
    // The network flapping, as a Wi-Fi, tunnel or tailnet change does: the first document and the
    // first automatic reload (two documents) both fail to fetch the entry chunk, the next reload can.
    await page.route(/\/assets\/main-[^/]+\.js$/, (route) =>
      documents <= 2 ? route.abort("failed") : route.continue(),
    );
    await page.goto("/");
    await expect(
      page
        .getByRole("navigation", { name: "Threads" })
        .or(page.getByRole("button", { name: "Toggle main sidebar" }))
        .first(),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("heading", { name: "T3 Code failed to start" })).toBeHidden();
    expect(documents).toBeGreaterThanOrEqual(3);
    await qa.shot("recovered");
  },
);
