// @effect-diagnostics nodeBuiltinImport:off -- the user id comes from the host process.
import * as NodeProcess from "node:process";

import type { MachinePlacementRole } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MachinePresence } from "./HostResources.ts";

/** A person who has not touched a Mac's keyboard or pointer for this long is away. */
const DARWIN_IDLE_NANOS = 10 * 60 * 1e9;

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

/** The graphical login's state from logind; a session that cannot be read counts as in use. */
export function linuxSessionInUse(shown: string): boolean {
  const values = parseKeyValues(shown);
  return !(
    values.get("Active") === "no" ||
    values.get("LockedHint") === "yes" ||
    values.get("IdleHint") === "yes"
  );
}

/** A login at this machine's own screen, not a remote or text session. */
export function isLocalGraphicalSession(shown: string): boolean {
  const values = parseKeyValues(shown);
  const type = values.get("Type");
  return (type === "x11" || type === "wayland" || type === "mir") && values.get("Remote") !== "yes";
}

/** HIDIdleTime from `ioreg -c IOHIDSystem`; undefined when it cannot be read. */
export function darwinIdleNanos(output: string): number | undefined {
  const value = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output)?.[1];
  return value === undefined ? undefined : Number(value);
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const { mode } = yield* ServerConfig.ServerConfig;

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "2 seconds" }).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  // The logind state of this user's local graphical login, or undefined when there is none.
  // Display can name a remote or text session, such as an SSH login, which nobody sits at.
  const graphicalSession = Effect.gen(function* () {
    const uid = NodeProcess.getuid?.();
    if (uid === undefined) return undefined;
    const display = (yield* run("loginctl", [
      "show-user",
      String(uid),
      "-p",
      "Display",
      "--value",
    ]))?.trim();
    if (display === undefined || display.length === 0) return undefined;
    const shown = yield* run("loginctl", [
      "show-session",
      display,
      ...["Type", "Remote", "Active", "LockedHint", "IdleHint"].flatMap((key) => ["-p", key]),
    ]);
    // A session logind names but cannot describe is treated as someone's.
    if (shown === undefined) return "";
    return isLocalGraphicalSession(shown) ? shown : undefined;
  });

  const resolveRole = Effect.fn("MachinePresence.resolveRole")(function* (
    setting: MachinePlacementRole,
  ) {
    if (setting !== "auto") return setting;
    if (mode === "desktop" || platform !== "linux") return "interactive" as const;
    return (yield* graphicalSession) === undefined
      ? ("headless" as const)
      : ("interactive" as const);
  });

  const humanActive = Effect.gen(function* () {
    if (platform === "darwin") {
      const idle = darwinIdleNanos(
        (yield* run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4", "-k", "HIDIdleTime"])) ??
          "",
      );
      return idle === undefined || idle < DARWIN_IDLE_NANOS;
    }
    if (platform !== "linux") return true;
    const session = yield* graphicalSession;
    return session !== undefined && linuxSessionInUse(session);
  });

  const role = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    return yield* resolveRole(
      settings._tag === "Some" ? settings.value.machinePlacementRole : "auto",
    );
  });

  return MachinePresence.of({
    role,
    read: Effect.gen(function* () {
      const placementRole = yield* role;
      return placementRole === "headless"
        ? { placementRole }
        : { placementRole, humanActive: yield* humanActive };
    }),
  });
});

export const layer = Layer.effect(MachinePresence, make);
