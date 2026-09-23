#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A CI verification utility that shells out to 7-Zip and tar.
/**
 * Verifies the WSL runtime embedded in a Windows installer against the
 * standalone Linux x64 archive. Run on the `qualify` runner after installing
 * `p7zip-full`. The pure comparison lives in `lib/wsl-payload.ts`; this file
 * only extracts the bytes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseBuildInfo } from "./lib/source-provenance.ts";
import { verifyEmbeddedWslRuntime, type EmbeddedBuildInfo } from "./lib/wsl-payload.ts";

interface Args {
  installer: string;
  standaloneArchive: string;
  repository: string;
  sourceSha: string;
  version: string;
  arch: string;
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
  };
}

const run = (command: string, args: ReadonlyArray<string>): void => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? "unknown"}`);
  }
};

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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wsl-verify-"));

  const extractDir = NodePath.join(scratch, "installer");
  NodeFS.mkdirSync(extractDir, { recursive: true });
  run("7z", ["x", "-y", `-o${extractDir}`, args.installer]);
  const embeddedPath = findFile(extractDir, "wsl-runtime.tar.gz");

  const embeddedArchive =
    embeddedPath === undefined ? undefined : NodeFS.readFileSync(embeddedPath);
  const standaloneArchive = NodeFS.readFileSync(args.standaloneArchive);

  const result = verifyEmbeddedWslRuntime({
    embeddedArchive,
    standaloneArchive,
    embeddedInfo: embeddedPath === undefined ? undefined : readArchiveInfo(embeddedPath, scratch),
    standaloneInfo: readArchiveInfo(args.standaloneArchive, scratch),
    expected: {
      repository: args.repository,
      sourceSha: args.sourceSha,
      version: args.version,
      arch: args.arch,
    },
  });

  if (!result.ok) {
    for (const failure of result.failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log("Embedded WSL runtime matches the standalone Linux archive and its provenance.");
}

main();
