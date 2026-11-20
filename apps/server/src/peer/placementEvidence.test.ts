import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { hereEvidence } from "./placementEvidence.ts";

const provider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  version: "test",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "claude-opus",
      name: "Opus",
      aliases: ["Opus"],
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
} as ServerProvider;

it.effect("placement evidence rejects a Grok model on claudeAgent and accepts a served alias", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:placement-model");
    const evidence = (model: string) =>
      hereEvidence({
        projectId,
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model },
        runtimeMode: "full-access",
      });
    assert.equal((yield* evidence("grok/grok-4.7")).modelAvailable, false);
    assert.equal((yield* evidence("Opus")).modelAvailable, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProviderRegistryMock.layer([provider]), ServerSettings.layerTest()),
    ),
  ),
);
