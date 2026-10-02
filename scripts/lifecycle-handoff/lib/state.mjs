// Durable, user-private state for a handoff. Every transition is written before
// the work it describes, so a manager reading a half-finished handoff can tell
// exactly where it stopped.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { STATES, TERMINAL_STATES } from "./envelope.mjs";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Atomic, owner-only JSON write (write temp, fsync, rename, fsync dir). */
export function writeJsonPrivate(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return path;
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Single-run claim. The first supervisor to create the lock owns the handoff;
 * a second instance (launchd retry, manual rerun, login reload) refuses. A lock
 * whose owner pid is gone is stale and may be reclaimed.
 */
export function claimRun(dir, handoffId, { pid, isAlive, now }) {
  ensureDir(dir);
  const lockPath = `${dir}/${handoffId}.lock`;
  const existing = readJson(lockPath);
  if (existing && !TERMINAL_STATES.includes(existing.state)) {
    if (existing.pid === pid || isAlive(existing.pid)) {
      return { claimed: false, lockPath, owner: existing };
    }
  }
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  writeJsonPrivate(lockPath, { handoffId, pid, claimedAt: now() });
  return { claimed: true, lockPath };
}

export function isTerminalResult(result) {
  return Boolean(result) && TERMINAL_STATES.includes(result.state);
}

export function assertKnownState(state) {
  if (!STATES.includes(state)) throw new Error(`unknown handoff state '${state}'`);
  return state;
}
