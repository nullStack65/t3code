import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { render } from "../../../test/render";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

const hostId = EnvironmentId.make("mac");
const vmLink: PeerLinkSummary = {
  environmentId: EnvironmentId.make("vm"),
  label: "boat-task",
  urls: ["http://boat-task.example.ts.net:3773"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

// What the host's `peerLinks.environments` answers. The CLI and agents link machines without this client.
const server = vi.hoisted(() => ({
  links: [] as Array<PeerLinkSummary>,
  started: 0,
  interrupted: 0,
  answer: Promise.resolve(),
}));

function setup() {
  server.links = [];
  server.started = 0;
  server.interrupted = 0;
  server.answer = Promise.resolve();
}

vi.mock(import("~/state/peerLinks"), async (original) => {
  const actual = await original();
  const { Atom: AtomModule } = await import("effect/reactivity");
  const EffectModule = await import("effect/Effect");
  // The real list query's options: stale-while-revalidate, revalidating only when it is built.
  const list = AtomModule.make(
    EffectModule.gen(function* () {
      server.started += 1;
      yield* EffectModule.promise(() => server.answer);
      return {
        environments: server.links.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          urls: link.urls,
          serverVersion: null,
          link,
          inApp: false,
          issue: null,
        })),
      };
    }).pipe(
      EffectModule.onInterrupt(() =>
        EffectModule.sync(() => {
          server.interrupted += 1;
        }),
      ),
    ),
  ).pipe(AtomModule.swr({ staleTime: 10_000, revalidateOnMount: true }));
  const denied = AtomModule.make(false);
  return {
    ...actual,
    peerLinkEnvironment: {
      ...actual.peerLinkEnvironment,
      environments: (() => list) as never,
      link: { ...actual.peerLinkEnvironment.link, permissionAtom: () => denied },
      unlink: { ...actual.peerLinkEnvironment.unlink, permissionAtom: () => denied },
      addToApp: { ...actual.peerLinkEnvironment.addToApp, permissionAtom: () => denied },
    },
  };
});

/** Stands in for the sidebar, which keeps the same list loaded while Settings is closed. */
function SidebarReader() {
  const result = useAtomValue(
    peerLinkEnvironment.environments({ environmentId: hostId, input: {} }),
  );
  return AsyncResult.isSuccess(result) ? <p>Sidebar loaded</p> : null;
}

describe("LinkedEnvironmentsSettings", () => {
  it("shows a link made elsewhere while the sidebar keeps the list loaded", async () => {
    setup();
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using sidebar = await render(
      <RegistryContext.Provider value={registry}>
        <SidebarReader />
      </RegistryContext.Provider>,
    );
    await expect.element(sidebar.getByText("Sidebar loaded")).toBeVisible();

    server.links = [vmLink];
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <LinkedEnvironmentsSettings
          environmentId={hostId}
          environmentLabel={null}
          isSearchTarget={false}
        />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByRole("heading", { name: "boat-task" })).toBeVisible();
  });

  it("leaves a list that is still loading to answer", async () => {
    setup();
    // useLiveRefresh remembers each view's last read across mounts, so this view gets its own host.
    const loadingHostId = EnvironmentId.make("mac-loading");
    let answer = () => {};
    server.answer = new Promise((resolve) => {
      answer = resolve;
    });
    server.links = [vmLink];
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <LinkedEnvironmentsSettings
          environmentId={loadingHostId}
          environmentLabel={null}
          isSearchTarget={false}
        />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("status")).toBeVisible();

    answer();
    await expect.element(screen.getByRole("heading", { name: "boat-task" })).toBeVisible();
    expect(server).toMatchObject({ started: 1, interrupted: 0 });
  });
});
