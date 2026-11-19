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

/**
 * What logind says about this user's local graphical login: none, one (with its state), or
 * unknown when logind could not be asked. Unknown never means nobody is there.
 */
type GraphicalLogin =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly shown: string }
  | { readonly kind: "unknown" };

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const { mode } = yield* ServerConfig.ServerConfig;

  const run = (args: ReadonlyArray<string>) =>
    runner.run({ command: "loginctl", args, timeout: "2 seconds" }).pipe(Effect.option);

  // Display can name a remote or text session, such as an SSH login, which nobody sits at.
  const graphicalLogin: Effect.Effect<GraphicalLogin> = Effect.gen(function* () {
    const uid = NodeProcess.getuid?.();
    if (uid === undefined) return { kind: "unknown" } as const;
    const user = yield* run(["show-user", String(uid), "-p", "Display", "--value"]);
    if (user._tag === "None") return { kind: "unknown" } as const;
    if (user.value.code !== 0)
      // Without a session or lingering manager logind knows no such user: nobody is logged in.
      return /not logged in/i.test(user.value.stderr)
        ? ({ kind: "none" } as const)
        : ({ kind: "unknown" } as const);
    const display = user.value.stdout.trim();
    if (display.length === 0) return { kind: "none" } as const;
    const session = yield* run([
      "show-session",
      display,
      ...["Type", "Remote", "Active", "LockedHint", "IdleHint"].flatMap((key) => ["-p", key]),
    ]);
    if (session._tag === "None" || session.value.code !== 0) return { kind: "unknown" } as const;
    return isLocalGraphicalSession(session.value.stdout)
      ? ({ kind: "session", shown: session.value.stdout } as const)
      : ({ kind: "none" } as const);
  });

  const role = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    const setting: MachinePlacementRole =
      settings._tag === "Some" ? settings.value.machinePlacementRole : "auto";
    if (setting !== "auto") return setting;
    if (mode === "desktop" || platform !== "linux") return "interactive" as const;
    return (yield* graphicalLogin).kind === "none"
      ? ("headless" as const)
      : ("interactive" as const);
  });

  return MachinePresence.of({
    role,
    read: Effect.gen(function* () {
      const placementRole = yield* role;
      if (placementRole === "headless") return { placementRole };
      // Only Linux can tell, and only Linux caps agents there; elsewhere assume someone is.
      if (platform !== "linux") return { placementRole, humanActive: true };
      const login = yield* graphicalLogin;
      return {
        placementRole,
        humanActive:
          login.kind === "unknown" || (login.kind === "session" && linuxSessionInUse(login.shown)),
      };
    }),
  });
});

export const layer = Layer.effect(MachinePresence, make);
