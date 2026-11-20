import type { MessageId } from "@t3tools/contracts";
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

export function startSeenMarkerSampling(input: {
  host: SeenSamplingHost;
  threadKey: string;
  getScrollNode: () => SeenScrollNode | null | undefined;
  getMessages: () => ReadonlyArray<SeenMessage>;
  now?: () => Date;
  timers?: SeenTimers;
}) {
  const { window: win, document: doc } = input.host;
  const session = createSeenMarkerSession({
    threadKey: input.threadKey,
    getMessages: input.getMessages,
    seenAt: () => (input.now ?? (() => new Date()))().toISOString(),
    timers: input.timers ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  let frame: number | null = null;

  const sample = () => {
    frame = null;
    const node = input.getScrollNode();
    const active = doc.visibilityState === "visible" && doc.hasFocus();
    session.update({ active, visibleIds: active && node ? visibleMessageIds(node) : [] });
  };
  const requestSample = () => {
    if (frame === null) frame = win.requestAnimationFrame(sample);
  };
  const scrollOptions = { capture: true, passive: true } as const;

  doc.addEventListener("scroll", requestSample, scrollOptions);
  doc.addEventListener("visibilitychange", requestSample);
  win.addEventListener("focus", requestSample);
  win.addEventListener("blur", requestSample);
  win.addEventListener("resize", requestSample);
  requestSample();

  return {
    requestSample,
    dispose() {
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
      session.dispose();
      doc.removeEventListener("scroll", requestSample, scrollOptions);
      doc.removeEventListener("visibilitychange", requestSample);
      win.removeEventListener("focus", requestSample);
      win.removeEventListener("blur", requestSample);
      win.removeEventListener("resize", requestSample);
    },
  };
}

export function useSeenMarkerTracking(input: {
  threadKey: string | null;
  getScrollNode: () => SeenScrollNode | null | undefined;
  messages: ReadonlyArray<SeenMessage>;
}) {
  const { threadKey, messages } = input;
  const getScrollNode = useEffectEvent(() => input.getScrollNode());
  const getMessages = useEffectEvent(() => messages);
  const samplingRef = useRef<ReturnType<typeof startSeenMarkerSampling> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus, visibility and scroll listeners plus the dwell timer for this thread
  useEffect(() => {
    if (threadKey === null) return;
    const sampling = startSeenMarkerSampling({
      host: { window, document },
      threadKey,
      getScrollNode,
      getMessages,
    });
    samplingRef.current = sampling;
    return () => {
      sampling.dispose();
      samplingRef.current = null;
    };
  }, [threadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resamples the visible DOM rows when the thread's messages change
  useEffect(() => {
    if (messages.length > 0) samplingRef.current?.requestSample();
  }, [messages]);
}
