import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { MachinePlacementRole } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MachinePresence } from "./HostResources.ts";
import * as MachinePresenceLive from "./MachinePresence.ts";

/** A Linux host whose logind answers `show-user` with `display` and `show-session` with `session`. */
const linux = (input: {
  readonly role: MachinePlacementRole;
  readonly display: string;
  readonly session?: string;
  readonly calls?: Array<string>;
  /** logind refusing `show-user`, with this stderr. */
  readonly userError?: string;
}) =>
  MachinePresenceLive.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: ({ args }) =>
              Effect.sync(() => {
                input.calls?.push(args[0] ?? "");
                const refused = args[0] === "show-user" && input.userError !== undefined;
                return {
                  stdout: args[0] === "show-user" ? input.display : (input.session ?? ""),
                  stderr: refused ? (input.userError ?? "") : "",
                  code: ChildProcessSpawner.ExitCode(refused ? 1 : 0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        ),
        ServerSettings.layerTest({ machinePlacementRole: input.role }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-presence-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

const read = Effect.flatMap(MachinePresence, (presence) => presence.read);

describe("MachinePresence", () => {
  it.effect("treats a Linux machine without a graphical login as headless", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* read, { placementRole: "headless" });
    }).pipe(Effect.provide(linux({ role: "auto", display: "\n" }))),
  );

  it.effect("does not count an SSH or other text login as someone at the machine", () =>
    Effect.gen(function* () {
      for (const session of ["Type=tty\nRemote=yes\nActive=yes\n", "Type=wayland\nRemote=yes\n"]) {
        const shown = yield* read.pipe(
          Effect.provide(linux({ role: "auto", display: "c41\n", session })),
        );
        assert.deepStrictEqual(shown, { placementRole: "headless" });
      }
    }),
  );

  it.effect("counts a machine logind cannot describe as someone's, in use", () =>
    Effect.gen(function* () {
      const unknown = yield* read.pipe(
        Effect.provide(linux({ role: "auto", display: "", userError: "Failed to connect to bus" })),
      );
      assert.deepStrictEqual(unknown, { placementRole: "interactive", humanActive: true });
      const loggedOut = yield* read.pipe(
        Effect.provide(
          linux({ role: "auto", display: "", userError: "User 1000 is not logged in." }),
        ),
      );
      assert.deepStrictEqual(loggedOut, { placementRole: "headless" });
    }),
  );

  it.effect("protects a graphical login unless its person is idle, locked or away", () =>
    Effect.gen(function* () {
      const inUse = yield* read.pipe(
        Effect.provide(
          linux({
            role: "auto",
            display: "2\n",
            session: "Type=wayland\nRemote=no\nActive=yes\nLockedHint=no\nIdleHint=no\n",
          }),
        ),
      );
      assert.deepStrictEqual(inUse, { placementRole: "interactive", humanActive: true });
      for (const away of ["Active=no", "LockedHint=yes", "IdleHint=yes"]) {
        const idle = yield* read.pipe(
          Effect.provide(linux({ role: "auto", display: "2\n", session: `Type=x11\n${away}\n` })),
        );
        assert.deepStrictEqual(idle, { placementRole: "interactive", humanActive: false });
      }
    }),
  );

  it.effect("follows an explicit role without probing for a person on a headless machine", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const headless = yield* read.pipe(
        Effect.provide(linux({ role: "headless", display: "2\n", calls })),
      );
      assert.deepStrictEqual(headless, { placementRole: "headless" });
      assert.deepStrictEqual(calls, []);
      // An interactive machine with nobody logged in graphically has nobody to disturb.
      const interactive = yield* read.pipe(
        Effect.provide(linux({ role: "interactive", display: "" })),
      );
      assert.deepStrictEqual(interactive, { placementRole: "interactive", humanActive: false });
    }),
  );
});
