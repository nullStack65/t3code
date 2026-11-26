import {
  autoAddLinkState,
  knownEnvironmentRows,
  type KnownEnvironmentRow,
  linkedEnvironmentsToAutoAdd,
  reachesOverLoopback,
} from "@t3tools/client-runtime/link-request";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { useEffect, useEffectEvent } from "react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useEnvironments } from "./environments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  addingLinkedEnvironmentsAtom,
  addLinkedEnvironmentToApp,
  peerLinkEnvironment,
  usePeerLinkHosts,
} from "./peerLinks";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentsWithScope } from "./session";

/**
 * Every environment `environmentId` knows, from one list it owns: its links and the
 * connections its clients' apps hold, each with why it is on one side only. Joined with
 * whether this client holds and reaches each. Settings and the sidebar read it.
 */
export function useKnownEnvironments(environmentId: EnvironmentId | null): {
  readonly rows: ReadonlyArray<KnownEnvironmentRow>;
  readonly error: string | null;
  readonly loading: boolean;
  readonly isPending: boolean;
  readonly refresh: () => void;
} {
  const gt = useGT();
  const resolve = useMessages();
  const { environments } = useEnvironments();
  const known = useEnvironmentQuery(
    environmentId === null ? null : peerLinkEnvironment.environments({ environmentId, input: {} }),
  );
  const host = environments.find((environment) => environment.environmentId === environmentId);
  return {
    rows: knownEnvironmentRows(
      known.data?.environments ?? [],
      environments,
      {
        label: host?.label ?? gt("That environment"),
        onHostMachine: host !== undefined && reachesOverLoopback(host),
      },
      resolve,
    ),
    error: known.error,
    loading: environmentId !== null && !known.data,
    isPending: known.isPending,
    refresh: known.refresh,
  };
}

/** Shared with the Linked environments panel, so either one's read counts for both. */
export const linkedEnvironmentsRefreshKey = (environmentId: EnvironmentId) =>
  `linked-environments:${environmentId}`;

// The link state each (host, machine) add last failed at. Each try spends a single-use code.
const autoAddFailures = new Map<string, string>();

/**
 * Adds the machines connected hosts link, but this app lacks, without a click. Runs when a
 * host's list changes. Nothing tells this client a peer came online, so each host's list is read
 * again on returning to the app or a network change, at most once per stale time, never on a timer.
 */
export function AutoAddLinkedEnvironments() {
  const hosts = usePeerLinkHosts();
  // Adding mints a pairing link on the host's behalf, which needs write access there.
  const writable = useEnvironmentsWithScope(hosts, AuthAccessWriteScope);
  return hosts
    .filter((host) => writable.has(host.environmentId))
    .map((host) => (
      <AutoAddFromHost
        key={host.environmentId}
        hostId={host.environmentId}
        hostLabel={host.label}
      />
    ));
}

function AutoAddFromHost({
  hostId,
  hostLabel,
}: {
  readonly hostId: EnvironmentId;
  readonly hostLabel: string;
}) {
  const known = useKnownEnvironments(hostId);
  // Listing probes every linked machine, so this rides return and reconnect events only.
  useLiveRefresh(
    () => {
      if (!known.isPending) known.refresh();
    },
    { key: linkedEnvironmentsRefreshKey(hostId), intervalMs: null, refreshOnReconnect: true },
  );
  const { environments, isReady } = useEnvironments();
  // Until both load, a held or dismissed machine would look addable.
  const settingsReady = useClientSettingsHydrated();
  const dismissed = useClientSettings((settings) => settings.dismissedLinkedEnvironmentIds);
  const ready = isReady && settingsReady && !known.loading;
  const run = useEffectEvent((_snapshot: string) => {
    if (!ready) return;
    const { add, forget } = linkedEnvironmentsToAutoAdd({
      hostId,
      rows: known.rows,
      catalog: new Set(environments.map((environment) => environment.environmentId)),
      dismissed: new Set(dismissed),
      // Read now, not at render: an add another host started this commit is already in it.
      adding: appAtomRegistry.get(addingLinkedEnvironmentsAtom),
      failed: autoAddFailures,
    });
    for (const key of forget) autoAddFailures.delete(key);
    for (const { row, key, linkState } of add) {
      void addLinkedEnvironmentToApp(hostId, row).then((outcome) => {
        if (outcome._tag !== "Added") {
          // It stays offered under Linked environments, where the user can add it by hand.
          autoAddFailures.set(key, linkState);
          return;
        }
        autoAddFailures.delete(key);
        toastManager.add({
          type: "success",
          title: m(msg("{label} added from {host}'s links", { label: row.label, host: hostLabel })),
          ...(outcome.access === "read-only"
            ? { description: m(msg("Read-only: the link allows no more.")) }
            : {}),
        });
      });
    }
  });
  const snapshot = JSON.stringify([
    ready,
    dismissed,
    environments.map((environment) => environment.environmentId),
    known.rows.map((row) => [
      row.environmentId,
      row.action,
      row.appAddress,
      row.link === null ? null : autoAddLinkState(row.link),
    ]),
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- adds machines this host links, outside React, when its list, the catalog or the dismissals change
  useEffect(() => run(snapshot), [snapshot]);
  return null;
}
