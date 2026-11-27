import { describe, expect, it, vi } from "vite-plus/test";

import {
  isChunkLoadError,
  MAX_RELOADS_PER_WINDOW,
  RELOAD_WINDOW_MS,
  reloadForChunkLoadError,
} from "./chunkReloadGuard";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function createHarness(build = "1.0.0") {
  const storage = createStorageStub();
  const reload = vi.fn().mockName("location.reload");
  const delays: number[] = [];
  let clock = 1_000_000;
  const attempt = () =>
    reloadForChunkLoadError({
      getStorage: () => storage,
      reload,
      build,
      now: () => clock,
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        callback();
      },
    });
  return {
    storage,
    reload,
    delays,
    attempt,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("reloadForChunkLoadError", () => {
  it("retries a flapping network up to three times with growing delays, then lets it surface", () => {
    const harness = createHarness();

    expect(harness.attempt()).toBe(true);
    expect(harness.attempt()).toBe(true);
    expect(harness.attempt()).toBe(true);
    expect(harness.attempt()).toBe(false);

    expect(harness.reload).toHaveBeenCalledTimes(MAX_RELOADS_PER_WINDOW);
    expect(harness.delays).toEqual([750, 1500, 2250]);
  });

  it("retries again once the window has passed, so a later blip in the same tab recovers", () => {
    const harness = createHarness();
    for (let i = 0; i < MAX_RELOADS_PER_WINDOW; i++) harness.attempt();
    expect(harness.attempt()).toBe(false);

    harness.advance(RELOAD_WINDOW_MS);

    expect(harness.attempt()).toBe(true);
    expect(harness.delays.at(-1)).toBe(750);
  });

  it("keeps counting inside the window across reloads", () => {
    const harness = createHarness();
    harness.attempt();
    harness.advance(RELOAD_WINDOW_MS - 1);
    harness.attempt();
    harness.attempt();

    expect(harness.attempt()).toBe(false);
  });

  it("starts a fresh window once a deploy changed the build", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    const options = {
      getStorage: () => storage,
      reload,
      now: () => 0,
      schedule: (cb: () => void) => cb(),
    };
    for (let i = 0; i < MAX_RELOADS_PER_WINDOW; i++)
      reloadForChunkLoadError({ ...options, build: "1.0.0" });

    expect(reloadForChunkLoadError({ ...options, build: "1.0.1" })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(MAX_RELOADS_PER_WINDOW + 1);
  });

  it("treats the old one-reload marker as a fresh window instead of a dead end", () => {
    const harness = createHarness();
    harness.storage.setItem("t3code:chunk-load-reloaded", "1.0.0");

    expect(harness.attempt()).toBe(true);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadForChunkLoadError({ getStorage: blocked, reload, schedule: (cb) => cb() })).toBe(
      false,
    );
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("isChunkLoadError", () => {
  it.each([
    ["Failed to fetch dynamically imported module: t3code://app/assets/a.js", true],
    ["error loading dynamically imported module: https://app.t3.codes/assets/a.js", true],
    ["Importing a module script failed.", true],
    ["Cannot read properties of undefined", false],
  ])("%s", (message, expected) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(expected);
  });
});
