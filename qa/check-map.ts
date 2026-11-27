// Fails when the feature map and the specs disagree, and (with --changed <base>) when a PR changes
// a feature's code without touching its map entry, its spec or its status.
//   node check-map.ts                      map and specs agree
//   node check-map.ts --changed origin/release/native-0.1.10
// @effect-diagnostics nodeBuiltinImport:off - a plain Node script, outside the server's Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FEATURES } from "./features.ts";
import { listSpecs } from "./list-specs.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const problems: string[] = [];
const fail = (message: string) => problems.push(message);

const specs = listSpecs();
const specIds = new Set(specs.map((spec) => spec.id));
const ids = FEATURES.map((feature) => feature.id);
for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index)))
  fail(`duplicate feature id ${id}`);

for (const feature of FEATURES) {
  const covered = specIds.has(feature.id);
  if (feature.unverified === undefined && !covered)
    fail(`${feature.id} has no spec: add one, or set \`unverified\` with the reason`);
  if (feature.unverified !== undefined && covered)
    fail(`${feature.id} has a spec but is marked unverified: remove \`unverified\``);
  if (feature.drive.length === 0 || feature.success.trim() === "")
    fail(`${feature.id} needs drive steps and a success state`);
  for (const code of feature.code) {
    const target = NodePath.join(ROOT, code);
    if (!NodeFS.existsSync(target)) fail(`${feature.id} lists code that does not exist: ${code}`);
  }
}
for (const id of specIds)
  if (!ids.includes(id)) fail(`a spec names ${id}, which is not in features.ts`);

const changedIndex = process.argv.indexOf("--changed");
if (changedIndex !== -1) {
  const base = process.argv[changedIndex + 1];
  if (base === undefined) throw new Error("--changed needs a base ref");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const isTest = (file: string) =>
    /\.(test|browser\.test)\.[cm]?[jt]sx?$/.test(file) || file.includes("/test/");
  const code = changed.filter(
    (file) => !isTest(file) && !file.startsWith("qa/") && !file.startsWith("docs/"),
  );

  // Line ranges of each entry in features.ts, so an edit to the entry itself counts.
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "features.ts"),
    "utf8",
  ).split("\n");
  const starts = source.flatMap((line, index) =>
    /^\s*id: "/.test(line) || /^\s*id: `/.test(line) ? [index + 1] : [],
  );
  const rangeOf = (id: string): [number, number] | undefined => {
    const at = source.findIndex((line) => line.includes(`id: "${id}"`));
    if (at !== -1) {
      const next = starts.find((start) => start > at + 1) ?? source.length;
      return [at + 1, next - 1];
    }
    // Entries built from the settings table share one range.
    if (id.startsWith("settings.")) {
      const from = source.findIndex((line) => line.includes("id: `settings.${slug}`"));
      return from === -1 ? undefined : [Math.max(1, from - 6), from + 10];
    }
    return undefined;
  };
  const hunks = git("diff", "-U0", `${base}...HEAD`, "--", "qa/features.ts")
    .split("\n")
    .flatMap((line) => {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      return match
        ? [[Number(match[1]), Number(match[1]) + Math.max(Number(match[2] ?? "1") - 1, 0)] as const]
        : [];
    });
  const statusDiff = changed.includes("qa/status.json")
    ? git("diff", "-U0", `${base}...HEAD`, "--", "qa/status.json")
    : "";
  const specFile = new Map(specs.map((spec) => [spec.id, `qa/${spec.file}`]));

  const updated = (feature: (typeof FEATURES)[number]) => {
    const range = rangeOf(feature.id);
    const entryEdited =
      range !== undefined && hunks.some(([from, to]) => from <= range[1] && to >= range[0]);
    const specEdited = specFile.has(feature.id) && changed.includes(specFile.get(feature.id)!);
    return entryEdited || specEdited || statusDiff.includes(`"${feature.id}"`);
  };
  // Code often serves several features (a whole directory), so each changed file needs one of its
  // features updated, not all of them.
  for (const file of code) {
    const owners = FEATURES.filter((feature) =>
      feature.code.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)),
    );
    if (owners.length === 0 || owners.some(updated)) continue;
    const names = owners
      .slice(0, 4)
      .map((feature) => feature.id)
      .join(", ");
    fail(
      `${file} belongs to ${names}${owners.length > 4 ? ", …" : ""}, and none of their map entries, specs or statuses changed. Update the entry that describes this change in qa/features.ts, or re-verify it with qa/verify.ts, in this PR.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `Feature map check failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `Feature map ok: ${FEATURES.length} features, ${specIds.size} with specs, ${FEATURES.filter((feature) => feature.unverified !== undefined).length} marked unverified.`,
);
