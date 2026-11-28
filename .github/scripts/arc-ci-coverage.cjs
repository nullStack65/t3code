const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW = ".github/workflows/closura-arc-ci.yml";
const REQUIRED_CHECK = "Voice + founder inbox (Linux ARC)";
const WORKERS = ["voice-and-inbox-core", "voice-and-inbox-web", "voice-and-inbox-mobile"];

// Every test the single serial job ran before the split. A parallel job that
// drops one of these makes the required check pass without running it.
const REQUIRED_TESTS = [
  "apps/server/src/speech/CloudSpeech.test.ts",
  "apps/server/src/speech/GroqSpeechStream.test.ts",
  "apps/server/src/speech/stream.test.ts",
  "packages/contracts/src/threadInbox.test.ts",
  "packages/contracts/src/threadInbox.invariants.test.ts",
  "packages/contracts/src/threadInbox.upgrade.test.ts",
  "packages/contracts/src/threadMetadataMcp.test.ts",
  "apps/web/src/components/threadActionMenu.logic.test.ts",
  "apps/web/src/components/sidebar/threadListFilter.logic.test.ts",
  "packages/client-runtime/src/state/threadAttribution.test.ts",
  "apps/server/src/orchestration-v2/ThreadLaunchService.test.ts",
  "apps/server/src/orchestration-v2/SubagentProjection.test.ts",
  "apps/server/src/orchestration-v2/ModelAlertReactor.test.ts",
  "apps/server/src/orchestration-v2/ThreadEventAlerts.test.ts",
  "apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts",
  "apps/server/src/orchestration-v2/SteeringCompletion.integration.test.ts",
  "packages/shared/src/threadPlacement.test.ts",
  "apps/server/src/peer/RemoteDelegation.test.ts",
  "apps/server/src/mcp/OrchestratorMcpService.test.ts",
  "apps/server/src/cli/thread.test.ts",
  "apps/web/src/composerDraftStore.test.ts",
  "packages/client-runtime/src/voice-input/controller.test.ts",
  "apps/web/src/components/chat/composerSend.logic.test.ts",
  "apps/web/src/components/chat/chatViewSend.test.ts",
  "apps/web/src/components/chat/composerImagePersistence.test.ts",
  "apps/web/src/components/chat/draftPlacement.test.ts",
  "apps/web/src/components/chat/draftAttachmentUploads.test.ts",
  "apps/web/src/components/chat/draftUploadReconcile.test.ts",
  "apps/web/src/lib/attachmentUploadQueue.test.ts",
  "apps/server/src/ws.test.ts",
  "packages/contracts/src/environment.test.ts",
  "scripts/feature-map.test.ts",
  "apps/mobile/src/state/thread-placement.model.test.ts",
  "apps/mobile/src/state/threadOutboxDelivery.placement.test.ts",
  "apps/mobile/src/state/composer-attachment-uploads.test.ts",
  "apps/mobile/src/lib/composerAttachmentUploadQueue.test.ts",
  "apps/mobile/src/lib/attachmentUpload.test.ts",
  "apps/mobile/src/state/use-composer-drafts.test.ts",
  "apps/mobile/src/state/thread-outbox.test.ts",
  "apps/mobile/src/state/threadOutboxDelivery.permissions.test.ts",
  "apps/mobile/src/state/threadOutboxDelivery.test.ts",
  "apps/mobile/src/state/pending-thread-creation.test.ts",
  "apps/mobile/src/lib/projectThreadStartTurn.test.ts",
  "apps/mobile/src/features/threads/thread-route-state.test.ts",
  "apps/mobile/src/features/threads/new-task-flow-provider.test.tsx",
  "apps/mobile/src/features/home/pendingTaskRoute.test.tsx",
  "apps/mobile/src/features/threads/NewTaskDraftRouteScreen.test.tsx",
  "apps/web/src/speech/voiceInputLatency.browser.test.ts",
  "apps/web/src/speech/useEnvironmentSpeechInput.browser.test.tsx",
];

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Workflow files are small and this only needs the step structure, so a flat
// scan beats pulling in a YAML parser. It tracks job ids, job names, `needs`,
// and the `run` / `working-directory` pairs inside each job's steps.
function parseWorkflow(source) {
  const jobs = {};
  let current = null;
  let inRun = false;
  let runIndent = 0;
  let inTriggers = true;
  const lines = source.split("\n");
  for (const line of lines) {
    if (inRun) {
      const indent = line.match(/^\s*/)[0].length;
      if (line.trim() !== "" && indent <= runIndent) inRun = false;
      else {
        current.run.push(line.trim().replace(/\\$/, "").trim());
        continue;
      }
    }
    if (inTriggers) {
      if (line === "jobs:") inTriggers = false;
      continue;
    }
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job) {
      current = { id: job[1], name: null, needs: [], condition: null, steps: [] };
      jobs[current.id] = current;
      continue;
    }
    if (!current) continue;
    const condition = line.match(/^ {4}if:\s*(.+)$/);
    if (condition && current.condition === null && current.steps.length === 0) {
      current.condition = unquote(condition[1]);
      continue;
    }
    if (!current) continue;
    const name = line.match(/^ {4}name:\s*(.+)$/);
    if (name) {
      current.name = unquote(name[1]);
      continue;
    }
    const needs = line.match(/^ {4}needs:\s*\[([^\]]*)\]/);
    if (needs) {
      current.needs = needs[1]
        .split(",")
        .map((item) => unquote(item))
        .filter(Boolean);
      continue;
    }
    const stepStart = line.match(/^ {6}- (.*)$/);
    if (stepStart) {
      current.step = { directory: "", conditional: false, run: [] };
      current.steps.push(current.step);
      if (/^if:/.test(stepStart[1])) current.step.conditional = true;
      continue;
    }
    if (!current.step) continue;
    if (/^ {8}if:/.test(line)) {
      current.step.conditional = true;
      continue;
    }
    const directory = line.match(/^ {8}working-directory:\s*(.+)$/);
    if (directory) {
      current.step.directory = unquote(directory[1]);
      continue;
    }
    const run = line.match(/^ {8}run:\s*(\||>)?\s*$/);
    if (run) {
      current.run = current.step.run;
      inRun = true;
      runIndent = 8;
    }
  }
  return jobs;
}

