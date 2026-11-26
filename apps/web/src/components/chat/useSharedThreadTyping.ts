import { TYPING_TTL_MS, typingLabel, type EnvironmentId, type Founder } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { Thread } from "../../types";

const REPORT_DEBOUNCE_MS = 200;
const REPORT_HEARTBEAT_MS = 2_000;

/**
 * On a shared thread, tell the server this founder is typing while the draft changes, and
 * read who else is. The local founder is hidden. A draft left alone goes quiet on its own.
 */
export function useSharedThreadTyping(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
  prompt: string,
): string | null {
  const self = useClientSettings((state) => state.founderInboxOwner);
  const report = useOrchestrationCommand(orchestrationEnvironment.v2.reportTyping, {
    reportFailure: false,
  });
  const shared = thread?.source.inbox?.audience === "shared";
  const threadId = thread?.id;
  const reportTyping = useEffectEvent(
    (typingThreadId: NonNullable<typeof threadId>, typing: boolean) =>
      report({ environmentId, input: { threadId: typingThreadId, typing } }),
  );
  const { data } = useEnvironmentQuery(
    shared && threadId ? orchestrationEnvironment.v2.typing({ environmentId, input: {} }) : null,
  );
  const reportingRef = useRef(false);
  const lastEditRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server this founder is typing while the draft changes
  useEffect(() => {
    if (!shared || threadId === undefined) return;
    const text = prompt.trim();
    if (text.length === 0) {
      if (!reportingRef.current) return;
      reportingRef.current = false;
      void reportTyping(threadId, false);
      return;
    }
    lastEditRef.current = Date.now();
    const send = () => {
      reportingRef.current = true;
      void reportTyping(threadId, true);
    };
    const debounce = window.setTimeout(send, REPORT_DEBOUNCE_MS);
    const heartbeat = window.setInterval(() => {
      if (Date.now() - lastEditRef.current < TYPING_TTL_MS) send();
    }, REPORT_HEARTBEAT_MS);
    return () => {
      window.clearTimeout(debounce);
      window.clearInterval(heartbeat);
    };
  }, [prompt, shared, threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the typing report when the thread changes or unmounts
  useEffect(() => {
    return () => {
      if (!reportingRef.current || threadId === undefined) return;
      reportingRef.current = false;
      void reportTyping(threadId, false);
    };
  }, [threadId]);

  const founders = ((threadId ? data?.[threadId] : undefined) ?? []).filter(
    (founder): founder is Founder => founder !== self,
  );
  return typingLabel(founders);
}
