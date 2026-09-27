import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

const linuxRuntime = "/home/theo/.t3/runtime/versions/1.2.3/t3";
const linuxPlan = {
  program: [linuxRuntime, "__service-launcher"],
  baseDir: "/home/theo/.t3",
  logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/home/theo/.config/systemd/user/t3code.service",
};

it("runs the pinned runtime's own executable as the systemd launcher", () => {
  const unit = BootService.renderBootServiceUnit(linuxPlan);

  expect(unit).toContain(`ExecStart=${linuxRuntime} __service-launcher`);
  expect(unit).toContain("KillMode=mixed");
  expect(unit).not.toContain("node");
});

it("reads the served T3 home back out of a rendered unit or plist", () => {
  const plan = (baseDir: string) => ({
    program: [`${baseDir}/runtime/versions/1.2.3/t3`, "__service-launcher"],
    baseDir,
    logPath: `${baseDir}/userdata/logs/boot-service.log`,
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(
    BootService.bootServiceBaseDirOf(BootService.renderBootServiceUnit(plan("/home/theo/.t3"))),
  ).toBe("/home/theo/.t3");
  // Spaces and specifiers are quoted and escaped on the way in.
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/theo/T3 Data/100%")),
    ),
  ).toBe("/home/theo/T3 Data/100%");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServicePlist(plan("/Users/theo/a&b"), {
        homeDir: "/Users/theo",
        environmentPath: "/usr/bin",
      }),
    ),
  ).toBe("/Users/theo/a&b");
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();
});

it("survives the kernel OOM-killing a greedy agent child", () => {
  const unit = BootService.renderBootServiceUnit(linuxPlan);

  expect(unit).toContain("OOMPolicy=continue");
});

const macRuntime = "/Users/theo/.t3/runtime/versions/1.2.3/t3";
const macPlan = {
  program: [macRuntime, "__service-launcher"],
  baseDir: "/Users/theo/.t3",
  logPath: "/Users/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/Users/theo/Library/LaunchAgents/com.t3tools.t3code.service.plist",
};
const macInstallerPath =
  "/opt/homebrew/bin:/Users/theo/.npm-global/bin:/Users/theo/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin";
const macRenderOptions = { homeDir: "/Users/theo", environmentPath: macInstallerPath };

it("runs the pinned runtime's own executable as the launch agent", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(
    `  <array>\n    <string>${macRuntime}</string>\n    <string>__service-launcher</string>\n  </array>`,
  );
  expect(plist).not.toContain("node</string>");
});

it("preserves the installer's provider search path in the launch agent", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(`    <key>PATH</key>\n    <string>${macInstallerPath}</string>`);
});

it("restarts the launch agent on the systemd cadence", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>5</integer>");
  expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>90</integer>");
});

it("appends both stdio streams to the boot service log", () => {
  const plist = BootService.renderBootServicePlist(macPlan, macRenderOptions);

  expect(plist).toContain(
    "<key>StandardOutPath</key>\n  <string>/Users/theo/.t3/userdata/logs/boot-service.log</string>",
  );
  expect(plist).toContain(
    "<key>StandardErrorPath</key>\n  <string>/Users/theo/.t3/userdata/logs/boot-service.log</string>",
  );
});

