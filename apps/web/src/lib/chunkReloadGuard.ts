// Deploys, server swaps and network blips can fail a chunk; a reload fetches it again.
// Closura (CLO-1310): a few spaced reloads per window per build, so a flapping network
// recovers while a chunk that is really gone still stops after MAX_RELOADS_PER_WINDOW.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
export const MAX_RELOADS_PER_WINDOW = 3;
export const RELOAD_WINDOW_MS = 60_000;
export const RELOAD_DELAY_STEP_MS = 750;

interface ReloadGuardState {
  build: string;
  count: number;
  windowStart: number;
}

function readState(raw: string | null, build: string, now: number): ReloadGuardState {
  try {
    const parsed = raw === null ? null : (JSON.parse(raw) as Partial<ReloadGuardState>);
    if (
      parsed !== null &&
      parsed.build === build &&
      typeof parsed.count === "number" &&
      typeof parsed.windowStart === "number" &&
      now >= parsed.windowStart &&
      now - parsed.windowStart < RELOAD_WINDOW_MS
    ) {
      return { build, count: parsed.count, windowStart: parsed.windowStart };
    }
  } catch {
    // An unreadable value (including the old plain build string) starts a fresh window.
  }
  return { build, count: 0, windowStart: now };
}

export interface ChunkReloadOptions {
  getStorage?: () => Storage;
  reload?: () => void;
  build?: string;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => void;
}

/** Schedules a reload unless this build used up its attempts in the current window. */
export function reloadForChunkLoadError({
  getStorage = () => window.sessionStorage,
  reload = () => window.location.reload(),
  build = import.meta.env.APP_VERSION,
  now = Date.now,
  schedule = (callback, delayMs) => window.setTimeout(callback, delayMs),
}: ChunkReloadOptions = {}): boolean {
  let attempt: number;
  try {
    const storage = getStorage();
    const state = readState(storage.getItem(CHUNK_RELOAD_GUARD_KEY), build, now());
    if (state.count >= MAX_RELOADS_PER_WINDOW) return false;
    attempt = state.count + 1;
    storage.setItem(CHUNK_RELOAD_GUARD_KEY, JSON.stringify({ ...state, count: attempt }));
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  // Growing delays give a flapping network time to settle before the next try.
  schedule(reload, attempt * RELOAD_DELAY_STEP_MS);
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
    if (chunkLoadState.reloadScheduled) {
      // Several chunks failing in one load share the reload already scheduled.
      event.preventDefault();
      return;
    }
    if (reloadForChunkLoadError()) {
      chunkLoadState.reloadScheduled = true;
      event.preventDefault();
    }
  });
}
