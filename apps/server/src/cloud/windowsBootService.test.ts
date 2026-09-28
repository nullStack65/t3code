import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
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
  parseScQc,
  parseScQuery,
  isQualifiedWindowsAccount,
  normalizeWindowsImagePath,
  quoteWindowsArgument,
  renderWindowsServiceImagePath,
  scRunningState,
  scServiceDoesNotExist,
  windowsRegistrationMatchesOurBinding,
  windowsServiceHelperPath,
  WINDOWS_BOOT_SERVICE_NAME,
  type WindowsBootServiceBinding,
} from "./windowsBootService.ts";

it("parses only well-formed sc.exe output", () => {
  expect(parseScQuery("  STATE              : 4  RUNNING\n  PID : 4321\n")).toEqual({
    state: "RUNNING",
    stateCode: 4,
    processId: 4321,
  });
  expect(parseScQuery("garbage\n")).toBeUndefined();
  expect(parseScQuery("  STATE   : 1  STOPPED\n")).toEqual({ state: "STOPPED", stateCode: 1 });

  const qc = parseScQc(
    [
      "SERVICE_NAME: T3Code",
      "        START_TYPE         : 2   AUTO_START",
      '        BINARY_PATH_NAME   : "C:\\t3\\host.exe" --home "C:\\t3\\home"',
      "        SERVICE_START_NAME : NT AUTHORITY\\LocalService",
    ].join("\n"),
  );
  expect(qc).toEqual({
    startType: "2   AUTO_START",
    binaryPathName: '"C:\\t3\\host.exe" --home "C:\\t3\\home"',
    serviceStartName: "NT AUTHORITY\\LocalService",
  });
  expect(parseScQc("nothing here")).toBeUndefined();
});

it("maps sc.exe state and absence tokens honestly", () => {
  expect(scRunningState("RUNNING")).toBe("running");
  expect(scRunningState("STOPPED")).toBe("stopped");
  expect(scRunningState("START_PENDING")).toBe("transitioning");
  expect(scRunningState("WHO_KNOWS")).toBe("unknown");
  expect(scServiceDoesNotExist(1060, "", "")).toBe(true);
  expect(
    scServiceDoesNotExist(1, "", "The specified service does not exist as an installed service."),
  ).toBe(true);
  expect(scServiceDoesNotExist(1, "", "Access is denied.")).toBe(false);
});

it("binds only an exact home/helper/runtime image path", () => {
  const binding: WindowsBootServiceBinding = {
    hostPath: "C:\\t3\\runtime\\versions\\1.2.3\\t3-windows-service-host.exe",
    homeDir: "C:\\Users\\theo\\.t3",
    runtimePath: "C:\\t3\\runtime\\versions\\1.2.3\\t3.exe",
    logPath: "C:\\Users\\theo\\.t3\\userdata\\logs\\boot-service.log",
    serviceName: WINDOWS_BOOT_SERVICE_NAME,
    account: "DOMAIN\\svc",
  };
  const image = renderWindowsServiceImagePath(binding);
  expect(windowsRegistrationMatchesOurBinding({ binaryPathName: image }, binding)).toBe(true);
  expect(
    windowsRegistrationMatchesOurBinding(
      { binaryPathName: image.replace("C:\\Users\\theo\\.t3", "C:\\Users\\other\\.t3") },
      binding,
    ),
  ).toBe(false);
  expect(windowsRegistrationMatchesOurBinding({}, binding)).toBe(false);
  expect(normalizeWindowsImagePath(`"C:\\a b\\host.exe --home x"`)).toBe(
    `C:\\a b\\host.exe --home x`,
  );
  expect(quoteWindowsArgument("a b")).toBe('"a b"');
});

it("requires a qualified service account", () => {
  expect(isQualifiedWindowsAccount("DOMAIN\\svc")).toBe(true);
  expect(isQualifiedWindowsAccount("svc@domain.example")).toBe(true);
  expect(isQualifiedWindowsAccount("svc")).toBe(false);
  expect(isQualifiedWindowsAccount("")).toBe(false);
  expect(isQualifiedWindowsAccount(undefined)).toBe(false);
});

