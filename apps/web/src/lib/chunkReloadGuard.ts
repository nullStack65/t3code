// A failed chunk is only retried by a reload, so a few spaced-out reloads ride out a flapping network.
// The cap stops a chunk that is gone, or a load that hangs and then fails, from looping.
// Keyed by build and kept across boots: a chunk loaded after boot can fail on every visit.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 10 * 60_000;
const RELOAD_DELAY_MS = 750;

interface ReloadRecord {
  readonly build: string;
  readonly at: ReadonlyArray<number>;
}

// A tab opened before this format holds the bare build string, which is not a record.
function readRecord(raw: string | null): Partial<ReloadRecord> | undefined {
  try {
    return raw === null ? undefined : (JSON.parse(raw) as Partial<ReloadRecord>);
  } catch {
    return undefined;
  }
}

export function reloadForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: (delayMs: number) => void = (delayMs) =>
    void setTimeout(() => window.location.reload(), delayMs),
  build = import.meta.env.APP_VERSION,
  now = Date.now(),
): boolean {
  let recent: ReadonlyArray<number> = [];
  try {
    const storage = getStorage();
    const record = readRecord(storage.getItem(CHUNK_RELOAD_GUARD_KEY));
    if (record?.build === build && Array.isArray(record.at)) {
      // A stamp from the future (the clock moved back) would hold the cap shut, so it does not count.
      recent = record.at.filter((at) => at <= now && now - at < RELOAD_WINDOW_MS);
    }
    if (recent.length >= MAX_RELOADS) return false;
    storage.setItem(CHUNK_RELOAD_GUARD_KEY, JSON.stringify({ build, at: [...recent, now] }));
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  reload(RELOAD_DELAY_MS * (recent.length + 1));
  return true;
}

// Browsers cache a failed dynamic import per document, so only a reload can retry it.
const CHUNK_LOAD_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return (
    message !== undefined && CHUNK_LOAD_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

export const chunkLoadState = { reloadScheduled: false };

// Registered from the entry before main loads, so main-chunk and route-chunk failures share one decision.
export function handleChunkLoadErrors() {
  window.addEventListener("vite:preloadError", (event) => {
    // One failed load raises this event for every chunk it lost; they share one reload.
    if (chunkLoadState.reloadScheduled || reloadForChunkLoadError()) {
      chunkLoadState.reloadScheduled = true;
      event.preventDefault();
    }
  });
}
