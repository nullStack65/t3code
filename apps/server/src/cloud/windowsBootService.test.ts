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
import * as NodeURL from "node:url";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseScQc,
  parseScQuery,
  parseWindowsCommandLine,
  parseWindowsServiceInvocation,
  isQualifiedWindowsAccount,
  quoteWindowsArgument,
  renderWindowsServiceImagePath,
  scRunningState,
  scServiceDoesNotExist,
  windowsRegistrationMatchesOurBinding,
  windowsRegistrationOwnedByUs,
  windowsRuntimeBelongsToHome,
  windowsServiceHelperBesideRuntime,
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
  // Absence is only the authoritative numeric 1060, never incidental text.
  expect(scServiceDoesNotExist(1060)).toBe(true);
  expect(scServiceDoesNotExist(1)).toBe(false);
  expect(scServiceDoesNotExist(5)).toBe(false);
  expect(scServiceDoesNotExist(null)).toBe(false);
});

it("splits Windows command lines losslessly and quotes them reversibly", () => {
  const image = parseWindowsCommandLine(
    '"C:\\Program Files\\t3\\host.exe" --home "C:\\Agent  Data" --runtime "C:\\t3\\t3.exe"',
  );
  expect(image).toEqual([
    "C:\\Program Files\\t3\\host.exe",
    "--home",
    "C:\\Agent  Data",
    "--runtime",
    "C:\\t3\\t3.exe",
  ]);
  // A trailing backslash before the closing quote is doubled, and round-trips.
  expect(quoteWindowsArgument("C:\\Program Files\\")).toBe('"C:\\Program Files\\\\"');
  expect(parseWindowsCommandLine(quoteWindowsArgument("C:\\Program Files\\"))).toEqual([
    "C:\\Program Files\\",
  ]);
  expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
  expect(parseWindowsCommandLine(quoteWindowsArgument('a"b'))).toEqual(['a"b']);
  expect(quoteWindowsArgument("")).toBe('""');
  expect(parseWindowsCommandLine('"C:\\a b\\\\" x')).toEqual(["C:\\a b\\", "x"]);
});

