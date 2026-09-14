/**
 * OmpCommands — skill and slash-command discovery for omp's composer menus.
 *
 * omp resolves skills through a layered pipeline (native `.omp` user/project
 * roots, plugin packages, Claude/Codex/agents/opencode/github providers,
 * managed auto-learn skills) with per-source toggles, ignore globs and
 * name-collision precedence, and registers its own builtin/custom slash
 * commands on top. Re-implementing either scan in T3 would drift from the
 * runtime on every omp release, so both catalogs are read from omp itself.
 *
 * `omp acp` does not advertise commands (`session/new` returns only
 * `sessionId`, `configOptions` and `modes`, verified against omp/18.1.18), but
 * RPC mode emits an `available_commands_update` frame at startup carrying
 * every command: one `skill:<name>` per discovered skill plus the regular
 * commands. The probe therefore spawns `omp --mode rpc`, closes stdin
 * immediately, and reads that frame: on stdin close RPC drains accepted
 * commands, disposes the session and exits 0, so no request has to be written
 * and no model is ever called.
 *
 * Both kinds reach omp as ordinary prompt text — `/tools` and `/skill:<name>`
 * were both verified to run over an ACP `session/prompt` — so discovery is
 * only about offering them in the menus.
 *
 * @module provider/Drivers/OmpCommands
 */
import type {
  OmpSettings,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { collectStreamAsString } from "../providerSnapshot.ts";

/**
 * Startup covers config load, skill discovery, extension load and MCP
 * connection, so the budget is generous next to a filesystem scan. It still
 * has to fail rather than hang: a workspace snapshot waits on it.
 */
const OMP_COMMANDS_PROBE_TIMEOUT_MS = 45_000;
const SKILL_COMMAND_PREFIX = "skill:";

export interface OmpCommandCatalog {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

export class OmpCommandsProbeError extends Schema.TaggedError<OmpCommandsProbeError>()(
  "OmpCommandsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Oh My Pi command discovery${location} was incomplete (${this.stage}).`;
  }
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function commandEntriesFromFrame(frame: Record<string, unknown>): ReadonlyArray<unknown> {
  const commands =
    frame.type === "available_commands_update"
      ? frame.commands
      : frame.type === "response" && frame.command === "get_available_commands"
        ? (frame.data as Record<string, unknown> | undefined)?.commands
        : undefined;
  return Array.isArray(commands) ? commands : [];
}

/**
 * Split an RPC `available_commands_update` frame into provider skills and
 * slash commands. Skill `path` carries omp's own `skill://` URL: the runtime
 * resolves a skill by name through several roots and the command list does not
 * report the file it came from, so there is no filesystem path to hand back.
 *
 * Subcommands stay folded into their parent: T3's composer has no nested
 * commands, and omp's parent entry already advertises them through its input
 * hint (`/security <plan|scan|…>`).
 */
export function decodeOmpCommandCatalog(stdout: string): OmpCommandCatalog {
  const skillsByName = new Map<string, ServerProviderSkill>();
  const commandsByName = new Map<string, ServerProviderSlashCommand>();
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;
    let frame: unknown;
    try {
      // @effect-diagnostics-next-line preferSchemaOverJson:off - JSONL transport frame.
      frame = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    for (const entry of commandEntriesFromFrame(frame as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const command = entry as Record<string, unknown>;
      const commandName = trimmedString(command.name);
      if (commandName.length === 0) continue;
      const description = trimmedString(command.description);
      if (commandName.startsWith(SKILL_COMMAND_PREFIX)) {
        const name = commandName.slice(SKILL_COMMAND_PREFIX.length).trim();
        if (name.length === 0) continue;
        skillsByName.set(name, {
          name,
          path: `skill://${name}/SKILL.md`,
          enabled: true,
          ...(description.length > 0 ? { description } : {}),
        });
        continue;
      }
      const hint = trimmedString((command.input as Record<string, unknown> | undefined)?.hint);
      commandsByName.set(commandName, {
        name: commandName,
        ...(description.length > 0 ? { description } : {}),
        ...(hint.length > 0 ? { input: { hint } } : {}),
      });
    }
  }
  return {
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    slashCommands: [...commandsByName.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

/**
 * Spawn `omp --mode rpc` in `cwd` and map its startup catalog onto provider
 * skills and slash commands. Project-scoped skills and commands live under the
 * workspace, so the cwd decides the result and every workspace needs its own
 * probe.
 */
export const discoverOmpCommandCatalog = Effect.fn("discoverOmpCommandCatalog")(function* (
  ompSettings: Pick<OmpSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = ompSettings.binaryPath || "omp";
  const probe = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      // No session file, no language servers: the probe only needs the command
      // catalog, and both would cost startup time and leave state behind.
      ["--mode", "rpc", "--no-session", "--no-lsp"],
      { env: environment },
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    // Closing stdin is the exit signal: RPC mode keeps reading commands until
    // stdin ends, so without this the process outlives the probe.
    const [stdout, , exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        Stream.run(Stream.empty, child.stdin),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new OmpCommandsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(OMP_COMMANDS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(probe)) {
    return yield* new OmpCommandsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const catalog = decodeOmpCommandCatalog(probe.value.stdout);
  if (
    catalog.skills.length === 0 &&
    catalog.slashCommands.length === 0 &&
    probe.value.exitCode !== 0
  ) {
    return yield* new OmpCommandsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: probe.value.exitCode,
    });
  }
  return catalog;
});
