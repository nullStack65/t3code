#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A tiny file-staging helper; no workspace imports so it runs on a bare checkout.
/**
 * Stages one built artifact into the shared candidate directory.
 *
 * The per-platform build scripts write their outputs either directly into the
 * requested `--output-dir` or into the repo's default `release/` directory.
 * This helper resolves the artifact by name in either place and copies it into
 * the shared candidate directory, refusing to silently overwrite a file whose
 * bytes differ (which would signal mixed sources).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface Args {
  file: string;
  outputDir: string;
  sourceDir: string | undefined;
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
    file: required("file"),
    outputDir: required("output-dir"),
    sourceDir: values.get("source-dir")?.trim(),
  };
}

const SEARCH_DIRS = ["release", "release-cli", "."];

function findArtifact(name: string, sourceDir: string | undefined): string | undefined {
  const candidates = [sourceDir, ...SEARCH_DIRS].filter(
    (dir): dir is string => dir !== undefined && dir !== "",
  );
  for (const dir of candidates) {
    const full = NodePath.join(dir, name);
    if (NodeFS.existsSync(full) && NodeFS.statSync(full).isFile()) return full;
  }
  return undefined;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  NodeFS.mkdirSync(args.outputDir, { recursive: true });
  const destination = NodePath.join(args.outputDir, args.file);

  // Already staged by the build step (desktop builds write straight here).
  if (NodeFS.existsSync(destination)) {
    console.log(`Already staged: ${args.file}`);
    return;
  }

  const source = findArtifact(args.file, args.sourceDir);
  if (source === undefined) {
    throw new Error(`could not find built artifact ${args.file} to stage into ${args.outputDir}`);
  }
  NodeFS.copyFileSync(source, destination);
  console.log(`Staged ${source} -> ${destination}`);
}

main();
