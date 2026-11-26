import type { Founder, MessageId } from "@t3tools/contracts";
import {
  createSeenMarkerSession,
  type SeenMessage,
  type SeenTimers,
} from "@t3tools/client-runtime/seen-marker";
import { useEffect, useEffectEvent, useRef } from "react";

interface SeenRect {
  top: number;
  bottom: number;
}

export interface SeenSamplingHost {
  window: Pick<Window, "addEventListener" | "removeEventListener"> & {
    requestAnimationFrame(callback: () => void): number;
    cancelAnimationFrame(handle: number): void;
  };
  document: Pick<Document, "addEventListener" | "removeEventListener" | "hasFocus"> & {
    readonly visibilityState: DocumentVisibilityState;
  };
}

export interface SeenScrollNode {
  readonly scrollTop?: number;
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
  getBoundingClientRect(): SeenRect;
  querySelectorAll(selector: string): Iterable<{
    getBoundingClientRect(): SeenRect;
    getAttribute(name: string): string | null;
  }>;
}

export function visibleMessageIds(node: SeenScrollNode): MessageId[] {
  const viewport = node.getBoundingClientRect();
  const ids: MessageId[] = [];
  for (const element of node.querySelectorAll("[data-message-id]")) {
    const id = element.getAttribute("data-message-id");
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) ids.push(id as MessageId);
  }
  return ids;
}

const SCROLLED_TO_END_SLACK_PX = 8;

/** Reaching the bottom shows the newest message even when a collapsed group hides it from the DOM. */
function isScrolledToEnd(node: SeenScrollNode) {
  const { scrollTop, scrollHeight, clientHeight } = node;
  if (scrollTop === undefined || scrollHeight === undefined || clientHeight === undefined) {
    return false;
  }
  // A zero-height (hidden) container is not "at the bottom".
  return clientHeight > 0 && scrollHeight - scrollTop - clientHeight <= SCROLLED_TO_END_SLACK_PX;
}

export function startSeenMarkerSampling(input: {
  host: SeenSamplingHost;
  threadKey: string;
  founder?: Founder | null;
  getScrollNode: () => SeenScrollNode | null | undefined;
  getMessages: () => ReadonlyArray<SeenMessage>;
  now?: () => Date;
  timers?: SeenTimers;
  /** Stored place for this founder. A dwell on an earlier message does not replace it. */
  notBefore?: () => MessageId | null | undefined;
  onRecorded?: (messageId: MessageId, seenAt: string) => void;
}) {
  const { window: win, document: doc } = input.host;
  const session = createSeenMarkerSession({
    threadKey: input.threadKey,
    ...(input.founder === undefined ? {} : { founder: input.founder }),
    getMessages: input.getMessages,
    seenAt: () => (input.now ?? (() => new Date()))().toISOString(),
    ...(input.notBefore === undefined ? {} : { notBefore: input.notBefore }),
    ...(input.onRecorded === undefined ? {} : { onRecorded: input.onRecorded }),
    timers: input.timers ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  let frame: number | null = null;

  const sample = () => {
    const node = input.getScrollNode();
    const active = doc.visibilityState === "visible" && doc.hasFocus();
    const visibleIds =
      active && node
        ? [
            ...visibleMessageIds(node),
            ...(isScrolledToEnd(node) ? input.getMessages().map((message) => message.id) : []),
          ]
        : [];
    session.update({ active, visibleIds });
  };
  const requestSample = () => {
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      sample();
    });
  };
  const sampleNow = () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    sample();
  };
  const scrollOptions = { capture: true, passive: true } as const;

  doc.addEventListener("scroll", requestSample, scrollOptions);
  doc.addEventListener("visibilitychange", sampleNow);
  win.addEventListener("focus", sampleNow);
  win.addEventListener("blur", sampleNow);
  win.addEventListener("resize", requestSample);
  requestSample();

  return {
    requestSample,
    dispose() {
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
      session.dispose();
      doc.removeEventListener("scroll", requestSample, scrollOptions);
      doc.removeEventListener("visibilitychange", sampleNow);
      win.removeEventListener("focus", sampleNow);
      win.removeEventListener("blur", sampleNow);
      win.removeEventListener("resize", requestSample);
    },
  };
}

export function useSeenMarkerTracking(input: {
  threadKey: string | null;
  founder?: Founder | null;
  getScrollNode: () => SeenScrollNode | null | undefined;
  messages: ReadonlyArray<SeenMessage>;
  /** This founder's stored message. Scrolling back must not replace it. */
  notBeforeMessageId?: MessageId | null;
  /** Persist the place that was shown. Must not start a model turn. */
  onRecorded?: (messageId: MessageId, seenAt: string) => void;
}) {
  const { threadKey, founder = null, messages, onRecorded } = input;
  const getScrollNode = useEffectEvent(() => input.getScrollNode());
  const getMessages = useEffectEvent(() => messages);
  const notBefore = useEffectEvent(() => input.notBeforeMessageId);
  const recorded = useEffectEvent((messageId: MessageId, seenAt: string) =>
    onRecorded?.(messageId, seenAt),
  );
  const samplingRef = useRef<ReturnType<typeof startSeenMarkerSampling> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus, visibility and scroll listeners plus the dwell timer for this thread
  useEffect(() => {
    if (threadKey === null) return;
    const sampling = startSeenMarkerSampling({
      host: { window, document },
      threadKey,
      founder,
      getScrollNode,
      getMessages,
      notBefore,
      onRecorded: recorded,
    });
    samplingRef.current = sampling;
    return () => {
      sampling.dispose();
      samplingRef.current = null;
    };
  }, [threadKey, founder]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resamples the visible DOM rows when the thread's messages change
  useEffect(() => {
    if (messages.length > 0) samplingRef.current?.requestSample();
  }, [messages]);
}
