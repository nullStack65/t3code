#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcessRuntime:off - A CI verification utility that shells out to 7-Zip and tar.
/**
 * Verifies the WSL runtime embedded in a Windows installer against the
 * standalone Linux x64 archive.
 *
 * This exercises the *real installer layout*: on Windows it runs the NSIS
 * installer to a throwaway temporary directory (not the default install path),
 * then inspects the extracted `resources/wsl-runtime.tar.gz`. A pure comparison
 * of two byte arrays would not prove the extractor reaches the nested payload,
 * so the installer is actually executed and its resources directory is located
 * on disk. On non-Windows hosts it falls back to unpacking the installer with
 * 7-Zip when available.
 *
 * The pure comparison lives in `lib/wsl-payload.ts`; this file only extracts the
 * bytes and, with `--emit-json`, writes the observed provenance for the
 * aggregate verifier to consume.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseBuildInfo } from "./lib/source-provenance.ts";
import { verifyEmbeddedWslRuntime, type EmbeddedBuildInfo } from "./lib/wsl-payload.ts";
import { WSL_RUNTIME_ARCHIVE_NAME } from "./build-desktop-artifact.ts";

interface Args {
  installer: string;
  standaloneArchive: string;
  repository: string;
  sourceSha: string;
  version: string;
  arch: string;
  emitJson: string | undefined;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.trim() === "") throw new Error(`--${key} is required`);
    return value.trim();
  };
  return {
    installer: required("installer"),
    standaloneArchive: required("standalone-archive"),
    repository: required("repository"),
    sourceSha: required("sha").toLowerCase(),
    version: required("version"),
    arch: values.get("arch")?.trim() || "x64",
    emitJson: values.get("emit-json")?.trim(),
  };
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
  const entries = NodeFS.readdirSync(root, { withFileTypes: true });
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

function readArchiveInfo(archive: string, scratch: string): EmbeddedBuildInfo | undefined {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "info-"));
  run("tar", ["-xzf", archive, "-C", dir]);
  const infoPath = findFile(dir, "t3code-build-info.json");
  if (infoPath === undefined) return undefined;
  return parseBuildInfo(NodeFS.readFileSync(infoPath, "utf8")) as EmbeddedBuildInfo;
}

/**
 * Extracts the Windows installer through its real NSIS flow when possible.
 *
 * Windows: run the installer with `/S /D=<temp dir>` so NSIS performs the real
 * silent install into an isolated directory; the WSL archive then lives at
 * `resources/wsl-runtime.tar.gz` exactly as an end user's install does.
 * Otherwise: unpack with 7-Zip and locate the same relative path.
 */
function extractInstaller(installer: string, scratch: string): string {
  const installDir = NodePath.join(scratch, "nsis-install");
  // eslint-disable-next-line t3code/no-global-process-runtime -- a plain Node CLI helper, not Effect code
  if (process.platform === "win32") {
    NodeFS.mkdirSync(installDir, { recursive: true });
    // NSIS requires /D to be last and unquoted; a path with spaces is fine.
    const status = NodeChildProcess.spawnSync(installer, ["/S", `/D=${installDir}`], {
      stdio: "inherit",
    }).status;
    if (status === 0) {
      const resources = NodePath.join(installDir, "resources");
      if (NodeFS.existsSync(resources)) return resources;
    } else {
      console.warn(`warn: silent NSIS install exited ${status}; falling back to 7-Zip extraction.`);
    }
  }
  const sevenZip = detectSevenZip();
  if (sevenZip === undefined) {
    throw new Error(
      "neither a real NSIS install nor 7-Zip is available; install 7-Zip (p7zip/7zip) to extract the installer",
    );
  }
  const extractDir = NodePath.join(scratch, "installer");
  NodeFS.mkdirSync(extractDir, { recursive: true });
  run(sevenZip, ["x", "-y", `-o${extractDir}`, installer]);
  return extractDir;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wsl-verify-"));

  const extractRoot = extractInstaller(args.installer, scratch);
  const embeddedPath = findFile(extractRoot, WSL_RUNTIME_ARCHIVE_NAME);

  const embeddedArchive =
    embeddedPath === undefined ? undefined : NodeFS.readFileSync(embeddedPath);
  const standaloneArchive = NodeFS.readFileSync(args.standaloneArchive);

  const embeddedInfo =
    embeddedPath === undefined ? undefined : readArchiveInfo(embeddedPath, scratch);
  const standaloneInfo = readArchiveInfo(args.standaloneArchive, scratch);

  const result = verifyEmbeddedWslRuntime({
    embeddedArchive,
    standaloneArchive,
    embeddedInfo,
    standaloneInfo,
    expected: {
      repository: args.repository,
      sourceSha: args.sourceSha,
      version: args.version,
      arch: args.arch,
    },
  });

  if (args.emitJson !== undefined) {
    const payload = {
      installer: embeddedInfo ?? null,
      linuxArchive: standaloneInfo ?? null,
      embeddedWslEqualsStandalone:
        embeddedArchive !== undefined && embeddedArchive.equals(standaloneArchive),
    };
    NodeFS.writeFileSync(args.emitJson, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Wrote embedded-provenance record to ${args.emitJson}`);
  }

  if (!result.ok) {
    for (const failure of result.failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log("Embedded WSL runtime matches the standalone Linux archive and its provenance.");
}

main();
