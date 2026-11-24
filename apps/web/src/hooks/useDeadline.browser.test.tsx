import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { useNowAcross, useNowAfter } from "./useDeadline";

function Probe(props: { deadlineMs: number }) {
  const nowMs = useNowAfter(props.deadlineMs);
  return <output>{nowMs >= props.deadlineMs ? "passed" : "pending"}</output>;
}

describe("useNowAfter", () => {
  it("reads a fresh clock when a later deadline passes", async () => {
    // The first render reads the clock.
    using _timers = fakeTimers({ now: 0 });
    await using screen = await render(<Probe deadlineMs={1_000} />, {
      // A bare hook probe; nothing here navigates.
      router: false,
    });
    await screen.rerender(<Probe deadlineMs={2_000} />);
    await expect.element(screen.getByText("pending")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(2_000));
    await expect.element(screen.getByText("passed")).toBeInTheDocument();
  });
});

function DueProbe(props: { deadlinesMs: ReadonlyArray<number> }) {
  const nowMs = useNowAcross(props.deadlinesMs);
  return (
    <output>{`${props.deadlinesMs.filter((deadline) => deadline <= nowMs).length} due`}</output>
  );
}

describe("useNowAcross", () => {
  it("flips once at each deadline, in order", async () => {
    using _timers = fakeTimers({ now: 0 });
    await using screen = await render(<DueProbe deadlinesMs={[3_000, 1_000]} />, {
      router: false,
    });
    await expect.element(screen.getByText("0 due")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByText("1 due")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(2_000));
    await expect.element(screen.getByText("2 due")).toBeInTheDocument();
  });
});
