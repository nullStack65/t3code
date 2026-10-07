#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcessRuntime:off - Stages a cargo build output over plain files for a machine-local build.
/**
 * Stages the resource monitor built from source into the layout
 * `build-cli-archive.ts` expects: `<resourceMonitorDir>/<resource_key>/<binary>`.
 *
 * This mirrors the workflow's "Stage resource monitor for the CLI archive" step,
 * which writes `$RUNNER_TEMP/cli-resource-monitor/${{ inputs.resource_key }}`.
 * The Windows route previously staged only the Linux helper, so the `win`
 * plan's `cli-archive` step consumed a directory nothing populated and failed
 * with `CliArchiveInputMissingError` after the installer was already built.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type ResourceMonitorTarget = "linux" | "win";

export interface ResourceMonitorStageSpec {
  /** The `cliArchivePlatformKey`-style directory name the archive copies. */
  readonly resourceKey: string;
  readonly binaryName: string;
  /** Cargo output path, relative to the repository root. */
  readonly cargoOutput: string;
}

/** The source-output path and destination layout for one target. */
export function resourceMonitorStageSpec(target: ResourceMonitorTarget): ResourceMonitorStageSpec {
  if (target === "win") {
    return {
      resourceKey: "win32-x64",
      binaryName: "t3-resource-monitor.exe",
      cargoOutput:
        "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe",
    };
  }
  return {
    resourceKey: "linux-x64",
    binaryName: "t3-resource-monitor",
    cargoOutput: "native/resource-monitor/target/release/t3-resource-monitor",
  };
}

export interface StageResourceMonitorInput {
  readonly target: ResourceMonitorTarget;
  /** Base directory; the helper lands in `<dir>/<resourceKey>/<binaryName>`. */
  readonly resourceMonitorDir: string;
  /** Repository root holding `native/resource-monitor`. Defaults to the cwd. */
  readonly repoRoot?: string | undefined;
}

export interface StagedResourceMonitor {
  readonly source: string;
  readonly destination: string;
}

export class ResourceMonitorStageError extends Error {
  readonly source: string;
  constructor(message: string, source: string) {
    super(message);
    this.name = "ResourceMonitorStageError";
    this.source = source;
  }
}

/**
 * Copies `source`'s cargo output to the destination layout, creating the
 * destination directory when it does not exist. Throws before writing anything
 * with a clear message when the source-build output is missing.
 */
export function stageResourceMonitor(input: StageResourceMonitorInput): StagedResourceMonitor {
  const spec = resourceMonitorStageSpec(input.target);
  const repoRoot = input.repoRoot ?? process.cwd();
  const source = NodePath.join(repoRoot, spec.cargoOutput);
  if (!NodeFS.existsSync(source)) {
    throw new ResourceMonitorStageError(
      `resource monitor source-build output for '${input.target}' is missing at ${source}; build it before archiving`,
      source,
    );
  }
  const targetDir = NodePath.join(input.resourceMonitorDir, spec.resourceKey);
  NodeFS.mkdirSync(targetDir, { recursive: true });
  const destination = NodePath.join(targetDir, spec.binaryName);
  NodeFS.copyFileSync(source, destination);
  return { source, destination };
}
