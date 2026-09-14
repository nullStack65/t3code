/**
 * OmpSkills — skill discovery for the `$` picker via omp's RPC mode.
 *
 * omp resolves skills through a layered pipeline (native `.omp` user/project
 * roots, plugin packages, Claude/Codex/agents/opencode/github providers,
 * managed auto-learn skills) with per-source toggles, ignore globs and
 * name-collision precedence. Re-implementing that scan in T3 would drift from
 * the runtime on every omp release, so the catalog is read from omp itself.
 *
 * `omp acp` does not advertise commands (`session/new` returns only
 * `sessionId`, `configOptions` and `modes`, verified against omp/18.1.18), but
 * RPC mode emits an `available_commands_update` frame at startup that carries
 * one `skill:<name>` command per discovered skill with its description. The
 * probe therefore spawns `omp --mode rpc`, closes stdin immediately, and reads
 * that frame: on stdin close RPC drains accepted commands, disposes the
 * session and exits 0, so no request has to be written and no model is ever
 * called.
 *
 * @module provider/Drivers/OmpSkills
 */
import type { OmpSettings, ServerProviderSkill } from "@t3tools/contracts";
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
const OMP_SKILLS_PROBE_TIMEOUT_MS = 45_000;
const SKILL_COMMAND_PREFIX = "skill:";

export class OmpSkillsProbeError extends Schema.TaggedError<OmpSkillsProbeError>()(
  "OmpSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Oh My Pi skill discovery${location} was incomplete (${this.stage}).`;
  }
}

/**
 * Map the `skill:<name>` entries of an `available_commands_update` frame onto
 * provider skills. `path` carries omp's own `skill://` URL: the runtime
 * resolves a skill by name through several roots and the RPC command list does
 * not report the file it came from, so there is no filesystem path to hand
 * back.
 */
export function decodeOmpSkillCommands(stdout: string): ReadonlyArray<ServerProviderSkill> {
  const skillsByName = new Map<string, ServerProviderSkill>();
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
    const record = frame as Record<string, unknown>;
    const commands =
      record.type === "available_commands_update"
        ? record.commands
        : record.type === "response" && record.command === "get_available_commands"
          ? (record.data as Record<string, unknown> | undefined)?.commands
          : undefined;
    if (!Array.isArray(commands)) continue;
    for (const entry of commands) {
      if (typeof entry !== "object" || entry === null) continue;
      const command = entry as Record<string, unknown>;
      const commandName = typeof command.name === "string" ? command.name.trim() : "";
      if (!commandName.startsWith(SKILL_COMMAND_PREFIX)) continue;
      const name = commandName.slice(SKILL_COMMAND_PREFIX.length).trim();
      if (name.length === 0) continue;
      const description = typeof command.description === "string" ? command.description.trim() : "";
      skillsByName.set(name, {
        name,
        path: `skill://${name}/SKILL.md`,
        enabled: true,
        ...(description.length > 0 ? { description } : {}),
      });
    }
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Spawn `omp --mode rpc` in `cwd` and map its startup command catalog onto
 * provider skills. Project-scoped skills live under the workspace, so the cwd
 * decides the result and every workspace needs its own probe.
 */
export const discoverOmpSkills = Effect.fn("discoverOmpSkills")(function* (
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
        new OmpSkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(OMP_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(probe)) {
    return yield* new OmpSkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const skills = decodeOmpSkillCommands(probe.value.stdout);
  if (skills.length === 0 && probe.value.exitCode !== 0) {
    return yield* new OmpSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: probe.value.exitCode,
    });
  }
  return skills;
});
