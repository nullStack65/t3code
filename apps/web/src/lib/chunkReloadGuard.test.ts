import { describe, expect, it, vi } from "vite-plus/test";

import { isChunkLoadError, reloadForChunkLoadError } from "./chunkReloadGuard";

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

describe("reloadForChunkLoadError", () => {
  it("retries with growing delays, then lets the failure surface", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    const reloadAt = (now: number) => reloadForChunkLoadError(() => storage, reload, "1.0.0", now);

    expect(reloadAt(0)).toBe(true);
    expect(reloadAt(5_000)).toBe(true);
    expect(reloadAt(10_000)).toBe(true);
    expect(reloadAt(15_000)).toBe(false);
    expect(reload.mock.calls.map(([delay]) => delay)).toEqual([750, 1500, 2250]);
  });

  it("reloads again once the window has passed", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    for (const now of [0, 1_000, 2_000])
      reloadForChunkLoadError(() => storage, reload, "1.0.0", now);

    expect(reloadForChunkLoadError(() => storage, reload, "1.0.0", 70_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it("reloads again once a deploy changed the build", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    for (const now of [0, 1_000, 2_000])
      reloadForChunkLoadError(() => storage, reload, "1.0.0", now);

    expect(reloadForChunkLoadError(() => storage, reload, "1.0.1", 3_000)).toBe(true);
  });

  it("treats the bare build string an older tab stored as no record", () => {
    const storage = createStorageStub();
    storage.setItem("t3code:chunk-load-reloaded", "1.0.0");
    const reload = vi.fn();

    expect(reloadForChunkLoadError(() => storage, reload, "1.0.0", 0)).toBe(true);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadForChunkLoadError(blocked, reload)).toBe(false);
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
