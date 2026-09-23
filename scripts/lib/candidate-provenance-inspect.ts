#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcessRuntime:off - Extracts real archives to read their packaged provenance.
/**
 * Reads the *actual* packaged provenance from a candidate's distributed bytes.
 *
 * A manifest that claims the right source is not evidence; the archive must be
 * opened and its `t3code-build-info.json` read. This module extracts the Linux
 * tarball and the Windows ZIP and reads their provenance, and (on Windows)
 * runs the real NSIS installer to reach `resources/wsl-runtime.tar.gz`.
 *
 * It never trusts the file name for the platform/arch/version.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseBuildInfo } from "./source-provenance.ts";
import {
  WSL_RUNTIME_ARCHIVE_NAME,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
} from "../build-desktop-artifact.ts";
import type { PackagedProvenance, PackagedProvenanceRecord } from "./fork-release-manifest.ts";

const which = (command: string): string | undefined => {
  // eslint-disable-next-line t3code/no-global-process-runtime -- a plain Node CLI helper, not Effect code
  const finder = process.platform === "win32" ? "where" : "which";
  const result = NodeChildProcess.spawnSync(finder, [command], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\r?\n/)[0]?.trim() || undefined;
};

function detectSevenZip(): string | undefined {
  for (const candidate of ["7z", "7zz", "7za"]) {
    if (which(candidate) !== undefined) return candidate;
  }
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (root === undefined) continue;
    const candidate = NodePath.join(root, "7-Zip", "7z.exe");
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findFile(root: string, name: string): string | undefined {
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = NodePath.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found !== undefined) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { allowFailure?: boolean } = {},
): number => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
  const status = result.status ?? 1;
  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} exited ${status}`);
  }
  return status;
};

function readBuildInfoAt(root: string): PackagedProvenanceRecord | null {
  const infoPath = findFile(root, "t3code-build-info.json");
  if (infoPath === undefined) return null;
  const parsed = parseBuildInfo(NodeFS.readFileSync(infoPath, "utf8"));
  return {
    repository: parsed.repository,
    sourceSha: parsed.sourceSha,
    version: parsed.version,
    platform: parsed.platform,
    arch: parsed.arch,
  };
}

function readTarGzProvenance(archive: string, scratch: string): PackagedProvenanceRecord | null {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "tar-"));
  run("tar", ["-xzf", archive, "-C", dir]);
  return readBuildInfoAt(dir);
}

function readZipProvenance(archive: string, scratch: string): PackagedProvenanceRecord | null {
  const sevenZip = detectSevenZip();
  if (sevenZip !== undefined) {
    const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "zip-"));
    run(sevenZip, ["x", "-y", `-o${dir}`, archive]);
    return readBuildInfoAt(dir);
  }
  // bsdtar can read zip on every supported host.
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "zip-"));
  run("tar", ["-xf", archive, "-C", dir]);
  return readBuildInfoAt(dir);
}

/**
 * Extracts the WSL archive from a Windows installer by unpacking the real NSIS
 * app payload (`$PLUGINSDIR/app-64.7z`, the stream the installer's own
 * `nsis7z.dll` unpacks). Executing the installer is avoided because it launches
 * the Electron app. Returns the embedded bytes and the standalone comparison.
 */
