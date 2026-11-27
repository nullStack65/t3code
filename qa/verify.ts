// The one command that proves the map: builds the web client if needed, boots a seeded app, runs
// every spec in each viewport and color scheme, then writes status.json and the rendered report.
//   node verify.ts                       all four projects
//   node verify.ts --project desktop-light
//   node verify.ts --skip-build          reuse apps/web/dist
// With T3_QA_BASE_URL set it drives that deployment instead of booting one (see README below).
// @effect-diagnostics nodeBuiltinImport:off - a plain Node script, outside the server's Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FEATURES } from "./features.ts";
import { renderReport } from "./render-map.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const QA = import.meta.dirname;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const sha = NodeChildProcess.execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
const dirty =
  NodeChildProcess.execFileSync(
    "git",
    ["status", "--porcelain", "--", ".", ":!qa/status.json", ":!docs/FEATURES.md"],
    { cwd: ROOT, encoding: "utf8" },
  ).trim() !== "";
const date = new Date().toISOString().slice(0, 10);

const remote = process.env.T3_QA_BASE_URL;
if (
  !remote &&
  !flag("--skip-build") &&
  !NodeFS.existsSync(NodePath.join(ROOT, "apps/web/dist/index.html"))
) {
  console.log("Building apps/web (about 3 minutes)…");
  NodeChildProcess.execFileSync(NodePath.join(ROOT, "node_modules/.bin/vp"), ["build"], {
    cwd: NodePath.join(ROOT, "apps/web"),
    stdio: "inherit",
  });
}

const resultsFile = NodePath.join(QA, "test-results", "results.json");
NodeFS.rmSync(resultsFile, { force: true });
NodeFS.rmSync(NodePath.join(QA, "report", "shots"), { recursive: true, force: true });
const projects = value("--project");
const run = NodeChildProcess.spawnSync(
  NodePath.join(QA, "node_modules/.bin/playwright"),
  [
    "test",
    ...(projects ? [`--project=${projects}`] : []),
    ...args.filter((arg) => arg === "--update-snapshots"),
  ],
  { cwd: QA, stdio: "inherit", env: process.env },
);

if (!NodeFS.existsSync(resultsFile)) {
  console.error(
    "Playwright wrote no results (it failed before running specs). status.json was left as it was.",
  );
  process.exit(2);
}

interface Result {
  readonly status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  readonly error?: { readonly message?: string };
}
interface Test {
  readonly projectName: string;
  readonly annotations: ReadonlyArray<{ readonly type: string; readonly description?: string }>;
  readonly results: ReadonlyArray<Result>;
}
interface Suite {
  readonly suites?: ReadonlyArray<Suite>;
  readonly specs?: ReadonlyArray<{ readonly tests: ReadonlyArray<Test> }>;
}

type Outcome = "passed" | "failed" | "skipped";
const byFeature = new Map<
  string,
  Map<string, { outcome: Outcome; error?: string; notApplicable: boolean }>
>();
if (NodeFS.existsSync(resultsFile)) {
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const id = test.annotations.find(
          (annotation) => annotation.type === "feature",
        )?.description;
        if (id === undefined) continue;
        const last = test.results.at(-1);
        const outcome: Outcome =
          last?.status === "passed" ? "passed" : last?.status === "skipped" ? "skipped" : "failed";
        const projectsOf = byFeature.get(id) ?? new Map();
        projectsOf.set(test.projectName, {
          outcome,
          notApplicable: test.annotations.some(
            (annotation) => annotation.type === "not-applicable",
          ),
          ...(outcome === "failed"
            ? {
                error: (last?.error?.message ?? "failed")
                  .replace(/\u001b\[[0-9;]*m/g, "")
                  .split("\n")
                  .find((line) => line.trim() !== "")
                  ?.slice(0, 240),
              }
            : {}),
        });
        byFeature.set(id, projectsOf);
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (
    JSON.parse(NodeFS.readFileSync(resultsFile, "utf8")) as { suites: ReadonlyArray<Suite> }
  ).suites)
    walk(suite);
}

type Status = "verified" | "broken" | "unverified";
const features: Record<
  string,
  {
    status: Status;
    sha: string;
    date: string;
    reason?: string;
    projects: Record<string, Outcome>;
    errors?: Record<string, string>;
  }
> = {};
for (const feature of FEATURES) {
  const ran = byFeature.get(feature.id);
  const projectsOf = Object.fromEntries(
    [...(ran ?? [])]
      .filter(([, result]) => !result.notApplicable)
      .map(([name, result]) => [name, result.outcome]),
  );
  const errors = Object.fromEntries(
    [...(ran ?? [])].flatMap(([name, result]) => (result.error ? [[name, result.error]] : [])),
  );
  const outcomes = Object.values(projectsOf);
  if (feature.unverified !== undefined) {
    features[feature.id] = {
      status: "unverified",
      sha,
      date,
      reason: feature.unverified,
      projects: {},
    };
  } else if (outcomes.includes("failed")) {
    features[feature.id] = { status: "broken", sha, date, projects: projectsOf, errors };
  } else if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "passed")) {
    features[feature.id] = { status: "verified", sha, date, projects: projectsOf };
  } else {
    features[feature.id] = {
      status: "unverified",
      sha,
      date,
      reason: projects ? `not run in this selection (${projects})` : "no spec result",
      projects: projectsOf,
    };
  }
}

// A partial run (--project) must not downgrade features it did not run: keep their previous entry.
const statusFile = NodePath.join(QA, "status.json");
const previous = NodeFS.existsSync(statusFile)
  ? (JSON.parse(NodeFS.readFileSync(statusFile, "utf8")) as { features: typeof features }).features
  : {};
if (projects) {
  for (const [id, entry] of Object.entries(features)) {
    if (
      entry.status === "unverified" &&
      previous[id] &&
      FEATURES.find((feature) => feature.id === id)?.unverified === undefined
    )
      features[id] = previous[id]!;
  }
}
NodeFS.writeFileSync(
  statusFile,
  `${JSON.stringify({ sha, date, dirty, target: remote ?? "local build", features }, null, 2)}\n`,
);
renderReport();

const counts: Record<string, number> = {};
for (const entry of Object.values(features)) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
console.log(
  `\nverified ${counts.verified ?? 0}, broken ${counts.broken ?? 0}, unverified ${counts.unverified ?? 0} of ${FEATURES.length} (sha ${sha}${dirty ? ", dirty tree" : ""})`,
);
process.exit((counts.broken ?? 0) > 0 || (run.status ?? 1) > 1 ? 1 : 0);
