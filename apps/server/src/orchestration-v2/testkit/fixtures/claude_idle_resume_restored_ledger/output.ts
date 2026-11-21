import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_IDLE_RESUME_PROMPT_1,
  CLAUDE_IDLE_RESUME_PROMPT_2,
} from "../claude_idle_resume/input.ts";

export function assertClaudeIdleResumeRestoredLedgerOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_IDLE_RESUME_PROMPT_1, CLAUDE_IDLE_RESUME_PROMPT_2]);

  const [first, second] = projection.providerTurns.map((turn) => turn.turnTokenUsage);
  assert.deepInclude(first, {
    usageStatus: "complete",
    inputTokens: 11_795,
    outputTokens: 7,
    otherUsage: { inputTokens: 0, outputTokens: 0 },
  });
  assert.deepInclude(second, { usageStatus: "complete", inputTokens: 11_814, outputTokens: 7 });
  assert.notProperty(second, "otherUsage");
}