interface ScmControl {
  registered: boolean;
  qcImagePath: string | undefined;
  startType: string;
  queryState: string;
  failQuery: boolean;
  timeoutQuery: boolean;
  stateAfterStop?: string;
}

const makeHarness = Effect.fn("test.make_windows_boot_service_harness")(function* (options?: {
  account?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-service-test-" });
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", "win32");
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "MZ fake t3.exe");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");
  const helperPath = windowsServiceHelperPath(runtime.entryPath, path);
  yield* fs.writeFileString(helperPath, "MZ fake host");

  const binding: WindowsBootServiceBinding = {
    hostPath: helperPath,
    homeDir: baseDir,
    runtimePath: runtime.entryPath,
    logPath: path.join(baseDir, "userdata", "logs", "boot-service.log"),
    serviceName: WINDOWS_BOOT_SERVICE_NAME,
    ...(options?.account === undefined ? {} : { account: options.account }),
  };
  const ourImagePath = renderWindowsServiceImagePath(binding);
  const control: ScmControl = {
    registered: false,
    qcImagePath: undefined,
    startType: "2   AUTO_START",
    queryState: "4  RUNNING",
    failQuery: false,
    timeoutQuery: false,
  };
  const commands: string[] = [];
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
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_windows_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      commands.push(`${input.command} ${input.args.join(" ")}`);
      if (input.command === "sc.exe") {
        const sub = input.args[0];
        if (sub === "qc" || sub === "queryex") {
          if (control.timeoutQuery)
            return { ...ok(""), timedOut: true, code: null, stdout: "", stderr: "" };
          if (control.failQuery) return status("", 1, "Access is denied.");
          if (!control.registered)
            return status(
              "",
              1060,
              "The specified service does not exist as an installed service.",
            );
          if (sub === "qc")
            return ok(
              [
                `SERVICE_NAME: ${WINDOWS_BOOT_SERVICE_NAME}`,
                `        START_TYPE         : ${control.startType}`,
                `        BINARY_PATH_NAME   : ${control.qcImagePath ?? ourImagePath}`,
                `        SERVICE_START_NAME : NT AUTHORITY\\LocalService`,
              ].join("\n"),
            );
          return ok(
            `SERVICE_NAME: ${WINDOWS_BOOT_SERVICE_NAME}\n        STATE              : ${control.queryState}\n`,
          );
        }
        if (sub === "create") {
          control.registered = true;
          return ok("CreateService SUCCESS");
        }
        if (sub === "config") return ok("ChangeServiceConfig SUCCESS");
        if (sub === "start") return ok("StartService SUCCESS");
        if (sub === "stop") {
          if (control.stateAfterStop !== undefined)
            yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
          return ok("StopService SUCCESS");
        }
        if (sub === "delete") {
          control.registered = false;
          return ok("DeleteService SUCCESS");
        }
        return ok("");
      }
      // Pinned-runtime validation.
      if (input.args[0] === "--version") return ok("t3 v1.2.3\n");
      return ok("");
    }),
  });

  const makeService = (account: string | undefined = options?.account, cliVersion = "1.2.3") =>
    BootService.make({
      baseDir,
      logsDir: path.join(baseDir, "userdata", "logs"),
      cliVersion,
      host: { execPath: helperPath },
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessUserId, undefined as unknown as number),
          Layer.succeed(HostProcessExecutablePath, helperPath),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no release download expected")),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                PATH: "C:\\Windows\\System32",
                ...(account === undefined ? {} : { T3_SERVICE_ACCOUNT: account }),
              },
            }),
          ),
        ),
      ),
    );

  return {
    makeService,
    fs,
    baseDir,
    statePath,
    helperPath,
    binding,
    ourImagePath,
    control,
    commands,
  };
});

