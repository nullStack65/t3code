import { expect } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    reportLatency: (line: string) => Promise<void>;
  }
}

const INTERACTION_BUDGET_MS = 400;
const SAMPLES = 5;
const QUIET_MS = 150;
const INPUT_EVENTS = ["pointerdown", "keydown"] as const;

const nextFrame = () =>
  new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now())));

export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    let timer = setTimeout(done, QUIET_MS);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, QUIET_MS);
    });
    function done() {
      observer.disconnect();
      resolve();
    }
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  await nextFrame();
}

export async function timeInteraction(
  action: () => Promise<unknown>,
  isDone: () => boolean,
  { from = "input" }: { readonly from?: "input" | "call" } = {},
): Promise<number> {
  expect(isDone(), "the result already shows before the interaction").toBe(false);
  let start: number | null = from === "call" ? performance.now() : null;
  const onInput = (event: Event) => {
    start ??= event.timeStamp;
  };
  let stopped = false;
  const painted = new Promise<number>((resolve) => {
    const frame = () => {
      if (stopped) return;
      if (start === null || !isDone()) {
        requestAnimationFrame(frame);
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(performance.now());
      channel.port2.postMessage(null);
    };
    requestAnimationFrame(frame);
  });
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true });
  try {
    await action();
    const began = start;
    if (began === null) throw new Error("the interaction dispatched no pointerdown or keydown");
    return (await painted) - began;
  } finally {
    stopped = true;
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
  }
}

export async function expectWithinBudget(
  interaction: string,
  sample: (index: number) => Promise<number>,
  { ungated }: { readonly ungated?: string } = {},
): Promise<void> {
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index++) samples.push(await sample(index));
  const median = samples.toSorted((a, b) => a - b)[Math.floor(SAMPLES / 2)]!;
  const report = `${interaction}: median ${median.toFixed(1)} ms, samples ${samples
    .map((value) => value.toFixed(1))
    .join(", ")} ms, budget ${INTERACTION_BUDGET_MS} ms`;
  await commands.reportLatency(ungated ? `not gated, ${ungated}: ${report}` : report);
  if (ungated) return;
  expect(median, report).toBeLessThanOrEqual(INTERACTION_BUDGET_MS);
}
