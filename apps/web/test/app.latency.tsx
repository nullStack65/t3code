import { createMemoryHistory } from "@tanstack/react-router";
import type { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import "~/components/ChatView";

import * as React from "react";
import { createRoot } from "react-dom/client";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter, type AppRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "./fakeEnvironment";
import { expectWithinBudget, settle, timeInteraction } from "./interactionLatency";

vi.mock("../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("./fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const HISTORY_TURNS = 20;
const SWITCH = ["latency-a", "latency-b"].map((name) => threadWithHistory(name, HISTORY_TURNS));
const SEND = [0, 1, 2, 3, 4].map((index) =>
  threadWithHistory(`latency-send-${index}`, HISTORY_TURNS),
);
const [A, B] = SWITCH.map((thread) => thread.id) as [ThreadId, ThreadId];

installFakeEnvironment([...SWITCH, ...SEND], { acceptCommands: true });
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;
const lastAnswer = (threadId: ThreadId) => `Answer ${HISTORY_TURNS - 1} for ${threadId}.`;
const bodyText = () => document.body.textContent ?? "";
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const composerEditor = () => document.querySelector('[data-testid="composer-editor"]');

async function mountApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  document.body.append(container);
  const root = createRoot(container);
  root.render(<AppRoot router={router} />);
  return {
    router,
    [Symbol.dispose]() {
      root.unmount();
      container.remove();
    },
  };
}

const threadOpen = (router: AppRouter, threadId: ThreadId) => () =>
  router.state.location.pathname === threadPath(threadId) &&
  bodyText().includes(lastAnswer(threadId)) &&
  composerEditor() !== null;

async function openThread(threadId: ThreadId) {
  const app = await mountApp(threadPath(threadId));
  await expect.element(page.getByText(lastAnswer(threadId))).toBeVisible();
  await settle();
  return app;
}

const goToThread = (router: AppRouter, threadId: ThreadId) =>
  router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENVIRONMENT_ID, threadId },
  });

it("warm up on production React", async () => {
  expect(
    React.act,
    "run through `vp run test:latency`, which sets NODE_ENV=production",
  ).toBeUndefined();
  using _app = await openThread(A);
  await document.fonts.ready;
  await settle();
});

it("app launch: mounting the app shows the open thread and its composer", async () => {
  await expectWithinBudget(
    "app launch (mount to an open thread)",
    async () => {
      let app: Awaited<ReturnType<typeof mountApp>> | undefined;
      const elapsed = await timeInteraction(
        async () => {
          app = await mountApp(threadPath(B));
        },
        () => app !== undefined && threadOpen(app.router, B)(),
        { from: "call" },
      );
      app?.[Symbol.dispose]();
      return elapsed;
    },
    { knownOverBudget: true },
  );
});

it("thread switch: clicking a sidebar row shows that thread", async () => {
  using app = await openThread(A);
  await expectWithinBudget(
    "thread switch",
    async (index) => {
      const target = index % 2 === 0 ? B : A;
      await settle();
      return timeInteraction(
        () => userEvent.click(page.getByText(`Thread ${target}`, { exact: true }).first()),
        threadOpen(app.router, target),
      );
    },
    { knownOverBudget: true },
  );
});

it("composer send: Enter puts the message in the thread", async () => {
  using app = await openThread(SEND[0]!.id);
  await expectWithinBudget("composer send", async (index) => {
    const thread = SEND[index]!.id;
    await goToThread(app.router, thread);
    await expect.element(page.getByText(lastAnswer(thread))).toBeVisible();
    const prompt = `latency prompt ${index}`;
    const editor = page.getByTestId("composer-editor");
    await userEvent.click(editor);
    await userEvent.keyboard(prompt);
    await expect.element(editor).toHaveTextContent(prompt);
    await settle();
    return timeInteraction(
      () => userEvent.keyboard("{Enter}"),
      () =>
        occurrences(bodyText(), prompt) > occurrences(composerEditor()?.textContent ?? "", prompt),
    );
  });
});