it.layer(NodeServices.layer)("windows SCM boot service", (it) => {
  it.effect("refuses selection and mutations without a qualified account", () =>
    Effect.gen(function* () {
      const { makeService, fs, statePath } = yield* makeHarness();
      const service = yield* makeService(undefined);
      const status = yield* service.status;
      expect(status).toMatchObject({ supported: false, manager: "unsupported", installed: false });
      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("reports absent, then registers and starts an exact binding", () =>
    Effect.gen(function* () {
      const { makeService, fs, statePath, control, commands, ourImagePath } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      const service = yield* makeService();
      expect(yield* service.status).toMatchObject({
        supported: true,
        manager: "scm",
        installed: false,
        running: "not-loaded",
      });

      const plan = yield* service.install();
      expect(control.registered).toBe(true);
      expect(plan.program[0]).toBe(plan.unitPath);
      const create = commands.find((command) => command.startsWith("sc.exe create T3Code "));
      expect(create).toContain("binPath=");
      expect(create).toContain(ourImagePath);
      expect(create).toContain("obj= DOMAIN\\svc");
      expect(commands.indexOf(create ?? "")).toBeLessThan(
        commands.findIndex((command) => command.startsWith("sc.exe start T3Code")),
      );
      expect(yield* service.status).toMatchObject({ installed: true, current: true });
      expect((yield* fs.readFileString(statePath)).length).toBeGreaterThan(0);
    }),
  );

  it.effect("blocks install when the T3 host helper is not shipped", () =>
    Effect.gen(function* () {
      const { makeService, fs, helperPath, statePath } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      yield* fs.remove(helperPath);
      const service = yield* makeService();
      const error = yield* service.install().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem: "service-helper-missing",
      });
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("refuses a foreign registration instead of overwriting or deleting it", () =>
    Effect.gen(function* () {
      const { makeService, control, commands } = yield* makeHarness({ account: "DOMAIN\\svc" });
      control.registered = true;
      control.qcImagePath =
        '"C:\\Users\\other\\.t3\\t3-windows-service-host.exe" --home C:\\Users\\other\\.t3';
      const service = yield* makeService();

      expect(yield* service.status).toMatchObject({
        installed: true,
        current: false,
        problems: ["windows-service-foreign-registration"],
      });
      commands.length = 0;
      const installError = yield* service.install().pipe(Effect.flip);
      expect(installError).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem: "windows-service-foreign-registration",
      });
      expect(yield* service.restart).toBe(false);
      expect(yield* service.uninstall).toBe(false);
      expect(commands.some((command) => command.startsWith("sc.exe delete"))).toBe(false);
    }),
  );

  it.effect("treats a failed query as unknown, never as absent or healthy", () =>
    Effect.gen(function* () {
      const { makeService, control } = yield* makeHarness({ account: "DOMAIN\\svc" });
      control.failQuery = true;
      const service = yield* makeService();
      const status = yield* service.status;
      expect(status.running).toBe("unknown");
      expect(status.observation?.reachable).toBe(true);
      expect(status.problems).toContain("windows-service-unreachable");
      expect(status.current).toBe(false);
      const error = yield* service.install().pipe(Effect.flip);
      expect(error).toMatchObject({ problem: "windows-service-unreachable" });

      control.failQuery = false;
      control.timeoutQuery = true;
      const timedOut = yield* service.status;
      expect(timedOut.running).toBe("unknown");
      expect(timedOut.observation?.detail).toBe("manager-timeout");
    }),
  );

  it.effect("restarts and uninstalls only the exact owned registration", () =>
    Effect.gen(function* () {
      const { makeService, control, commands, statePath, helperPath, fs } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      const service = yield* makeService();
      yield* service.install();
      commands.length = 0;
      expect(yield* service.restart).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe stop T3Code"))).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe start T3Code"))).toBe(true);

      expect(yield* service.uninstall).toBe(true);
      expect(control.registered).toBe(false);
      // The home, its state and the shipped helper are never touched.
      expect(yield* fs.exists(statePath)).toBe(true);
      expect(yield* fs.exists(helperPath)).toBe(true);
    }),
  );

  it.effect("preserves a newer installed version that finishes during a stop", () =>
    Effect.gen(function* () {
      const { makeService, control, statePath, fs } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      const service = yield* makeService();
      yield* service.install();
      const before = yield* fs.readFileString(statePath);
      control.stateAfterStop = `{"protocol":4,"activeVersion":"1.2.4"}`;
      const error = yield* service.install().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "BootServiceDowngradeRefusedError",
        installedVersion: "1.2.4",
        targetVersion: "1.2.3",
      });
      void before;
      expect(yield* fs.readFileString(statePath)).toBe(control.stateAfterStop);
    }),
  );
});