// A test path only counts when a worker actually invokes it. A path that only
// appears inside a comment, a branch that never runs, or a step with any `if:`
// would otherwise let the guard pass while the required check runs nothing.
// Step conditions are not evaluated: no covering step needs one.
function testsIn(job) {
  const found = [];
  for (const step of job.steps) {
    if (step.conditional) continue;
    const prefix = step.directory ? `${step.directory}/` : "";
    let skipping = false;
    for (const line of step.run) {
      if (/^(?:if\s+false\b|exit\b)/.test(line)) skipping = true;
      else if (skipping && /^(?:fi|else|elif)\b/.test(line)) skipping = false;
      if (skipping || line.startsWith("#")) continue;
      if (/^[\w./-]+\.(ts|tsx)$/.test(line)) found.push(prefix + line);
    }
  }
  return found;
}

function jobBody(source, id) {
  const marker = `\n  ${id}:`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n {2}[\w-]+:\s*\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function checkCoverage(source) {
  const jobs = parseWorkflow(source);
  const problems = [];
  const aggregator = jobs["voice-and-inbox"];
  if (!aggregator) problems.push("missing voice-and-inbox job");
  else {
    if (aggregator.name !== REQUIRED_CHECK) {
      problems.push(`required check is named ${JSON.stringify(aggregator.name)}`);
    }
    const needs = [...aggregator.needs].sort();
    if (needs.join() !== [...WORKERS].sort().join()) {
      problems.push(`aggregator needs ${needs.join(", ") || "nothing"}`);
    }
    // `always()` is true for a cancelled run, and a worker that never started
    // reports success, so the required check would pass with nothing tested.
    if (!aggregator.condition || !aggregator.condition.includes("!cancelled()")) {
      problems.push("aggregator runs when the workflow is cancelled");
    }
    // The ARC image has no node on PATH. setup-node downloads an official
    // Node 26 binary that needs libatomic, so both have to run first.
    const body = jobBody(source, "voice-and-inbox");
    const libatomic = body.indexOf("uses: ./.github/actions/provide-libatomic");
    const setupNode = body.indexOf("uses: actions/setup-node@");
    const guard = body.indexOf("run: node .github/scripts/arc-ci-coverage.cjs");
    if (
      libatomic < 0 ||
      setupNode < 0 ||
      guard < 0 ||
      !(libatomic < setupNode && setupNode < guard)
    ) {
      problems.push("coverage guard runs before Node is on PATH");
    }
  }
  const ran = [];
  for (const id of WORKERS) {
    if (!jobs[id]) {
      problems.push(`missing worker ${id}`);
      continue;
    }
    ran.push(...testsIn(jobs[id]));
  }
  const ranSet = new Set(ran);
  for (const test of REQUIRED_TESTS) {
    if (!ranSet.has(test)) problems.push(`no worker runs ${test}`);
  }
  const duplicates = ran.filter((test, index) => ran.indexOf(test) !== index);
  for (const test of new Set(duplicates)) problems.push(`run twice: ${test}`);
  return problems;
}

module.exports = { REQUIRED_CHECK, REQUIRED_TESTS, WORKERS, checkCoverage, parseWorkflow };

if (require.main === module) {
  const root = process.argv[2] ?? process.cwd();
  const source = fs.readFileSync(path.join(root, WORKFLOW), "utf8");
  const problems = checkCoverage(source);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${REQUIRED_CHECK} covers ${REQUIRED_TESTS.length} tests across ${WORKERS.length} workers\n`,
  );
}