function inspectEmbeddedWsl(
  installer: string,
  standaloneArchive: string,
  scratch: string,
): { embedded: Uint8Array | undefined; equalsStandalone: boolean | undefined } {
  const sevenZip = detectSevenZip();
  if (sevenZip === undefined) return { embedded: undefined, equalsStandalone: undefined };
  const wrapperDir = NodeFS.mkdtempSync(NodePath.join(scratch, "installer-"));
  run(sevenZip, ["x", "-y", `-o${wrapperDir}`, installer]);
  const appPayload = findFile(NodePath.join(wrapperDir, "$PLUGINSDIR"), "app-64.7z");
  let extractRoot = wrapperDir;
  if (appPayload !== undefined) {
    extractRoot = NodeFS.mkdtempSync(NodePath.join(scratch, "payload-"));
    run(sevenZip, ["x", "-y", `-o${extractRoot}`, appPayload]);
  }
  const embeddedPath = findFile(extractRoot, WSL_RUNTIME_ARCHIVE_NAME);
  if (embeddedPath === undefined) return { embedded: undefined, equalsStandalone: undefined };
  const embedded = NodeFS.readFileSync(embeddedPath);
  // The standalone Linux archive may not be in a Windows-only candidate
  // directory; the aggregate step performs the byte-equality check when both
  // are present. Read its provenance from the embedded copy either way.
  if (!NodeFS.existsSync(standaloneArchive)) {
    return { embedded, equalsStandalone: undefined };
  }
  const standalone = NodeFS.readFileSync(standaloneArchive);
  return { embedded, equalsStandalone: embedded.equals(standalone) };
}

export interface InspectCandidateInput {
  readonly candidateDir: string;
  readonly version: string;
  readonly targets: "all" | "linux" | "win" | "mac";
  readonly includeMacosArm64: boolean;
}

/**
 * Reads the real embedded provenance for the target selection. Missing
 * extraction prerequisites (for example no 7-Zip for the Windows ZIP) leave the
 * record `undefined` rather than falsely passing; the caller reports that as an
 * inspection gap when the artifact is required.
 */
export function inspectCandidateProvenance(input: InspectCandidateInput): PackagedProvenance {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-inspect-"));
  const provenance: {
    windowsInstaller?: PackagedProvenanceRecord | null;
    linuxArchive?: PackagedProvenanceRecord | null;
    windowsZip?: PackagedProvenanceRecord | null;
    macDmg?: PackagedProvenanceRecord | null;
  } = {};
  const wantsAll = input.targets === "all";
  const linuxArchivePath = NodePath.join(
    input.candidateDir,
    `t3-${input.version}-linux-x64.tar.gz`,
  );
  const windowsZipPath = NodePath.join(input.candidateDir, `t3-${input.version}-win32-x64.zip`);
  const windowsInstallerPath = NodePath.join(
    input.candidateDir,
    `T3-Code-${input.version}-x64.exe`,
  );

  if ((wantsAll || input.targets === "linux") && NodeFS.existsSync(linuxArchivePath)) {
    provenance.linuxArchive = readTarGzProvenance(linuxArchivePath, scratch);
  }
  if ((wantsAll || input.targets === "win") && NodeFS.existsSync(windowsZipPath)) {
    provenance.windowsZip = readZipProvenance(windowsZipPath, scratch);
  }

  let embeddedWslEqualsStandalone: boolean | undefined;
  if ((wantsAll || input.targets === "win") && NodeFS.existsSync(windowsInstallerPath)) {
    const wsl = inspectEmbeddedWsl(windowsInstallerPath, linuxArchivePath, scratch);
    embeddedWslEqualsStandalone = wsl.equalsStandalone;
    // Read the embedded archive's own provenance.
    if (wsl.embedded !== undefined) {
      const embeddedDir = NodeFS.mkdtempSync(NodePath.join(scratch, "wsl-"));
      const embeddedFile = NodePath.join(embeddedDir, WSL_RUNTIME_ARCHIVE_NAME);
      NodeFS.writeFileSync(embeddedFile, wsl.embedded);
      provenance.windowsInstaller = readTarGzProvenance(embeddedFile, scratch);
    } else {
      provenance.windowsInstaller = null;
    }
  }

  NodeFS.rmSync(scratch, { recursive: true, force: true });
  console.log(
    `Inspected packaged provenance: ${JSON.stringify(
      {
        ...provenance,
        embeddedWslEqualsStandalone,
      },
      null,
      2,
    )}`,
  );
  return embeddedWslEqualsStandalone === undefined
    ? { ...provenance }
    : { ...provenance, embeddedWslEqualsStandalone };
}

export { WSL_RUNTIME_ARCHIVE_HASH_NAME };