it("binds ownership on account/helper/home and allows an owned older runtime", () => {
  const binding: WindowsBootServiceBinding = {
    hostPath: "C:\\Users\\theo\\.t3\\runtime\\versions\\1.2.3\\t3-windows-service-host.exe",
    homeDir: "C:\\Users\\theo\\.t3",
    runtimePath: "C:\\Users\\theo\\.t3\\runtime\\versions\\1.2.3\\t3.exe",
    logPath: "C:\\Users\\theo\\.t3\\userdata\\logs\\boot-service.log",
    serviceName: WINDOWS_BOOT_SERVICE_NAME,
    account: "DOMAIN\\svc",
  };
  const qcOf = (binaryPathName: string, serviceStartName = "DOMAIN\\svc") => ({
    binaryPathName,
    serviceStartName,
  });
  const image = renderWindowsServiceImagePath(binding);
  expect(windowsRegistrationMatchesOurBinding(qcOf(image), binding)).toBe(true);
  expect(windowsRegistrationOwnedByUs(qcOf(image), binding)).toBe(true);
  // A changed native account is not ours.
  expect(windowsRegistrationMatchesOurBinding(qcOf(image, "DOMAIN\\other"), binding)).toBe(false);
  expect(windowsRegistrationOwnedByUs(qcOf(image, "DOMAIN\\other"), binding)).toBe(false);
  // A genuinely different home (even differing only by an extra space) is not ours.
  const twoSpaces = image.replace("C:\\Users\\theo\\.t3", "C:\\Users\\theo\\.t3  x");
  expect(windowsRegistrationMatchesOurBinding(qcOf(twoSpaces), binding)).toBe(false);
  expect(windowsRegistrationOwnedByUs(qcOf(twoSpaces), binding)).toBe(false);
  // A real owned older package keeps its helper beside its own older runtime,
  // so the upgrade is recognized as ours but is not the desired version.
  const olderRuntime = binding.runtimePath.replace("1.2.3", "1.2.2");
  const olderBinding: WindowsBootServiceBinding = {
    ...binding,
    hostPath: windowsServiceHelperBesideRuntime(olderRuntime),
    runtimePath: olderRuntime,
  };
  const olderImage = renderWindowsServiceImagePath(olderBinding);
  expect(windowsRegistrationOwnedByUs(qcOf(olderImage), binding)).toBe(true);
  expect(windowsRegistrationMatchesOurBinding(qcOf(olderImage), binding)).toBe(false);
  // The desired new helper pointed at the old runtime is a half-upgraded binding,
  // not an owned older package, and must not be adopted.
  const mismatchedHelper = olderImage.replace(
    windowsServiceHelperBesideRuntime(olderRuntime),
    binding.hostPath,
  );
  expect(windowsRegistrationOwnedByUs(qcOf(mismatchedHelper), binding)).toBe(false);
  // A runtime outside this home's tree is foreign, not an upgrade.
  const foreignImage = image.replace(binding.runtimePath, "C:\\elsewhere\\t3.exe");
  expect(windowsRegistrationOwnedByUs(qcOf(foreignImage), binding)).toBe(false);
  expect(windowsRegistrationMatchesOurBinding({}, binding)).toBe(false);
  // An explicit, mismatched expected-account is foreign.
  const foreignAccount = image.replace(
    "--expected-account DOMAIN\\svc",
    "--expected-account DOMAIN\\other",
  );
  expect(windowsRegistrationOwnedByUs(qcOf(foreignAccount), binding)).toBe(false);
  expect(
    windowsRuntimeBelongsToHome(
      "C:\\Users\\theo\\.t3\\runtime\\versions\\1.2.3\\t3.exe",
      binding.homeDir,
    ),
  ).toBe(true);
  // A version prefix followed by `..` escaping the runtime tree is not owned.
  expect(
    windowsRuntimeBelongsToHome(
      "C:\\Users\\theo\\.t3\\runtime\\versions\\1.2.3\\..\\..\\..\\outside\\t3.exe",
      binding.homeDir,
    ),
  ).toBe(false);
  expect(windowsRuntimeBelongsToHome("C:\\elsewhere\\t3.exe", binding.homeDir)).toBe(false);
  expect(quoteWindowsArgument("a b")).toBe('"a b"');
});

