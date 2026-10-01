// Handoff envelope: the complete, self-describing record an initiating agent
// hands to an OS-owned detached supervisor. It deliberately carries identifiers
// and commands only — never provider, browser, or API credentials.
//
// The schema is intentionally flat JSON so an operator or a future manager can
// read a stalled handoff without any tooling.

export const SCHEMA_VERSION = 1;

/** Lifecycle states. Terminal states are COMPLETE and FAILED. */
export const STATES = Object.freeze([
  "PREPARED",
  "DETACHED",
  "WAITING_FOR_EXIT",
  "APPLYING",
  "RELAUNCHING",
  "WAITING_FOR_T3",
  "CALLBACK_PENDING",
  "COMPLETE",
  "FAILED",
]);

export const TERMINAL_STATES = Object.freeze(["COMPLETE", "FAILED"]);

export class EnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvelopeError";
  }
}

// Key names that must never appear anywhere in an envelope.
const FORBIDDEN_KEY =
  /(token|secret|password|passwd|credential|bearer|api[-_]?key|private[-_]?key|cookie|session[-_]?key)/i;

// Value shapes that are almost certainly credentials, regardless of key name.
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
]);

/** Recursively reject forbidden keys and credential-shaped values. */
export function assertNoSecrets(value, at = "envelope") {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new EnvelopeError(`refusing to persist credential-shaped value at ${at}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${at}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new EnvelopeError(`refusing to persist forbidden key '${key}' at ${at}`);
      }
      assertNoSecrets(child, `${at}.${key}`);
    }
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvelopeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireArgv(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string")) {
    throw new EnvelopeError(`${field} must be a non-empty array of strings`);
  }
  return value;
}

/** Like requireArgv but an empty list is valid (an optional step). */
function optionalArgv(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) {
    throw new EnvelopeError(`${field} must be an array of strings`);
  }
  return value;
}

/**
 * Validate the parts the supervisor actually depends on. Returns a frozen copy so
 * a mutating caller cannot change a running plan.
 */
export function parseEnvelope(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new EnvelopeError("envelope must be a JSON object");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new EnvelopeError(`unsupported envelope schemaVersion ${String(input.schemaVersion)}`);
  }
  assertNoSecrets(input);

  const originating = input.originating ?? {};
  const waitFor = input.waitFor ?? {};
  const behavior = input.behavior ?? {};
  const relaunch = input.relaunch ?? {};
  const readiness = input.readiness ?? { kind: "none" };
  const callback = input.callback ?? { kind: "none" };
  const paths = input.paths ?? {};
  const command = input.command ?? {};

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    handoffId: requireString(input.handoffId, "handoffId"),
    createdAt: requireString(input.createdAt, "createdAt"),
    originating: {
      threadId: requireString(originating.threadId, "originating.threadId"),
      projectId: requireString(originating.projectId, "originating.projectId"),
      machine: requireString(originating.machine, "originating.machine"),
      platform: requireString(originating.platform, "originating.platform"),
      ...(originating.agentPid === undefined ? {} : { agentPid: originating.agentPid }),
    },
    task: {
      description: requireString(input.task?.description, "task.description"),
      operation: requireString(input.task?.operation, "task.operation"),
    },
    command: {
      argv: requireArgv(command.argv, "command.argv"),
      ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
      timeoutMs: Number.isFinite(command.timeoutMs) ? command.timeoutMs : 30 * 60 * 1000,
    },
    waitFor: {
      pid: Number.isInteger(waitFor.pid) ? waitFor.pid : null,
      timeoutMs: Number.isFinite(waitFor.timeoutMs) ? waitFor.timeoutMs : 5 * 60 * 1000,
      pollMs: Number.isFinite(waitFor.pollMs) ? waitFor.pollMs : 500,
    },
    behavior: {
      allowForceKill: behavior.allowForceKill === true,
      maxRelaunchAttempts: Number.isInteger(behavior.maxRelaunchAttempts)
        ? behavior.maxRelaunchAttempts
        : 1,
    },
    relaunch: {
      argv: optionalArgv(relaunch.argv, "relaunch.argv"),
      timeoutMs: Number.isFinite(relaunch.timeoutMs) ? relaunch.timeoutMs : 60 * 1000,
    },
    readiness: {
      kind: requireString(readiness.kind, "readiness.kind"),
      timeoutMs: Number.isFinite(readiness.timeoutMs) ? readiness.timeoutMs : 3 * 60 * 1000,
      pollMs: Number.isFinite(readiness.pollMs) ? readiness.pollMs : 1000,
      ...(readiness.url !== undefined ? { url: readiness.url } : {}),
      ...(readiness.host !== undefined ? { host: readiness.host } : {}),
      ...(readiness.port !== undefined ? { port: readiness.port } : {}),
      ...(readiness.path !== undefined ? { path: readiness.path } : {}),
      ...(readiness.pidFile !== undefined ? { pidFile: readiness.pidFile } : {}),
    },
    identity: {
      ...(input.identity?.before !== undefined ? { before: input.identity.before } : {}),
      ...(input.identity?.after !== undefined ? { after: input.identity.after } : {}),
      ...(input.identity?.afterCommand === undefined
        ? {}
        : {
            afterCommand: {
              argv: requireArgv(input.identity.afterCommand.argv, "identity.afterCommand.argv"),
              timeoutMs: Number.isFinite(input.identity.afterCommand.timeoutMs)
                ? input.identity.afterCommand.timeoutMs
                : 30_000,
            },
          }),
    },
    callback: {
      kind: requireString(callback.kind, "callback.kind"),
      ...(callback.url !== undefined ? { url: callback.url } : {}),
      ...(callback.github !== undefined ? { github: callback.github } : {}),
      ...(callback.message !== undefined ? { message: callback.message } : {}),
    },
    paths: {
      dir: requireString(paths.dir, "paths.dir"),
      state: requireString(paths.state, "paths.state"),
      log: requireString(paths.log, "paths.log"),
      result: requireString(paths.result, "paths.result"),
      ...(paths.fromThread !== undefined ? { fromThread: paths.fromThread } : {}),
    },
    supervisor: {
      nodePath: requireString(input.supervisor?.nodePath, "supervisor.nodePath"),
      scriptPath: requireString(input.supervisor?.scriptPath, "supervisor.scriptPath"),
    },
  };
  return Object.freeze(envelope);
}
