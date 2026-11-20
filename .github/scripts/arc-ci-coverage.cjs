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
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job && !line.startsWith("    ")) {
      current = { id: job[1], name: null, needs: [], steps: [] };
      jobs[current.id] = current;
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
    const directory = line.match(/^ {8}working-directory:\s*(.+)$/);
    if (directory) {
      current.directory = unquote(directory[1]);
      continue;
    }
    const run = line.match(/^ {8}run:\s*(\||>)?\s*$/);
    if (run) {
      const step = { directory: current.directory ?? "", run: [] };
      current.steps.push(step);
      current.run = step.run;
      current.directory = "";
      inRun = true;
      runIndent = 8;
    }
  }
  return jobs;
}

function testsIn(job) {
  const found = [];
  for (const step of job.steps) {
    const prefix = step.directory ? `${step.directory}/` : "";
    for (const line of step.run) {
      if (/^[\w./-]+\.(ts|tsx)$/.test(line)) found.push(prefix + line);
    }
  }
  return found;
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