it("refuses ambiguous duplicates and unsupported host flags", () => {
  const binding: WindowsBootServiceBinding = {
    hostPath: "C:\\Users\\theo\\.t3\\runtime\\versions\\1.2.3\\t3-windows-service-host.exe",
    homeDir: "C:\\Users\\theo\\.t3",
    runtimePath: "C:\\Users\\theo\\.t3\\runtime\\versions\\1.2.3\\t3.exe",
    logPath: "C:\\Users\\theo\\.t3\\userdata\\logs\\boot-service.log",
    serviceName: WINDOWS_BOOT_SERVICE_NAME,
    account: "DOMAIN\\svc",
  };
  const image = renderWindowsServiceImagePath(binding);
  const owned = (binaryPathName: string) =>
    windowsRegistrationOwnedByUs({ binaryPathName, serviceStartName: "DOMAIN\\svc" }, binding);
  // A foreign trailing --home must not qualify the different effective target.
  expect(
    owned(
      image.replace(
        " --log ",
        " --home C:\\Users\\evil\\.t3 --runtime C:\\Users\\evil\\.t3\\runtime\\versions\\1.2.3\\t3.exe --log ",
      ),
    ),
  ).toBe(false);
  // An inline form with the same effective target is accepted.
  const inline = renderWindowsServiceImagePath(binding)
    .replace(/ --home ([^ ]+)/, " --home=$1")
    .replace(/ --runtime ([^ ]+)/, " --runtime=$1");
  expect(parseWindowsServiceInvocation(inline).values["--runtime"]).toBe(binding.runtimePath);
  expect(owned(inline)).toBe(true);
  // An extra launch-mode/unknown flag is unsupported, not silently adopted.
  expect(owned(`${image} --console`)).toBe(false);
  expect(owned(`${image} --frobnicate`)).toBe(false);
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
  processId: number;
  failQuery: boolean;
  timeoutQuery: boolean;
  /** Applied after `sc stop`; a non-stopped value models a pending stop. */
  stopQueryState?: string;
  /** When true, `sc stop` then makes every query fail (unknown stop). */
  failQueryAfterStop?: boolean;
  /** When true, `sc delete` leaves the registration marked-for-deletion. */
  deletePending?: boolean;
  stateAfterStop?: string;
  /** When true, `sc create` fails before the registration exists. */
  failCreate?: boolean;
  /** When true, `sc config` fails after the launcher state was written. */
  failConfig?: boolean;
  /** When true, `sc start` fails after the registration was changed. */
  failStart?: boolean;
  /** When true, `sc stop` fails and leaves the service running. */
  failStop?: boolean;
  /** Models `ERROR_SERVICE_NOT_ACTIVE` (1062) from a stop on a drained service. */
  stopNotActive?: boolean;
}

const makeHarness = Effect.fn("test.make_windows_boot_service_harness")(function* (options?: {
  account?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-service-test-" });
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const ensureRuntime = Effect.fn("test.ensure_windows_runtime")(function* (version: string) {
    const runtime = pinnedRuntimePaths(path, baseDir, version, "win32");
    yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
    yield* fs.writeFileString(runtime.entryPath, "MZ fake t3.exe");
    yield* fs.writeFileString(runtime.sentinelPath, `${version}\n`);
    yield* fs.writeFileString(windowsServiceHelperPath(runtime.entryPath, path), "MZ fake host");
    return runtime;
  });
  const runtime = yield* ensureRuntime("1.2.3");
  const helperPath = windowsServiceHelperPath(runtime.entryPath, path);

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
    processId: 4321,
    failQuery: false,
    timeoutQuery: false,
  };
  const serviceStartName = options?.account ?? "NT AUTHORITY\\LocalService";
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
                `        SERVICE_START_NAME : ${serviceStartName}`,
              ].join("\n"),
            );
          return ok(
            [
              `SERVICE_NAME: ${WINDOWS_BOOT_SERVICE_NAME}`,
              `        STATE              : ${control.queryState}`,
              ...(/RUNNING/.test(control.queryState)
                ? [`        PID                : ${control.processId}`]
                : []),
            ].join("\n"),
          );
        }
        if (sub === "create") {
          if (control.failCreate === true) return status("", 1, "CreateService FAILED 1072");
          control.qcImagePath = input.args[3];
          control.registered = true;
          return ok("CreateService SUCCESS");
        }
        if (sub === "config") {
          if (control.failConfig === true) return status("", 1, "ChangeServiceConfig FAILED 1072");
          control.qcImagePath = input.args[3];
          return ok("ChangeServiceConfig SUCCESS");
        }
        if (sub === "start") {
          if (control.failStart === true) return status("", 1, "StartService FAILED 1053");
          control.queryState = "4  RUNNING";
          return ok("StartService SUCCESS");
        }
        if (sub === "stop") {
          if (control.failStop === true) return status("", 5, "Access is denied.");
          if (control.stopNotActive === true) {
            // A stop on a drained service returns ERROR_SERVICE_NOT_ACTIVE.
            control.queryState = "1  STOPPED";
            return status("", 1062, "The service is not active.");
          }
          if (control.stateAfterStop !== undefined)
            yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
          control.queryState = control.stopQueryState ?? "1  STOPPED";
          if (control.failQueryAfterStop === true) control.failQuery = true;
          return ok("StopService SUCCESS");
        }
        if (sub === "delete") {
          if (control.deletePending !== true) control.registered = false;
          return ok("DeleteService SUCCESS");
        }
        return ok("");
      }
      // Pinned-runtime validation.
      if (input.args[0] === "--version") {
        const version = /versions[\\/]([^\\/]+)[\\/]/.exec(input.command)?.[1] ?? "1.2.3";
        return ok(`t3 v${version}\n`);
      }
      return ok("");
    }),
  });

  const makeService = (account: string | undefined = options?.account, cliVersion = "1.2.3") =>
    BootService.make({
      baseDir,
      logsDir: path.join(baseDir, "userdata", "logs"),
      cliVersion,
      host: { execPath: helperPath },
      windowsTransitionTimeoutMs: 300,
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
    ensureRuntime,
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
  it.effect("observes without credentials but refuses mutation without a qualified account", () =>
    Effect.gen(function* () {
      const { makeService, fs, statePath, control } = yield* makeHarness();
      const service = yield* makeService(undefined);
      // Read-only status still queries the SCM by fixed name; a missing install
      // account is not a claim that the platform is unsupported.
      expect(yield* service.status).toMatchObject({
        supported: true,
        manager: "scm",
        installed: false,
        running: "not-loaded",
      });
      control.registered = true;
      expect(yield* service.status).toMatchObject({ installed: true });
      expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
        "BootServicePrerequisiteError",
      );
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("install(start=false) registers without activating", () =>
    Effect.gen(function* () {
      const { makeService, control, commands, statePath, fs } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      const service = yield* makeService();
      yield* service.install({ start: false });
      // A fresh install still creates the registration so a later start runs
      // this version; it must not start the service.
      expect(control.registered).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe create T3Code "))).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe start T3Code"))).toBe(false);
      expect(commands.some((command) => command.startsWith("sc.exe stop T3Code"))).toBe(false);
      expect((yield* fs.readFileString(statePath)).length).toBeGreaterThan(0);
    }),
  );

  it.effect("does not delete or report uninstall success over a failed stop", () =>
    Effect.gen(function* () {
      const { makeService, control, commands } = yield* makeHarness({ account: "DOMAIN\\svc" });
      const service = yield* makeService();
      yield* service.install();
      commands.length = 0;
      control.failQueryAfterStop = true;
      const error = yield* service.uninstall.pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BootServiceCommandError" });
      expect(commands.some((command) => command.startsWith("sc.exe delete T3Code"))).toBe(false);
    }),
  );

  it.effect("does not report uninstall success while deletion is still pending", () =>
    Effect.gen(function* () {
      const { makeService, control } = yield* makeHarness({ account: "DOMAIN\\svc" });
      const service = yield* makeService();
      yield* service.install();
      control.deletePending = true;
      const error = yield* service.uninstall.pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BootServiceCommandError" });
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

  it.effect("does not re-stop an already stopped owned registration", () =>
    Effect.gen(function* () {
      const { makeService, control, commands } = yield* makeHarness({ account: "DOMAIN\\svc" });
      const service = yield* makeService();
      yield* service.install();
      control.queryState = "1  STOPPED";

      commands.length = 0;
      yield* service.install();
      expect(commands.some((command) => command.startsWith("sc.exe stop T3Code"))).toBe(false);
      expect(commands.some((command) => command.startsWith("sc.exe start T3Code"))).toBe(true);

      control.queryState = "1  STOPPED";
      commands.length = 0;
      expect(yield* service.restart).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe stop T3Code"))).toBe(false);
      expect(commands.some((command) => command.startsWith("sc.exe start T3Code"))).toBe(true);

      control.queryState = "1  STOPPED";
      commands.length = 0;
      expect(yield* service.uninstall).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe stop T3Code"))).toBe(false);
      expect(commands.some((command) => command.startsWith("sc.exe delete T3Code"))).toBe(true);
    }),
  );

  it.effect("tolerates ERROR_SERVICE_NOT_ACTIVE only after confirming the stop", () =>
    Effect.gen(function* () {
      const { makeService, control, commands } = yield* makeHarness({ account: "DOMAIN\\svc" });
      const service = yield* makeService();
      yield* service.install();
      control.stopNotActive = true;
      commands.length = 0;

      expect(yield* service.uninstall).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe stop T3Code"))).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe delete T3Code"))).toBe(true);
    }),
  );

  it.effect("does not hide a stop failure that leaves the service running", () =>
    Effect.gen(function* () {
      const { makeService, control, commands } = yield* makeHarness({ account: "DOMAIN\\svc" });
      const service = yield* makeService();
      yield* service.install();
      control.failStop = true;
      commands.length = 0;

      const error = yield* service.uninstall.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.some((command) => command.startsWith("sc.exe delete T3Code"))).toBe(false);
    }),
  );

  it.effect("restores the exact previous owned state when registration fails", () =>
    Effect.gen(function* () {
      const { makeService, control, fs, statePath } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      const service = yield* makeService();
      yield* service.install();
      // A byte-distinct previous document proves the exact bytes are restored,
      // not merely a semantically equivalent rewrite.
      const previous = `{"protocol":3,"activeVersion":"1.2.3"}`;
      yield* fs.writeFileString(statePath, previous);
      control.failConfig = true;

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(yield* fs.readFileString(statePath)).toBe(previous);
      expect((yield* service.status).installed).toBe(true);
    }),
  );

  it.effect("removes the written state when a fresh create fails", () =>
    Effect.gen(function* () {
      const { makeService, control, fs, statePath } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      control.failCreate = true;
      const service = yield* makeService();

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("reports an explicit partial state when start fails after registration", () =>
    Effect.gen(function* () {
      const { makeService, control, fs, statePath } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      control.failStart = true;
      const service = yield* makeService();

      const error = yield* service.install().pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BootServicePartialStateError", activeVersion: "1.2.3" });
      expect(control.registered).toBe(true);
      expect(yield* fs.readFileString(statePath)).toContain('"activeVersion": "1.2.3"');
    }),
  );

  it.effect("upgrades a real old-version package whose helper sits beside the old runtime", () =>
    Effect.gen(function* () {
      const { makeService, ensureRuntime, control, commands, fs, statePath } = yield* makeHarness({
        account: "DOMAIN\\svc",
      });
      const oldService = yield* makeService(undefined, "1.2.3");
      yield* oldService.install();
      expect(control.qcImagePath).toContain("1.2.3");

      // The installed older package ships the host beside its own older runtime.
      yield* ensureRuntime("1.2.4");
      commands.length = 0;
      const newService = yield* makeService(undefined, "1.2.4");
      yield* newService.install();

      expect(commands.some((command) => command.startsWith("sc.exe config T3Code"))).toBe(true);
      expect(commands.some((command) => command.startsWith("sc.exe create T3Code"))).toBe(false);
      expect(control.qcImagePath).toContain("1.2.4");
      expect(yield* fs.readFileString(statePath)).toContain('"activeVersion": "1.2.4"');
    }),
  );

  it.effect("shares argument vectors with the native host parser", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vectors = yield* fs.readFileString(
        NodeURL.fileURLToPath(
          new URL(
            "../../../../native/windows-service-host/tests/argument-vectors.tsv",
            import.meta.url,
          ),
        ),
      );
      const rows = vectors
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#"));
      expect(rows.length).toBe(9);
      for (const row of rows) {
        const [
          id = "",
          ,
          expectedHome = "",
          expectedRuntime = "",
          disposition = "",
          tokenField = "",
        ] = row.split("###").map((field) => field.trim());
        const tokens = tokenField.split("|");
        const commandLine = tokens.map(quoteWindowsArgument).join(" ");
        // The quoting pair round-trips losslessly, so the adapter parses exactly
        // the argv the native host receives.
        expect(parseWindowsCommandLine(commandLine), id).toEqual(tokens);
        const invocation = parseWindowsServiceInvocation(commandLine);
        if (expectedHome !== "-") expect(invocation.values["--home"], id).toBe(expectedHome);
        if (expectedRuntime !== "-") {
          expect(invocation.values["--runtime"], id).toBe(expectedRuntime);
        }
        switch (disposition) {
          case "accept":
            expect(invocation.duplicated, id).toEqual([]);
            expect(invocation.unsupported, id).toEqual([]);
            break;
          case "duplicate":
            expect(invocation.duplicated, id).not.toEqual([]);
            break;
          case "unsupported":
            expect(invocation.unsupported, id).not.toEqual([]);
            break;
          case "escape":
            expect(
              windowsRuntimeBelongsToHome(invocation.values["--runtime"] ?? "", expectedHome),
              id,
            ).toBe(false);
            break;
          case "missing":
            expect(invocation.values["--runtime"], id).toBeUndefined();
            break;
          default:
            throw new Error(`unknown disposition ${disposition}`);
        }
      }
    }),
  );
});
