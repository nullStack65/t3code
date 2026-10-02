// The supervisor state machine.
//
// Dependency-injected so the same code is exercised by unit tests (fake clock,
// fake spawn) and by the real detached helper (real spawn, real launchd), and so
// a future supported T3 callback endpoint can replace `deliverCallback` without
// touching the lifecycle logic.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";

import { STATES } from "./envelope.mjs";
import { isAlive as realIsAlive } from "./process.mjs";
import { claimRun, isTerminalResult, writeJsonPrivate } from "./state.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TAIL_LIMIT = 4000;

function tail(text) {
  if (typeof text !== "string") return "";
  return text.length <= TAIL_LIMIT ? text : text.slice(text.length - TAIL_LIMIT);
}

/** Spawn a command to completion with a hard timeout. Never force-kills a peer. */
export function spawnCommand(argv, { cwd, timeoutMs, stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: cwd ?? process.cwd(),
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs ?? 30 * 60 * 1000);
    child.stdout?.on("data", (chunk) => {
      stdout = tail(stdout + chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      stderr = tail(stderr + chunk.toString());
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr: tail(`${stderr}${error.message}`) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

/** Poll a readiness condition until it holds or the bound expires. */
export async function waitReady(readiness, { isAlive = realIsAlive, sleep = sleepDefault, log } = {}) {
  const deadline = Date.now() + (readiness.timeoutMs ?? 180_000);
  const pollMs = readiness.pollMs ?? 1000;
  for (;;) {
    if (await probeReadiness(readiness, { isAlive })) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

async function probeReadiness(readiness, { isAlive }) {
  try {
    switch (readiness.kind) {
      case "none":
        return true;
      case "file":
        return typeof readiness.path === "string" && existsSync(readiness.path);
      case "pid":
        return Number.isInteger(readiness.pid) ? isAlive(readiness.pid) : false;
      case "tcp":
        return await probeTcp(readiness.host ?? "127.0.0.1", readiness.port);
      case "http": {
        const response = await fetch(readiness.url, { signal: AbortSignal.timeout(3000) });
        return response.ok;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function githubReceipt(callback, result) {
  const { repo, issue } = callback.github ?? {};
  const body = renderCallbackMessage(result);
  return { argv: ["gh", "issue", "comment", String(issue), "--repo", String(repo), "--body-file", "-"], stdin: body };
}

/** Short, stable callback text. Safe to paste into a thread or a hub comment. */
export function renderCallbackMessage(result) {
  const lines = [
    `DETACHED HANDOFF ${result.state} ${result.handoffId}.`,
    `Operation: ${result.task.operation} (exit=${result.command?.code ?? "n/a"}${result.command?.timedOut ? ", timed-out" : ""}).`,
    `Before: ${JSON.stringify(result.identity?.before ?? "unknown")}`,
    `After: ${JSON.stringify(result.identity?.observedAfter ?? "unknown")}`,
    `Result: ${result.paths?.result}`,
  ];
  if (result.githubReceiptUrl) lines.push(`Receipt: ${result.githubReceiptUrl}`);
  return lines.join("\n");
}

/** Default callback: local result envelope (already written) + optional receipt. */
export async function deliverCallback(envelope, result, deps) {
  const kind = envelope.callback.kind;
  if (kind === "none") return { ok: true, detail: "no external callback configured" };
  if (kind === "github") {
    const { argv, stdin } = githubReceipt(envelope.callback, result);
    const outcome = await deps.spawnCommand(argv, { timeoutMs: 30_000, stdin });
    return {
      ok: outcome.code === 0,
      detail: outcome.code === 0 ? "github receipt posted" : `gh exited ${outcome.code}: ${outcome.stderr}`,
      url: extractUrl(outcome.stdout),
    };
  }
  if (kind === "http") {
    try {
      const response = await fetch(envelope.callback.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId: result.handoffId, state: result.state, message: renderCallbackMessage(result) }),
        signal: AbortSignal.timeout(10_000),
      });
      return { ok: response.ok, detail: `http ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `http callback failed: ${error.message}` };
    }
  }
  return { ok: false, detail: `unsupported callback kind '${kind}'` };
}

function extractUrl(text) {
  const match = /https?:\/\/\S+/.exec(text ?? "");
  return match ? match[0] : undefined;
}

/**
 * Run one handoff to a terminal state. Returns the result envelope.
 *
 * Ordering guarantees:
 *  - the destructive command is skipped when a terminal result already exists;
 *  - the command never runs before the waited-for pid is gone;
 *  - the result is persisted before the callback is attempted, so an external
 *    receipt failure still leaves durable local evidence.
 */
export async function supervise(envelope, deps = {}) {
  const isAlive = deps.isAlive ?? realIsAlive;
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? (() => new Date().toISOString());
  const spawnCommandFn = deps.spawnCommand ?? spawnCommand;
  const waitReadyFn = deps.waitReady ?? waitReady;
  const deliverCallbackFn = deps.deliverCallback ?? deliverCallback;
  const cleanup = deps.cleanup ?? (async () => {});
  const log = deps.log ?? (() => {});

  const result = {
    schemaVersion: envelope.schemaVersion,
    handoffId: envelope.handoffId,
    state: "PREPARED",
    task: envelope.task,
    originating: envelope.originating,
    identity: { ...envelope.identity },
    paths: envelope.paths,
    startedAt: envelope.createdAt,
    updatedAt: now(),
    transitions: [],
    command: null,
    relaunch: null,
    readiness: null,
    callback: null,
    githubReceiptUrl: undefined,
    supervisorPid: process.pid,
  };

  const persist = (state, extra = {}) => {
    result.state = state;
    result.updatedAt = now();
    result.transitions.push({ state, at: result.updatedAt });
    Object.assign(result, extra);
    writeJsonPrivate(envelope.paths.state, result);
    log(`[${state}] ${envelope.handoffId}`);
  };

  const fail = async (reason, extra = {}) => {
    result.failure = { reason, at: now() };
    persist("FAILED", extra);
    writeJsonPrivate(envelope.paths.result, result);
    try {
      result.callback = await deliverCallbackFn(envelope, result, { spawnCommand: spawnCommandFn });
    } catch (error) {
      result.callback = { ok: false, detail: `callback threw: ${error.message}` };
      writeJsonPrivate(envelope.paths.result, result);
    }
    await safeCleanup(cleanup, log);
    return result;
  };

  // --- idempotency -----------------------------------------------------------
  const previous = deps.previousResult;
  if (isTerminalResult(previous)) {
    log(`already terminal (${previous.state}); refusing to re-run destructive command`);
    result.state = previous.state;
    result.transitions = previous.transitions ?? [];
    result.skippedBecauseTerminal = true;
    writeJsonPrivate(envelope.paths.state, result);
    await safeCleanup(cleanup, log);
    return result;
  }

  const claim = claimRun(envelope.paths.dir, envelope.handoffId, { pid: process.pid, isAlive, now });
  if (!claim.claimed) {
    log(`another supervisor (pid ${claim.owner?.pid}) owns ${envelope.handoffId}; exiting`);
    result.state = claim.owner?.state ?? "DETACHED";
    result.skippedBecauseClaimed = true;
    writeJsonPrivate(envelope.paths.state, result);
    return result;
  }

  persist("DETACHED", { detachment: deps.detachment ?? null });

  // --- wait for the initiating process to exit -------------------------------
  const waitPid = envelope.waitFor.pid;
  if (Number.isInteger(waitPid)) {
    persist("WAITING_FOR_EXIT");
    const deadline = Date.now() + envelope.waitFor.timeoutMs;
    while (isAlive(waitPid)) {
      if (Date.now() >= deadline) {
        return fail(`initiating pid ${waitPid} still alive after ${envelope.waitFor.timeoutMs}ms (not force-killed)`);
      }
      await sleep(envelope.waitFor.pollMs);
    }
    log(`initiating pid ${waitPid} exited`);
  }

  // --- apply the lifecycle command ------------------------------------------
  persist("APPLYING");
  const commandOutcome = await spawnCommandFn(envelope.command.argv, {
    cwd: envelope.command.cwd,
    timeoutMs: envelope.command.timeoutMs,
  });
  result.command = {
    argv: envelope.command.argv,
    code: commandOutcome.code,
    signal: commandOutcome.signal,
    timedOut: commandOutcome.timedOut,
    stdoutTail: commandOutcome.stdout,
    stderrTail: commandOutcome.stderr,
  };
  if (commandOutcome.timedOut) return fail("lifecycle command timed out");
  if (commandOutcome.code !== 0) return fail(`lifecycle command exited ${commandOutcome.code}`);

  // --- relaunch --------------------------------------------------------------
  if (envelope.relaunch.argv.length > 0) {
    persist("RELAUNCHING");
    let attempt = 0;
    let launched = false;
    while (attempt < envelope.behavior.maxRelaunchAttempts && !launched) {
      attempt += 1;
      const outcome = await spawnCommandFn(envelope.relaunch.argv, { timeoutMs: envelope.relaunch.timeoutMs });
      result.relaunch = { argv: envelope.relaunch.argv, attempt, code: outcome.code, timedOut: outcome.timedOut, stderrTail: outcome.stderr };
      if (outcome.code === 0 && !outcome.timedOut) launched = true;
    }
    if (!launched) return fail("relaunch command failed within its attempt bound");
  }

  // --- wait for readiness ----------------------------------------------------
  persist("WAITING_FOR_T3");
  const ready = await waitReadyFn(envelope.readiness, { isAlive, sleep, log });
  result.readiness = { ...envelope.readiness, ready };
  if (!ready) return fail("T3 did not reach its readiness condition within the bound");

  // --- independently verify the post-identity --------------------------------
  if (envelope.identity.afterCommand) {
    const identityOutcome = await spawnCommandFn(envelope.identity.afterCommand.argv, {
      timeoutMs: envelope.identity.afterCommand.timeoutMs,
    });
    result.identity.observedAfter = identityOutcome.stdout?.trim() || identityOutcome.stderr?.trim() || null;
    result.identity.observedAfterCode = identityOutcome.code;
  }

  // --- callback --------------------------------------------------------------
  persist("CALLBACK_PENDING");
  // The notification describes the finished operation, not the in-flight
  // callback step, so render the message as the terminal success state while
  // the durable transition log still records CALLBACK_PENDING -> COMPLETE.
  const completed = { ...result, state: "COMPLETE" };
  // Durable pre-callback evidence lives beside the result, never at the result
  // path itself: the result path is the terminal record readers may trust.
  writeJsonPrivate(`${envelope.paths.result}.pending`, completed);
  try {
    result.callback = await deliverCallbackFn(envelope, completed, { spawnCommand: spawnCommandFn });
    if (result.callback?.url) result.githubReceiptUrl = result.callback.url;
  } catch (error) {
    result.callback = { ok: false, detail: `callback threw: ${error.message}` };
  }

  persist("COMPLETE");
  writeJsonPrivate(envelope.paths.result, result);
  await safeCleanup(cleanup, log);
  return result;
}

async function safeCleanup(cleanup, log) {
  try {
    await cleanup();
  } catch (error) {
    log(`cleanup failed (non-fatal): ${error.message}`);
  }
}

export { STATES };
