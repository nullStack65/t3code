// Process liveness and parent-chain inspection. The whole point of the detached
// handoff is that the helper's ancestry is independent of T3, so these helpers
// exist to *prove* that rather than assume it.

import { execFileSync } from "node:child_process";

/** True when the pid exists and is signalable by this user. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return error && error.code === "EPERM";
  }
}

/** Parent pid of `pid`, or null when it is gone / unobtainable. */
export function parentPid(pid) {
  try {
    const out = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = Number.parseInt(out.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ancestor chain of `pid`, nearest first, stopping at pid 1 / launchd or when a
 * loop or missing parent is seen.
 */
export function ancestry(pid) {
  const chain = [];
  const seen = new Set();
  let current = pid;
  while (Number.isInteger(current) && current > 1 && !seen.has(current)) {
    seen.add(current);
    const parent = parentPid(current);
    if (parent === null) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Independent-from evidence for a supervisor the initiator just launched.
 * `launchd`-owned means the direct parent is pid 1; anything else (a shell, an
 * agent, an Electron helper) means it can still be inside T3's process tree or
 * job object and must not be trusted for a lifecycle action.
 */
export function independence(pid, { forbiddenPids = [] } = {}) {
  const chain = ancestry(pid);
  const directParent = chain[0] ?? null;
  const forbidden = new Set(forbiddenPids.filter((value) => Number.isInteger(value) && value > 0));
  const collisions = chain.filter((ancestor) => forbidden.has(ancestor));
  return {
    pid,
    alive: isAlive(pid),
    directParent,
    ancestry: chain,
    /** launchd/systemd/SCM parent, or a short chain we cannot explain. */
    osOwned: directParent === 1,
    forbiddenPids: [...forbidden],
    forbiddenAncestors: collisions,
    independent: chain.length > 0 && collisions.length === 0 && directParent === 1,
  };
}

/** Short human rendering of an ancestry proof for logs. */
export function describeAncestry(pid) {
  return `${pid} <- ${ancestry(pid).join(" <- ")}`;
}
