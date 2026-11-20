import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LinkedSidebarResult } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { linkedSidebarByHostAtom } from "./linkedSidebar";
import { peerLinkEnvironment, usePeerLinkHosts } from "./peerLinks";
import { environmentSummaries } from "./presentation";
import { useEnvironmentQuery } from "./query";

export function LinkedSidebarFromHosts() {
  const hosts = usePeerLinkHosts();
  return hosts.map((host) => (
    <LinkedSidebarFromHost key={host.environmentId} hostId={host.environmentId} />
  ));
}

function LinkedSidebarFromHost({ hostId }: { readonly hostId: EnvironmentId }) {
  const catalog = useAtomValue(environmentSummaries.identitiesAtom);
  const known = useEnvironmentQuery(
    peerLinkEnvironment.linkedSidebar({
      environmentId: hostId,
      input: { catalogEnvironmentIds: catalog.map((identity) => identity.environmentId) },
    }),
  );
  useLiveRefresh(
    () => {
      if (!known.isPending) known.refresh();
    },
    { key: `linked-sidebar:${hostId}`, intervalMs: null, refreshOnReconnect: true },
  );
  const publish = useEffectEvent((data: LinkedSidebarResult | null) => {
    const current = appAtomRegistry.get(linkedSidebarByHostAtom);
    if (data === null) {
      if (!current.has(hostId)) return;
      const next = new Map(current);
      next.delete(hostId);
      appAtomRegistry.set(linkedSidebarByHostAtom, next);
      return;
    }
    if (current.get(hostId) === data) return;
    const next = new Map(current);
    next.set(hostId, data);
    appAtomRegistry.set(linkedSidebarByHostAtom, next);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this host's server-side links into the sidebar when its list changes
  useEffect(() => {
    publish(known.data);
  }, [known.data]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops this host's server-side links when it disconnects
  useEffect(() => () => publish(null), []);
  return null;
}
