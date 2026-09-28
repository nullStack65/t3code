#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcessRuntime:off - Extracts real archives to read their packaged provenance.
/**
 * Reads the *actual* packaged provenance from a candidate's distributed bytes.
 *
 * A manifest that claims the right source is not evidence; each archive must be
 * opened and its own `t3code-build-info.json` (or, for the Windows server
 * sidecar, its `package.json`) read. The components are kept distinct:
 *
 *   - `linuxArchive`        the standalone Linux x64 tarball;
 *   - `windowsZip`          the standalone Windows CLI ZIP;
 *   - `windowsDesktop`      the Windows Electron app's own build info, read from
 *                           `resources/app.asar` inside the real NSIS payload;
 *   - `windowsServerBundle` the bundled `server.asar` sidecar metadata;
 *   - `embeddedWsl`         the Linux runtime the installer embeds beside the app;
 *   - `macDmg`              the Intel macOS app's build info, read from the
 *                           mounted DMG's `Contents/Resources/app.asar`.
 *
 * The Windows desktop application is never inferred from the WSL payload or the
 * CLI ZIP. A component that cannot be opened because a required extraction tool
 * is missing is left `undefined` (BLOCKED), not silently accepted. The result
 * also carries a digest-bound evidence record so a host that cannot open an
 * artifact can consume a native inspection of the exact bytes.
 *
 * It never trusts the file name for the platform/arch/version.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { extractFile } from "@electron/asar";

import { BUILD_INFO_FILE_NAME, parseBuildInfo } from "./source-provenance.ts";
import {
  WSL_RUNTIME_ARCHIVE_NAME,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
} from "../build-desktop-artifact.ts";
import {
  sha256Hex,
  type BundledServerRecord,
  type PackagedInspectionEvidence,
  type PackagedInspectionRecord,
  type PackagedProvenance,
  type PackagedProvenanceKey,
  type PackagedProvenanceRecord,
} from "./fork-release-manifest.ts";

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
  options: { allowFailure?: boolean; quiet?: boolean } = {},
): number => {
  const result = NodeChildProcess.spawnSync(command, args, {
    stdio: options.quiet === true ? "ignore" : "inherit",
  });
  const status = result.status ?? 1;
  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} exited ${status}`);
  }
  return status;
};

function readBuildInfoAt(root: string): PackagedProvenanceRecord | null {
  const infoPath = findFile(root, BUILD_INFO_FILE_NAME);
  if (infoPath === undefined) return null;
  try {
    const parsed = parseBuildInfo(NodeFS.readFileSync(infoPath, "utf8"));
    return {
      repository: parsed.repository,
      sourceSha: parsed.sourceSha,
      version: parsed.version,
      platform: parsed.platform,
      arch: parsed.arch,
    };
  } catch {
    return null;
  }
}

function readTarGzProvenance(archive: string, scratch: string): PackagedProvenanceRecord | null {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "tar-"));
  const status = run("tar", ["-xzf", archive, "-C", dir], { allowFailure: true });
  if (status !== 0) return null;
  return readBuildInfoAt(dir);
}

function readZipProvenance(archive: string, scratch: string): PackagedProvenanceRecord | null {
  const sevenZip = detectSevenZip();
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "zip-"));
  if (sevenZip !== undefined) {
    const status = run(sevenZip, ["x", "-y", `-o${dir}`, archive], { allowFailure: true });
    return status === 0 ? readBuildInfoAt(dir) : null;
  }
  // bsdtar can read zip on every supported host.
  const status = run("tar", ["-xf", archive, "-C", dir], { allowFailure: true });
  return status === 0 ? readBuildInfoAt(dir) : null;
}

/** Reads `t3code-build-info.json` from inside a real ASAR archive. */
function readAsarBuildInfo(asarPath: string): PackagedProvenanceRecord | null {
  let raw: Buffer | undefined;
  try {
    raw = extractFile(asarPath, BUILD_INFO_FILE_NAME);
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  try {
    const parsed = parseBuildInfo(raw.toString("utf8"));
    return {
      repository: parsed.repository,
      sourceSha: parsed.sourceSha,
      version: parsed.version,
      platform: parsed.platform,
      arch: parsed.arch,
    };
  } catch {
    return null;
  }
}

/** Reads the name/version the bundled Windows server sidecar records. */
function readAsarPackageMetadata(asarPath: string): BundledServerRecord | null {
  let raw: Buffer | undefined;
  try {
    raw = extractFile(asarPath, "package.json");
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { name?: unknown; version?: unknown };
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") return null;
    return { name: parsed.name, version: parsed.version };
  } catch {
    return null;
  }
}

function readAsarBuildInfoInTree(root: string): PackagedProvenanceRecord | null {
  const asarPath = findFile(root, "app.asar");
  if (asarPath === undefined) return null;
  return readAsarBuildInfo(asarPath);
}

/**
 * Extracts the Windows installer through its real NSIS payload layout.
 *
 * electron-builder's NSIS installer is a wrapper whose app payload is the
 * `$PLUGINSDIR/app-64.7z` stream that the installer's own `nsis7z.dll` unpacks
 * at install time, producing `resources/app.asar` (the desktop app),
 * `resources/server.asar` (the bundled server) and `resources/wsl-runtime.tar.gz`
 * (the WSL runtime). This never executes the installer, so it cannot launch the
 * Electron app or touch a live profile. It fails closed when 7-Zip is absent.
 */
function inspectWindowsInstaller(
  installer: string,
  standaloneArchive: string,
  scratch: string,
): {
  desktop: PackagedProvenanceRecord | null | undefined;
  serverBundle: BundledServerRecord | null | undefined;
  embeddedWsl: PackagedProvenanceRecord | null | undefined;
  equalsStandalone: boolean | undefined;
} {
  const sevenZip = detectSevenZip();
  if (sevenZip === undefined) {
    return {
      desktop: undefined,
      serverBundle: undefined,
      embeddedWsl: undefined,
      equalsStandalone: undefined,
    };
  }
  const unreadable = {
    desktop: null,
    serverBundle: null,
    embeddedWsl: null,
    equalsStandalone: undefined,
  } as const;

  const wrapperDir = NodeFS.mkdtempSync(NodePath.join(scratch, "installer-"));
  const wrapperStatus = run(sevenZip, ["x", "-y", `-o${wrapperDir}`, installer], {
    allowFailure: true,
  });
  if (wrapperStatus !== 0) return unreadable;

  let extractRoot = wrapperDir;
  const appPayload = findFile(NodePath.join(wrapperDir, "$PLUGINSDIR"), "app-64.7z");
  if (appPayload !== undefined) {
    extractRoot = NodeFS.mkdtempSync(NodePath.join(scratch, "payload-"));
    const payloadStatus = run(sevenZip, ["x", "-y", `-o${extractRoot}`, appPayload], {
      allowFailure: true,
    });
    if (payloadStatus !== 0) return unreadable;
  }

  const appAsarPath = findFile(extractRoot, "app.asar");
  const serverAsarPath = findFile(extractRoot, "server.asar");
  const embeddedPath = findFile(extractRoot, WSL_RUNTIME_ARCHIVE_NAME);

  let equalsStandalone: boolean | undefined;
  if (embeddedPath !== undefined && NodeFS.existsSync(standaloneArchive)) {
    equalsStandalone = NodeFS.readFileSync(embeddedPath).equals(
      NodeFS.readFileSync(standaloneArchive),
    );
  }
  return {
    desktop: appAsarPath === undefined ? null : readAsarBuildInfo(appAsarPath),
    serverBundle: serverAsarPath === undefined ? null : readAsarPackageMetadata(serverAsarPath),
    embeddedWsl: embeddedPath === undefined ? null : readTarGzProvenance(embeddedPath, scratch),
    equalsStandalone,
  };
}

/**
 * Reads the macOS app's own build info from inside a real DMG.
 *
 * On the native Mac this attaches the image read-only to an isolated temporary
 * mount point and detaches it in `finally`; it never runs the app or an
 * installer. Elsewhere it falls back to 7-Zip's HFS reader. A host with neither
 * tool leaves the record `undefined` (BLOCKED).
 */
function inspectMacDmg(dmg: string, scratch: string): PackagedProvenanceRecord | null | undefined {
  const hdiutil = which("hdiutil");
  // eslint-disable-next-line t3code/no-global-process-runtime -- a plain Node CLI helper, not Effect code
  if (process.platform === "darwin" && hdiutil !== undefined) {
    const mountDir = NodeFS.mkdtempSync(NodePath.join(scratch, "dmg-"));
    let attached = false;
    try {
      const status = run(
        "hdiutil",
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-noverify",
          "-mountpoint",
          mountDir,
          dmg,
        ],
        { allowFailure: true, quiet: true },
      );
      if (status !== 0) return null;
      attached = true;
      return readAsarBuildInfoInTree(mountDir);
    } finally {
      if (attached) {
        run("hdiutil", ["detach", mountDir, "-force"], { allowFailure: true, quiet: true });
      }
      NodeFS.rmSync(mountDir, { recursive: true, force: true });
    }
  }

  const sevenZip = detectSevenZip();
  if (sevenZip === undefined) return undefined;
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "dmg-"));
  const status = run(sevenZip, ["x", "-y", `-o${dir}`, dmg], { allowFailure: true });
  return status === 0 ? readAsarBuildInfoInTree(dir) : null;
}