it("escapes XML in host paths", () => {
  const plist = BootService.renderBootServicePlist(
    { ...macPlan, baseDir: "/Users/theo/T3 & <Co>" },
    { homeDir: "/Users/theo", environmentPath: "/Users/theo/Tools & <Scripts>:/usr/bin" },
  );

  expect(plist).toContain("<string>/Users/theo/T3 &amp; &lt;Co&gt;</string>");
  expect(plist).toContain("<string>/Users/theo/Tools &amp; &lt;Scripts&gt;:/usr/bin</string>");
});

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  installerPath = macInstallerPath,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  // A complete pinned runtime is already present, so install only validates
  // it and never downloads a release archive.
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", platform);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const timeouts = new Map<string, unknown>();
  const control: {
    failCommand: string | undefined;
    timedOutCommand: string | undefined;
    stateAfterStop?: string;
    linger: string;
    enabled: boolean;
    active: boolean;
    systemdShow: string | undefined;
    systemdExecStartPath: string | undefined;
    launchdDomainPresent: boolean;
    launchdDomainStderr: string;
    launchdJob: "running" | "stopped" | "not-loaded" | "malformed" | "permission";
    launchdJobStderr: string;
    launchdProgramPath: string | undefined;
    launchdDisabled: boolean;
  } = {
    failCommand: undefined,
    timedOutCommand: undefined,
    linger: "yes",
    enabled: true,
    active: true,
    systemdShow: undefined,
    systemdExecStartPath: undefined,
    launchdDomainPresent: true,
    launchdDomainStderr: "",
    launchdJob: "running",
    launchdJobStderr: "Operation not permitted",
    launchdProgramPath: undefined,
    launchdDisabled: false,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      const command = `${input.command} ${input.args.join(" ")}`;
      commands.push(command);
      timeouts.set(command, input.timeout);
      const timedOut = control.timedOutCommand === command;
      const failed = !timedOut && command === control.failCommand;
      if (!failed && !timedOut && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && !timedOut && command === "systemctl --user enable t3code.service")
        control.enabled = true;
      if (!failed && !timedOut && command === "systemctl --user restart t3code.service")
        control.active = true;
      if (
        control.stateAfterStop !== undefined &&
        (command === "systemctl --user stop t3code.service" ||
          command.startsWith("launchctl bootout --wait "))
      ) {
        yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
      }
      if (timedOut) {
        return {
          stdout: "",
          stderr: "",
          code: null,
          timedOut: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }
      const ok = (stdout: string) => ({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
      const status = (stdout: string, code: number, stderr = "") => ({
        ...ok(stdout),
        stderr,
        code: ChildProcessSpawner.ExitCode(code),
      });
      if (failed) return status("", 1);
      // Manager observation probes. These mirror the real commands and let the
      // tests exercise running/enabled/identity divergence without a host.
      if (
        input.command === "systemctl" &&
        input.args[1] === "show" &&
        input.args[2] === "t3code.service"
      ) {
        return ok(
          control.systemdShow ??
            [
              "LoadState=loaded",
              `ActiveState=${control.active ? "active" : "inactive"}`,
              `SubState=${control.active ? "running" : "dead"}`,
              `UnitFileState=${control.enabled ? "enabled" : "disabled"}`,
              `ExecStart={ path=${control.systemdExecStartPath ?? runtime.entryPath} ; argv[]=${runtime.entryPath} __service-launcher ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(never) ; status=0/0 }`,
              "NRestarts=0",
              "Result=success",
            ].join("\n"),
        );
      }
      if (
        input.command === "launchctl" &&
        input.args[0] === "print" &&
        input.args[1] === "gui/501"
      ) {
        return control.launchdDomainPresent
          ? ok("gui/501 = {\n\ttype = login\n}\n")
          : status("", 1, control.launchdDomainStderr);
      }
      if (
        input.command === "launchctl" &&
        input.args[0] === "print" &&
        input.args[1] === "gui/501/com.t3tools.t3code.service"
      ) {
        if (control.launchdJob === "not-loaded") return status("", 1);
        if (control.launchdJob === "permission") return status("", 1, control.launchdJobStderr);
        if (control.launchdJob === "malformed") return ok("this is not launchctl output\n");
        const state =
          control.launchdJob === "running"
            ? "state = running\n\n\tpid = 4321\n"
            : "state = not running\n";
        return ok(
          `gui/501/com.t3tools.t3code.service = {\n\tactive count = ${
            control.launchdJob === "running" ? "1" : "0"
          }\n\ttype = LaunchAgent\n\t${state}\tprogram = ${
            control.launchdProgramPath ?? runtime.entryPath
          }\n\tlast exit code = 0\n}\n`,
        );
      }
      if (
        input.command === "launchctl" &&
        input.args[0] === "print-disabled" &&
        input.args[1] === "gui/501"
      ) {
        return ok(
          `disabled services = {\n\t"com.t3tools.t3code.service" => ${
            control.launchdDisabled ? "true" : "false"
          }\n}\n`,
        );
      }
      return {
        stdout:
          input.args[0] === "--version"
            ? // The runtime under test reports the version of the directory it
              // was launched from, like the real executable.
              `t3 v${/versions\/([^/]+)\//.exec(input.command)?.[1] ?? "1.2.3"}\n`
            : input.command === "loginctl" && input.args[0] === "show-user"
              ? `${control.linger}\n`
              : input.args[1] === "is-enabled"
                ? control.enabled
                  ? "enabled\n"
                  : "disabled\n"
                : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(
          failed || (input.args[1] === "is-active" && !control.active) ? 1 : 0,
        ),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
  });
  const makeService = (
    environmentPath: string | undefined = installerPath,
    cliVersion = "1.2.3",
    serviceBaseDir = baseDir,
  ) =>
    Effect.gen(function* () {
      // Every version the tests install is present and verified on disk, so
      // install never downloads.
      const paths = pinnedRuntimePaths(path, serviceBaseDir, cliVersion, platform);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, `${cliVersion}\n`);
      return yield* BootService.make({
        baseDir: serviceBaseDir,
        logsDir: path.join(serviceBaseDir, "userdata", "logs"),
        cliVersion,
        host: { execPath: "/usr/bin/t3" },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, platform),
          Layer.succeed(HostProcessUserId, 501),
          Layer.succeed(HostProcessExecutablePath, "/usr/bin/t3"),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no release download expected")),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                ...(environmentPath === undefined || environmentPath === ""
                  ? {}
                  : { PATH: environmentPath }),
              },
            }),
          ),
        ),
      ),
    );
  const service = yield* makeService();
  return { service, makeService, fs, home, statePath, commands, timeouts, control, runtime };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect(
    "fails before installing files or validating a runtime when lingering needs an administrator",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, runtime } = yield* makeHarness();
        const before = yield* service.status;
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";
        yield* fs.remove(runtime.sentinelPath);

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServicePrerequisiteError",
          problem: "linger-disabled",
        });
        expect(error.message).toContain('sudo loginctl enable-linger "$(id -un)"');
        expect(error.message).toContain("last login session ends");
        expect(yield* fs.exists(before.unitPath)).toBe(false);
        expect(yield* fs.exists(statePath)).toBe(false);
        expect(commands.some((command) => command.includes("--version"))).toBe(false);
        expect(
          commands.some(
            (command) => command.includes("daemon-reload") || command.includes("restart"),
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(before.logPath)).toContain("[linger-disabled]");
      }),
  );

  it.effect(
    "detects a partial install and preserves the running service when repair lacks permission",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness();
        const plan = yield* service.install();
        const before = yield* fs.readFileString(statePath);
        const unit = yield* fs.readFileString(plan.unitPath);
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";

        expect(yield* service.status).toMatchObject({
          current: false,
          problems: ["linger-disabled"],
        });
        commands.length = 0;
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          "BootServicePrerequisiteError",
        );
        expect(yield* fs.readFileString(statePath)).toBe(before);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(commands).not.toContain("systemctl --user stop t3code.service");
      }),
  );

  it.effect("enables lingering before installing and repairs stopped or disabled services", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      control.linger = "no";
      yield* service.install();
      expect(control.linger).toBe("yes");
      expect(commands.indexOf("loginctl enable-linger --no-ask-password 501")).toBeLessThan(
        commands.indexOf("systemctl --user daemon-reload"),
      );

      control.enabled = false;
      control.active = false;
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["service-disabled", "service-stopped"],
      });
      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each([
    { command: "systemctl --user show-environment", problem: "user-manager-unavailable" },
    { command: "loginctl show-user 501 --property=Linger --value", problem: "linger-unavailable" },
  ])("reports failed prerequisite probes without installing: $command", ({ command, problem }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness();
      control.failCommand = command;
      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem,
      });
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, timeouts, runtime } = yield* makeHarness();
      const plan = yield* service.install();

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(plan.program).toEqual([runtime.entryPath, "__service-launcher"]);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `ExecStart=${runtime.entryPath} __service-launcher`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      // The stop can block up to systemd's 90s TimeoutStopSec; the runner's
      // 60s default would cancel it mid-shutdown.
      expect(timeouts.get("systemctl --user disable --now t3code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "reports the installed version across launcher protocols on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath } = yield* makeHarness(platform);
        yield* service.install();

        for (const protocol of [SERVICE_LAUNCHER_PROTOCOL - 1, SERVICE_LAUNCHER_PROTOCOL + 1]) {
          yield* fs.writeFileString(
            statePath,
            `{"protocol":${protocol},"activeVersion":"1.2.4-nightly.1","update":{"status":"unknown"}}`,
          );
          expect(yield* service.status).toMatchObject({
            current: false,
            installedVersion: "1.2.4-nightly.1",
          });
        }
      }),
  );

  it.effect("reports an unknown version for invalid service state", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();

      for (const stateText of [
        "{",
        '{"activeVersion":"latest"}',
        '{"activeVersion":"1.2"}',
        '{"activeVersion":123}',
      ]) {
        yield* fs.writeFileString(statePath, stateText);
        const status = yield* service.status;
        expect(status.current).toBe(false);
        expect(status.installedVersion).toBeUndefined();
      }
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "preserves a newer version that finishes updating during stop on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness(platform);
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        control.stateAfterStop = `{"protocol":${SERVICE_LAUNCHER_PROTOCOL + 1},"activeVersion":"1.2.4"}`;
        commands.length = 0;

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "1.2.4",
          targetVersion: "1.2.3",
        });
        expect(yield* fs.readFileString(statePath)).toBe(control.stateAfterStop);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(
          commands.filter(
            (command) =>
              command.startsWith(platform === "linux" ? "systemctl " : "launchctl ") &&
              !command.includes("show-environment"),
          ),
        ).toEqual(
          platform === "linux"
            ? ["systemctl --user stop t3code.service", "systemctl --user restart t3code.service"]
            : [
                "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
                `launchctl bootstrap gui/501 ${plan.unitPath}`,
              ],
        );
      }),
  );

  it.effect("allows an explicit downgrade", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.4"}`,
      );

      yield* service.install({ allowDowngrade: true });

      expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe("1.2.3");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("repairs versions with equal SemVer precedence without an override", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.3+previous-build"}`,
      );

      yield* service.install();

      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("install with start=false rewrites the files and marks a restart pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;

      const newer = yield* makeService(undefined, "1.2.4");
      const plan = yield* newer.install({ start: false });

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.4",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/t3");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([]);
      // The files say 1.2.4 but the process is still 1.2.3: not current, and
      // the reason is named so `t3 service status` can point at restart.
      const status = yield* newer.status;
      expect(status.current).toBe(false);
      expect(status.problems).toContain("restart-pending");

      commands.length = 0;
      expect(yield* newer.restart).toBe(true);
      expect((yield* newer.status).problems).not.toContain("restart-pending");
      expect((yield* newer.status).current).toBe(true);
    }),
  );

  it.effect("install with start=false keeps the marker when a later write fails", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const newer = yield* makeService(undefined, "1.2.4");
      // A non-empty directory in the unit's place: it still counts as an
      // installed unit, and the rename that writes the new unit fails.
      const unitPath = (yield* service.status).unitPath;
      yield* fs.remove(unitPath);
      yield* fs.makeDirectory(unitPath);
      yield* fs.writeFileString(path.join(unitPath, "occupied"), "");

      const error = yield* newer.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceInstallError");
      expect(
        yield* fs.exists(path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE)),
      ).toBe(true);
    }),
  );

  it.effect("install with start=false refuses while a remote update is pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);

      const error = yield* service.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceUpdatePendingError");
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
    }),
  );

  it.effect("restart stops and starts an installed service, and is a no-op otherwise", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeHarness();
      expect(yield* service.restart).toBe(false);
      yield* service.install();
      commands.length = 0;

      expect(yield* service.restart).toBe(true);
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user enable t3code.service",
        "systemctl --user restart t3code.service",
      ]);
    }),
  );

  it.effect("restart leaves a service that serves another T3 home alone", () =>
    Effect.gen(function* () {
      const { service, fs, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      expect(yield* other.restart).toBe(false);
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([]);
    }),
  );

  it.effect("restart brings the service back when activation fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.restart.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart t3code.service",
      ]);
    }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart t3code.service",
      ]);
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install();
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(
          commands.filter(
            (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
          ),
        ).toEqual([
          "systemctl --user stop t3code.service",
          "systemctl --user restart t3code.service",
        ]);
      }
    }),
  );

  it.effect("fails closed on Windows", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("win32");
      expect((yield* service.status).supported).toBe(false);
      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
    }),
  );

  it.effect("installs, reports current state, and uninstalls on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts, runtime } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();

      expect(
        plan.unitPath.endsWith(
          path.join("Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <key>PATH</key>\n    <string>${macInstallerPath}:/usr/local/bin:/usr/sbin:/sbin</string>`,
      );
      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <string>${runtime.entryPath}</string>\n    <string>__service-launcher</string>`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("systemctl "))).toBe(false);
      // A bootout can block up to the plist's 90s ExitTimeOut; the runner's
      // 60s default would cancel it and let bootstrap race a loaded job.
      expect(timeouts.get("launchctl bootout --wait gui/501/com.t3tools.t3code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect("restarts the launch agent when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness("darwin");
      yield* service.install();
      const plistPath = (yield* service.status).unitPath;
      commands.length = 0;
      control.failCommand = `launchctl bootstrap gui/501 ${plistPath}`;

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
        "launchctl enable gui/501/com.t3tools.t3code.service",
        `launchctl bootstrap gui/501 ${plistPath}`,
        `launchctl bootstrap gui/501 ${plistPath}`,
      ]);
    }),
  );

  it.effect("reconstructs a launch agent search path when the installer has no PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("adds missing provider directories to a minimal installer PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "/usr/bin:/bin");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps an installed launch agent current when the process PATH changes", () =>
    Effect.gen(function* () {
      const { service, makeService } = yield* makeHarness("darwin");
      yield* service.install();

      const restartedService = yield* makeService("/usr/local/bin:/usr/bin:/bin");
      expect((yield* restartedService.status).current).toBe(true);
    }),
  );

  it.effect("drops PATH directories that cannot be represented in a launch agent plist", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness(
        "darwin",
        "/opt/homebrew/bin:/Users/theo/\u0001invalid:/usr/bin",
      );
      const plan = yield* service.install();
      const plist = yield* fs.readFileString(plan.unitPath);

      expect(plist).toContain(
        "    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect(plist).not.toContain("\u0001");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("ignores a bootout for an agent that is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.failCommand = "launchctl bootout --wait gui/501/com.t3tools.t3code.service";

      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("restarts without overwriting a pending remote update on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness("darwin");
      yield* service.install();
      const plistPath = (yield* service.status).unitPath;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
          "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
          `launchctl bootstrap gui/501 ${plistPath}`,
        ]);
      }
    }),
  );
});

it("parses only well-formed manager output and exact versions", () => {
  expect(BootService.parseSystemdShow("no anchors here")).toBeUndefined();
  expect(BootService.parseSystemdShow("LoadState=loaded\nActiveState=active")).toMatchObject({
    loadState: "loaded",
    activeState: "active",
  });
  expect(BootService.parseLaunchdPrint("this is not launchctl output")).toBeUndefined();
  expect(BootService.parseLaunchdPrint("\tstate = running\n\tpid = 12\n")).toMatchObject({
    state: "running",
    pid: 12,
  });
  expect(
    BootService.parseLaunchdDisabled(
      'disabled services = {\n\t"com.t3tools.t3code.service" => true\n}',
      "com.t3tools.t3code.service",
    ),
  ).toBe(true);
  expect(
    BootService.parseLaunchdDisabled("disabled services = {}", "com.t3tools.t3code.service"),
  ).toBeUndefined();
  expect(
    BootService.bootServiceVersionFromProgramPath("/home/x/.t3/runtime/versions/1.2.3/t3"),
  ).toBe("1.2.3");
  expect(BootService.bootServiceVersionFromProgramPath("/usr/bin/node")).toBeUndefined();
  expect(BootService.launchdPermissionDenied("Operation not permitted")).toBe(true);
  expect(BootService.launchdPermissionDenied("Could not find service")).toBe(false);
  expect(
    BootService.bootServiceProgramInBaseDir(
      "/home/x/.t3/runtime/versions/1.2.3/t3",
      "/home/x/.t3",
      "/",
    ),
  ).toBe(true);
  expect(
    BootService.bootServiceProgramInBaseDir(
      "/other/.t3/runtime/versions/1.2.3/t3",
      "/home/x/.t3",
      "/",
    ),
  ).toBe(false);
});

const SYSTEMD_SHOW_PROPERTY =
  "systemctl --user show t3code.service --property=LoadState,ActiveState,SubState,UnitFileState,ExecStart,NRestarts,Result";

it.layer(NodeServices.layer)("boot service status observations", (it) => {
  it.effect("separates identity from a stopped Linux manager state", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness();
      yield* service.install();
      control.active = false;

      const status = yield* service.status;

      expect(status).toMatchObject({
        schemaVersion: BootService.BOOT_SERVICE_STATUS_SCHEMA_VERSION,
        supported: true,
        manager: "systemd",
        installed: true,
        enabled: "enabled",
        running: "stopped",
        current: false,
        installedVersion: "1.2.3",
        runningVersion: "1.2.3",
      });
      expect(status.problems).toContain("service-stopped");
      expect(status.observation?.restartCount).toBe(0);
      expect(status.observation?.source).toBe("systemctl --user show t3code.service");
    }),
  );

  it.effect("reports linger-disabled without hiding the running manager state", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness();
      yield* service.install();
      control.linger = "no";

      const status = yield* service.status;

      expect(status.problems).toContain("linger-disabled");
      expect(status.running).toBe("running");
      expect(status.enabled).toBe("enabled");
    }),
  );

  it.effect("does not call a Mac job running when the launch agent is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.launchdJob = "not-loaded";

      const status = yield* service.status;

      expect(status).toMatchObject({
        schemaVersion: BootService.BOOT_SERVICE_STATUS_SCHEMA_VERSION,
        manager: "launchd",
        installed: true,
        running: "not-loaded",
        enabled: "enabled",
      });
      expect(status.observation).toMatchObject({
        reachable: true,
        running: "not-loaded",
        detail: "launch-agent-not-loaded",
      });
    }),
  );

  it.effect("reports an unavailable GUI login domain as unknown, never healthy", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.launchdDomainPresent = false;

      const status = yield* service.status;

      expect(status).toMatchObject({ manager: "launchd", running: "unknown", enabled: "unknown" });
      expect(status.observation).toMatchObject({
        reachable: false,
        running: "unknown",
        detail: "gui-login-domain-unavailable",
      });
    }),
  );

  it.effect("keeps a Mac stopped job distinct from a missing one and observes its version", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.launchdJob = "stopped";

      const status = yield* service.status;

      expect(status).toMatchObject({ running: "stopped", enabled: "enabled" });
      expect(status.observation?.detail).toBeUndefined();
      expect(status.runningVersion).toBe("1.2.3");
    }),
  );

  it.effect("reports command failure, timeout and malformed output as unknown", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness();
      yield* service.install();

      control.failCommand = SYSTEMD_SHOW_PROPERTY;
      expect((yield* service.status).observation).toMatchObject({
        reachable: false,
        running: "unknown",
        detail: "manager-unreachable",
      });

      control.failCommand = undefined;
      control.timedOutCommand = SYSTEMD_SHOW_PROPERTY;
      expect((yield* service.status).observation).toMatchObject({
        running: "unknown",
        detail: "manager-timeout",
      });
      control.timedOutCommand = undefined;

      control.systemdShow = "not key=value output";
      expect((yield* service.status).observation).toMatchObject({
        reachable: true,
        running: "unknown",
        detail: "manager-output-malformed",
      });
    }),
  );

  it.effect("does not let the launcher state file prove the running artifact", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, runtime } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.4"}`,
      );

      const status = yield* service.status;

      // The state file claims 1.2.4 and the manager reports the installed
      // runtime path at 1.2.3: installed/current identity and observed running
      // identity are different claims.
      expect(status.installedVersion).toBe("1.2.4");
      expect(status.runningVersion).toBe("1.2.3");
      expect(runtime.entryPath).toContain("versions/1.2.3");
      expect(status.current).toBe(false);
    }),
  );

  it.effect("binds identity to the selected T3 home and never calls a foreign home current", () =>
    Effect.gen(function* () {
      const { service, fs, home, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      const status = yield* other.status;

      expect(status.installed).toBe(true);
      expect(status.installedBaseDir).toBe(path.join(home, ".t3"));
      expect(status.current).toBe(false);
    }),
  );

  it.effect("fails closed on Windows with unknown manager observations", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("win32");

      const status = yield* service.status;

      expect(status).toMatchObject({
        schemaVersion: BootService.BOOT_SERVICE_STATUS_SCHEMA_VERSION,
        supported: false,
        manager: "unsupported",
        installed: false,
        running: "unknown",
        enabled: "unknown",
        current: false,
      });
      expect(status.observation).toBeUndefined();
    }),
  );

  it.effect("reports a launchctl permission refusal as unknown, never a missing domain", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.launchdDomainPresent = false;
      control.launchdDomainStderr = "launchctl: Operation not permitted";

      const status = yield* service.status;

      expect(status).toMatchObject({ manager: "launchd", running: "unknown", enabled: "unknown" });
      expect(status.observation).toMatchObject({
        reachable: true,
        running: "unknown",
        detail: "manager-permission-denied",
      });
    }),
  );

  it.effect("reports a launchctl permission refusal on the job as unknown, not not-loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.launchdJob = "permission";

      const status = yield* service.status;

      expect(status).toMatchObject({ running: "unknown", enabled: "enabled" });
      expect(status.observation).toMatchObject({
        reachable: true,
        running: "unknown",
        detail: "manager-permission-denied",
      });
    }),
  );

  it.effect("does not publish a running version from a different T3 home", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.launchdProgramPath = "/Volumes/other/.t3/runtime/versions/9.9.9/t3";

      const status = yield* service.status;

      expect(status.running).toBe("running");
      expect(status.runningVersion).toBeUndefined();
      expect(status.observation).toMatchObject({
        reachable: true,
        running: "running",
        detail: "running-from-different-home",
      });
    }),
  );

  it.effect("does not publish a running version when systemd points at a different home", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness();
      yield* service.install();
      control.systemdExecStartPath = "/srv/other/.t3/runtime/versions/9.9.9/t3";

      const status = yield* service.status;

      expect(status.running).toBe("running");
      expect(status.runningVersion).toBeUndefined();
      expect(status.observation?.detail).toBe("running-from-different-home");
    }),
  );
});
