import {
  knownEnvironmentRows,
  type KnownEnvironmentRow,
  reachesOverLoopback,
} from "@t3tools/client-runtime/link-request";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments } from "./environments";
import { peerLinkEnvironment } from "./peerLinks";
import { useEnvironmentQuery } from "./query";

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
  const { environments } = useEnvironments();
  const known = useEnvironmentQuery(
    environmentId === null ? null : peerLinkEnvironment.environments({ environmentId, input: {} }),
  );
  const host = environments.find((environment) => environment.environmentId === environmentId);
  return {
    rows: knownEnvironmentRows(known.data?.environments ?? [], environments, {
      label: host?.label ?? "That environment",
      onHostMachine: host !== undefined && reachesOverLoopback(host),
    }),
    error: known.error,
    loading: environmentId !== null && !known.data,
    isPending: known.isPending,
    refresh: known.refresh,
  };
}