export interface InspectCandidateInput {
  readonly candidateDir: string;
  readonly version: string;
  readonly targets: "all" | "linux" | "win" | "mac";
  readonly includeMacosArm64: boolean;
}

export interface InspectCandidateResult {
  readonly provenance: PackagedProvenance;
  /** Digest-bound evidence for the components this host actually inspected. */
  readonly evidence: PackagedInspectionEvidence;
}

/**
 * Reads the real embedded provenance for the target selection. Missing
 * extraction prerequisites (for example no 7-Zip for the NSIS payload) leave the
 * component `undefined` rather than falsely passing; the caller reports that as
 * a BLOCKED inspection when the artifact is required.
 */
export function inspectCandidateProvenance(input: InspectCandidateInput): InspectCandidateResult {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-inspect-"));
  const provenance: {
    windowsDesktop?: PackagedProvenanceRecord | null | undefined;
    windowsServerBundle?: BundledServerRecord | null | undefined;
    embeddedWsl?: PackagedProvenanceRecord | null | undefined;
    linuxArchive?: PackagedProvenanceRecord | null | undefined;
    windowsZip?: PackagedProvenanceRecord | null | undefined;
    macDmg?: PackagedProvenanceRecord | null | undefined;
    macArm64Dmg?: PackagedProvenanceRecord | null | undefined;
    embeddedWslEqualsStandalone?: boolean | undefined;
  } = {};
  const records: Partial<Record<PackagedProvenanceKey, PackagedInspectionRecord>> = {};
  const digests: Partial<Record<PackagedProvenanceKey, string>> = {};

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
  const macDmgPath = NodePath.join(input.candidateDir, `T3-Code-${input.version}-x64.dmg`);
  const macArm64DmgPath = NodePath.join(input.candidateDir, `T3-Code-${input.version}-arm64.dmg`);

  const digestOf = (file: string): string => sha256Hex(NodeFS.readFileSync(file));

  try {
    if ((wantsAll || input.targets === "linux") && NodeFS.existsSync(linuxArchivePath)) {
      provenance.linuxArchive = readTarGzProvenance(linuxArchivePath, scratch);
      records.linuxArchive = provenance.linuxArchive;
      digests.linuxArchive = digestOf(linuxArchivePath);
    }
    if ((wantsAll || input.targets === "win") && NodeFS.existsSync(windowsZipPath)) {
      provenance.windowsZip = readZipProvenance(windowsZipPath, scratch);
      records.windowsZip = provenance.windowsZip;
      digests.windowsZip = digestOf(windowsZipPath);
    }
    if ((wantsAll || input.targets === "win") && NodeFS.existsSync(windowsInstallerPath)) {
      const installer = inspectWindowsInstaller(windowsInstallerPath, linuxArchivePath, scratch);
      provenance.windowsDesktop = installer.desktop;
      provenance.windowsServerBundle = installer.serverBundle;
      provenance.embeddedWsl = installer.embeddedWsl;
      records.windowsDesktop = installer.desktop;
      records.windowsServerBundle = installer.serverBundle;
      records.embeddedWsl = installer.embeddedWsl;
      const installerDigest = digestOf(windowsInstallerPath);
      digests.windowsDesktop = installerDigest;
      digests.windowsServerBundle = installerDigest;
      digests.embeddedWsl = installerDigest;
      if (installer.equalsStandalone !== undefined) {
        provenance.embeddedWslEqualsStandalone = installer.equalsStandalone;
      }
    }
    if ((wantsAll || input.targets === "mac") && NodeFS.existsSync(macDmgPath)) {
      provenance.macDmg = inspectMacDmg(macDmgPath, scratch);
      records.macDmg = provenance.macDmg;
      digests.macDmg = digestOf(macDmgPath);
    }
    if (
      (wantsAll || input.targets === "mac") &&
      input.includeMacosArm64 &&
      NodeFS.existsSync(macArm64DmgPath)
    ) {
      provenance.macArm64Dmg = inspectMacDmg(macArm64DmgPath, scratch);
      records.macArm64Dmg = provenance.macArm64Dmg;
      digests.macArm64Dmg = digestOf(macArm64DmgPath);
    }
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    `Inspected packaged provenance: ${JSON.stringify(
      {
        ...provenance,
        embeddedWslEqualsStandalone: provenance.embeddedWslEqualsStandalone,
      },
      null,
      2,
    )}`,
  );

  const evidence: PackagedInspectionEvidence = {
    schemaVersion: 1,
    // eslint-disable-next-line t3code/no-global-process-runtime -- a plain Node CLI helper, not Effect code
    host: `${process.platform}-${process.arch}`,
    records,
    digests,
    ...(provenance.embeddedWslEqualsStandalone === undefined
      ? {}
      : { embeddedWslEqualsStandalone: provenance.embeddedWslEqualsStandalone }),
  };
  return { provenance, evidence };
}

export { WSL_RUNTIME_ARCHIVE_HASH_NAME };
