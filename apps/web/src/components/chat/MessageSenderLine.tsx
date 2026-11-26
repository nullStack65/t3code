import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, Founder, RunId } from "@t3tools/contracts";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import {
  founderSenderBadge,
  messageSenderDetail,
  messageSenderLabel,
  type MessageSender,
} from "@t3tools/client-runtime/message-sender";
import { useMessages } from "gt-react";

import {
  brandProviderInstanceEntries,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { getTriggerDisplayModelName } from "./providerIconUtils";

/** "Kameron · Work laptop", "Unknown sender", or "Claude · Opus 5.5": who wrote the message. */
export function MessageSenderLine({
  sender,
  align,
}: {
  readonly sender: MessageSender;
  readonly align: "start" | "end";
}) {
  const m = useMessages();
  const label = messageSenderLabel(sender, undefined, m);
  const detail = messageSenderDetail(sender);
  return (
    <p
      className={
        align === "end"
          ? "me-1 text-2xs text-muted-foreground/80"
          : "mt-1 text-2xs text-muted-foreground/80"
      }
      data-message-sender={sender.kind}
    >
      <span className="font-medium">{label}</span>
      {detail === null ? null : <span> · {detail}</span>}
    </p>
  );
}

/** The provider and model of the run behind an assistant message, by their names in the picker. */
export function useRunModelSender(
  environmentId: EnvironmentId,
  runs: ReadonlyArray<HandoffTimelineRun>,
  runId: RunId | null,
): MessageSender {
  const run = runId === null ? undefined : runs.find((candidate) => candidate.id === runId);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providersAtom = serverEnvironment.providersValueAtom(environmentId);
  const entryOf = (providers: Parameters<typeof deriveProviderInstanceEntries>[0] | null) => {
    if (run === undefined) return undefined;
    const derived = deriveProviderInstanceEntries(providers ?? []);
    const entries = settings ? brandProviderInstanceEntries(derived, settings) : derived;
    return entries.find((candidate) => candidate.instanceId === run.modelSelection.instanceId);
  };
  // Select strings: provider status pushes replace the list even when names are unchanged.
  const provider = useAtomValue(providersAtom, (providers) => {
    if (run === undefined) return null;
    return entryOf(providers)?.displayName ?? run.modelSelection.instanceId;
  });
  const model = useAtomValue(providersAtom, (providers) => {
    if (run === undefined) return null;
    const entry = entryOf(providers);
    const known = entry?.models.find((candidate) => candidate.slug === run.modelSelection.model);
    return known === undefined
      ? run.modelSelection.model
      : getTriggerDisplayModelName(known, entry?.driverKind);
  });
  return { kind: "model", provider, model };
}

/** Kameron or Jeff, on a person's message in a shared thread. */
export function FounderSenderBadge({ founder }: { readonly founder: Founder }) {
  const badge = founderSenderBadge(founder);
  const tint = founder === "kameron" ? "bg-foreground/15" : "bg-foreground/40";
  return (
    <p
      className="me-1 flex items-center justify-end gap-1.5 text-2xs text-muted-foreground/80"
      data-founder-badge={founder}
    >
      <span
        aria-hidden
        className={`flex size-4 items-center justify-center rounded-full text-2xs font-medium text-foreground ${tint}`}
      >
        {badge.initial}
      </span>
      <span className="font-medium">{badge.name}</span>
    </p>
  );
}
