import { expect } from "vite-plus/test";

export const INTERACTION_BUDGET_MS = 400;
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
  let start: number | null = from === "call" ? performance.now() : null;
  const onInput = (event: Event) => {
    start ??= event.timeStamp;
  };
  let finish!: (at: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let seen = false;
  const check = () => {
    if (seen || start === null || !isDone()) return;
    seen = true;
    void nextFrame().then(finish);
  };
  const observer = new MutationObserver(check);
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  try {
    await action();
    check();
    const end = await finished;
    return end - (start ?? end);
  } finally {
    observer.disconnect();
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
  }
}

export async function expectWithinBudget(
  interaction: string,
  sample: (index: number) => Promise<number>,
  { knownOverBudget = false }: { readonly knownOverBudget?: boolean } = {},
): Promise<void> {
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index++) samples.push(await sample(index));
  const median = samples.toSorted((a, b) => a - b)[Math.floor(SAMPLES / 2)]!;
  const report = `${interaction}: median ${median.toFixed(1)} ms, samples ${samples
    .map((value) => value.toFixed(1))
    .join(", ")} ms, budget ${INTERACTION_BUDGET_MS} ms`;
  if (knownOverBudget) {
    console.warn(`known over budget, not gated: ${report}`);
    return;
  }
  console.info(report);
  expect(median, report).toBeLessThanOrEqual(INTERACTION_BUDGET_MS);
}
