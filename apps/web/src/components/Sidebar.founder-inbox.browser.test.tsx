import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  makeThreadInbox,
  type Founder,
  type LocalApi,
  type LinkedSidebarResult,
  type LinkedSidebarThread,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "../hooks/useSettings";
import appCss from "../index.css?inline";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { linkedSidebarByHostAtom } from "../state/linkedSidebar";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../localApi", { spy: true });

const environments = ["primary-mac-laptop", "primary-r720", "primary-asus", "omarcy-desktop"].map(
  (label) => ({ environmentId: EnvironmentId.make(label), label }),
);

const projectId = ProjectId.make("company");
const fixtureTime = "2026-11-22T00:00:00.000Z";

function standingBot(
  name: string,
  audience: Founder | "shared" | "agent-only",
): LinkedSidebarThread {
  return {
    inbox: makeThreadInbox({
      actor: { kind: "agent", id: `standing-${name}` },
      routing: {
        owner: audience === "jeff" || audience === "kameron" ? audience : null,
        audience,
        attentionKind: "background",
      },
    }),
    standing: { name, accent: "sky", avatarId: "bolt", role: null },
    threadId: ThreadId.make(`standing-${name}`),
    projectId,
    title: name,
    createdBy: "agent",
    creationSource: "mcp",
    status: "idle",
    latestRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    parentThreadId: null,
    relationshipToParent: null,
    itemCount: 1,
    createdAt: fixtureTime,
    updatedAt: fixtureTime,
  };
}

it.each(["jeff", "kameron"] as const)(
  "%s sees their own and Shared Bots, readable filters, and the correct reset",
  async (owner) => {
    using setup = new DisposableStack();
    __resetClientSettingsPersistenceForTests();
    setup.defer(__resetClientSettingsPersistenceForTests);
    const previousLinks = appAtomRegistry.get(linkedSidebarByHostAtom);
    setup.defer(() => appAtomRegistry.set(linkedSidebarByHostAtom, previousLinks));
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    setup.defer(() => style.remove());
    await page.viewport(1280, 800);
    const shared = ["CEO", "CFO", "CTO", "Product Designer", "Growth"];
    const childName = "Delegated CEO research";
    const linkedEnvironments = environments.map((environment, index) => ({
      ...environment,
      projects: [
        {
          id: projectId,
          title: "Company",
          workspaceRoot: "/projects/company",
          defaultModelSelection: null,
          createdAt: fixtureTime,
          updatedAt: fixtureTime,
          deletedAt: null,
          scripts: [],
        },
      ],
      threads: [
        ...shared
          .filter((_, i) => i % environments.length === index)
          .map((name) => standingBot(name, "shared")),
        ...(index === 0 ? [standingBot("CoS", "kameron")] : []),
        ...(index === 3
          ? [standingBot("CoS (Jeff)", "jeff"), standingBot("Personal Finance", "jeff")]
          : []),
        ...(index === 0
          ? [
              {
                ...standingBot(childName, "agent-only"),
                parentThreadId: ThreadId.make("standing-CEO"),
              },
            ]
          : []),
      ],
    }));
    const links: LinkedSidebarResult = { environments: linkedEnvironments };
    appAtomRegistry.set(linkedSidebarByHostAtom, new Map([[EnvironmentId.make("local"), links]]));
    const persist = vi
      .fn<LocalApi["persistence"]["setClientSettings"]>()
      .mockResolvedValue(undefined);
    using _localApi = vi.spyOn(await import("../localApi"), "ensureLocalApi").mockReturnValue({
      persistence: {
        getClientSettings: async () => ({
          ...DEFAULT_CLIENT_SETTINGS,
          founderInboxOwner: owner,
          founderInboxFilter: [owner],
        }),
        setClientSettings: persist,
      },
    } as unknown as LocalApi);
    await ensureClientSettingsHydrated();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider style={{ height: 750 }}>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    const mine = screen.getByRole("region", { name: "My Bots" });
    const company = screen.getByRole("region", { name: "Shared Bots" });
    const jeff = owner === "jeff";
    for (const name of jeff ? ["CoS (Jeff)", "Personal Finance"] : ["CoS"]) {
      await expect.element(mine.getByText(name, { exact: true })).toBeVisible();
    }
    for (const name of jeff ? ["CoS"] : ["CoS (Jeff)", "Personal Finance"]) {
      await expect.element(screen.getByText(name, { exact: true })).not.toBeInTheDocument();
    }
    for (const name of shared) {
      await expect.element(company.getByText(name, { exact: true })).toBeVisible();
    }

    const open = () => screen.getByRole("button", { name: /^Filter threads by inbox/ }).click();
    await open();
    const menu = page.getByRole("menu");
    const inboxes = menu.getByRole("group", { name: "Inbox" });
    const agents = inboxes.getByRole("menuitemcheckbox", { name: /^Agents,/ });
    const personal = inboxes.getByRole("menuitemcheckbox", { name: jeff ? /^Jeff,/ : /^Kameron,/ });
    const sharedInbox = inboxes.getByRole("menuitemcheckbox", { name: /^Shared,/ });
    await expect.element(personal).toHaveAttribute("aria-checked", "true");
    await expect.element(sharedInbox).toHaveAttribute("aria-checked", "true");
    await expect.element(agents).toHaveAttribute("aria-checked", "false");
    const labels = [
      "Kameron",
      "Kameron's agents",
      "Jeff's agents",
      "Unknown",
      "Shared",
      ...environments.map(({ label }) => label),
    ];
    for (const width of [1280, 360]) {
      await page.viewport(width, 800);
      await expect.element(menu).toBeVisible();
      await vi.waitFor(() => {
        const popup = menu.element().getBoundingClientRect();
        expect(popup.left).toBeGreaterThanOrEqual(0);
        expect(popup.right).toBeLessThanOrEqual(width);
        for (const label of labels) {
          const matches = menu.getByText(label, { exact: true }).elements();
          expect(matches.length, label).toBeGreaterThan(0);
          for (const element of matches) {
            expect(element.scrollWidth, label).toBeLessThanOrEqual(element.clientWidth);
          }
        }
      });
    }
    await page.viewport(1280, 800);
    await agents.click();
    await expect.element(agents).toHaveAttribute("aria-checked", "true");
    await expect.element(mine.getByText(childName, { exact: true })).not.toBeInTheDocument();
    await expect.element(company.getByText(childName, { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText(childName, { exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Reset to default" }).click();
    await vi.waitFor(() =>
      expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ founderInboxFilter: [] })),
    );
    await open();
    await expect.element(personal).toHaveAttribute("aria-checked", "true");
    await expect.element(sharedInbox).toHaveAttribute("aria-checked", "true");
    await expect.element(agents).toHaveAttribute("aria-checked", "false");
  },
);
