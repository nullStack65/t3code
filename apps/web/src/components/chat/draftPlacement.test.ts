import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadPlacementAdmitInput,
  OrchestrationV2ThreadPlacementAdmitError,
  type OrchestrationV2ThreadPlacementAdmitResult,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";

const origin = EnvironmentId.make("environment-laptop");
const box = EnvironmentId.make("environment-box");
const projectHere = ProjectId.make("project:laptop");
const projectThere = ProjectId.make("project:box");
const request = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  multipleModels: false,
} as const;
const KEY = "t3code:composer-drafts:v1";

const storageFaults = { drops: false };

async function openTab() {
  return {
    store: await import("../../composerDraftStore"),
    placement: await import("./draftPlacement"),
  };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

async function withStorage(run: (memory: ReturnType<typeof createMemoryStorage>) => Promise<void>) {
  const memory = createMemoryStorage();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => memory.getItem(name),
    removeItem: (name: string) => memory.removeItem(name),
    setItem: (name: string, value: string) => {
      if (!storageFaults.drops) memory.setItem(name, value);
    },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.useFakeTimers();
  vi.resetModules();
  try {
    await run(memory);
  } finally {
    storageFaults.drops = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}

function composeDraft(tab: Tab, name: string) {
  const draftId = tab.store.DraftId.make(`draft-${name}`);
  const store = tab.store.useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(origin, projectHere), draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: origin,
  });
  store.setPrompt(draftId, "Run the suite");
  return draftId;
}

/** What storage holds of the draft's placement operation right now. */
const storedOperation = (memory: ReturnType<typeof createMemoryStorage>, draftId: string) =>
  JSON.parse((memory.getItem(KEY) as string | null) ?? "{}")?.state?.draftThreadsByThreadKey?.[
    draftId
  ]?.placementOperation;

type Admit = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: OrchestrationV2ThreadPlacementAdmitInput;
}) => Promise<AsyncResult.AsyncResult<OrchestrationV2ThreadPlacementAdmitResult, unknown>>;

const admittedTo =
  (
    seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }>,
    memory: ReturnType<typeof createMemoryStorage>,
    draftId: string,
  ): Admit =>
  async ({ environmentId, input }) => {
    seen.push({
      environmentId,
      commandId: input.commandId,
      stored: storedOperation(memory, draftId),
    });
    return AsyncResult.success({
      environmentId: box,
      projectId: projectThere,
      reason: "capacity",
      resumed: seen.length > 1,
    });
  };

type PlacementRequest = Parameters<Tab["placement"]["placeDraftBeforeSend"]>[0]["request"];

const place = (
  tab: Tab,
  draftId: string,
  admit: Admit,
  options: {
    readonly canLaunchOn?: () => boolean;
    readonly hasAttachments?: boolean;
    readonly request?: PlacementRequest;
  } = {},
) =>
  tab.placement.placeDraftBeforeSend({
    draftId: tab.store.DraftId.make(draftId),
    request: options.request ?? request,
    candidateEnvironmentIds: [origin, box],
    hasAttachments: options.hasAttachments ?? false,
    admit: admit as never,
    canLaunchOn: options.canLaunchOn ?? (() => true),
    composerUnchanged: () => true,
  });

/** The origin refuses with one of its typed reasons. */
const refusing =
  (reason: OrchestrationV2ThreadPlacementAdmitError["reason"], asked?: Array<string>): Admit =>
  async ({ input }) => {
    asked?.push(input.commandId);
    return AsyncResult.failure(
      Cause.fail(
        new OrchestrationV2ThreadPlacementAdmitError({
          commandId: input.commandId,
          reason,
          detail: `refused: ${reason}`,
        }),
      ),
    );
  };

describe("placing an automatic draft before its send", () => {
  it("stores the operation before asking, and where it was bound before anything moves", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "ordered");
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      const outcome = await place(tab, draftId, admittedTo(seen, memory, draftId));
      expect(outcome).toEqual({ type: "placed", environmentId: box, projectId: projectThere });
      // The server was asked only once storage held the operation, without a binding yet.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.environmentId).toBe(origin);
      expect(seen[0]?.stored).toMatchObject({
        commandId: seen[0]?.commandId,
        admittedOn: origin,
        admittedProjectId: projectHere,
      });
      expect((seen[0]?.stored as { admission?: unknown } | undefined)?.admission).toBeUndefined();
      // Where it was bound is stored before the draft moves there.
      expect(storedOperation(memory, draftId)).toMatchObject({
        commandId: seen[0]?.commandId,
        admission: { environmentId: box, projectId: projectThere },
      });
      // Placing moves nothing itself: the routing hook retargets after this answer.
      expect(
        tab.store.useComposerDraftStore.getState().getDraftSession(tab.store.DraftId.make(draftId))
          ?.environmentId,
      ).toBe(origin);
    });
  });

  it("asks the same server for the same operation after a lost answer and a reload", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "retried");
      const asked: Array<{ environmentId: EnvironmentId; commandId: string }> = [];
      // The server bound it, but its answer was lost.
      const lost: Admit = async ({ environmentId, input }) => {
        asked.push({ environmentId, commandId: input.commandId });
        return AsyncResult.failure(Cause.die("connection lost"));
      };
      expect((await place(tab, draftId, lost)).type).toBe("failed");
      const reserved = storedOperation(memory, draftId);
      expect(reserved?.admission).toBeUndefined();

      vi.clearAllTimers();
      vi.resetModules();
      const reloaded = await openTab();
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      expect((await place(reloaded, draftId, admittedTo(seen, memory, draftId))).type).toBe(
        "placed",
      );
      expect(
        [...asked, ...seen].map(({ environmentId, commandId }) => [environmentId, commandId]),
      ).toEqual([
        [origin, reserved.commandId],
        [origin, reserved.commandId],
      ]);
      // Bound and stored, a retry still asks that server under this sign-in for the same one.
      const again: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      expect((await place(reloaded, draftId, admittedTo(again, memory, draftId))).type).toBe(
        "placed",
      );
      expect(again.map(({ environmentId, commandId }) => [environmentId, commandId])).toEqual([
        [origin, reserved.commandId],
      ]);
    });
  });

  it("asks nowhere when storage drops the operation, and keeps a known refusal's operation", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "unsaved");
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      storageFaults.drops = true;
      const unsaved = await place(tab, draftId, admittedTo(seen, memory, draftId));
      storageFaults.drops = false;
      expect(unsaved.type).toBe("failed");
      expect(seen).toHaveLength(0);
      expect(
        tab.store.useComposerDraftStore.getState().getDraftSession(tab.store.DraftId.make(draftId))
          ?.placementOperation ?? null,
      ).toBeNull();

      const refused: Admit = async ({ input }) =>
        AsyncResult.failure(
          Cause.fail(
            new OrchestrationV2ThreadPlacementAdmitError({
              commandId: input.commandId,
              reason: "other-session",
              detail: "This launch was started from another sign-in.",
            }),
          ),
        );
      const outcome = await place(tab, draftId, refused);
      expect(outcome).toMatchObject({
        type: "failed",
        description: "This launch was started from another sign-in.",
      });
      // The operation stays, so it is never admitted afresh under a new identity.
      expect(storedOperation(memory, draftId)?.commandId).toBeDefined();
    });
  });

  it("launches nowhere when this client's grant there is gone by the time it is bound", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "revoked");
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      const outcome = await place(tab, draftId, admittedTo(seen, memory, draftId), {
        canLaunchOn: () => false,
      });
      expect(outcome.type).toBe("failed");
      // Its binding is kept for a later retry; the draft stays where it was.
      expect(storedOperation(memory, draftId)?.admission).toEqual({
        environmentId: box,
        projectId: projectThere,
      });
      expect(
        tab.store.useComposerDraftStore.getState().getDraftSession(tab.store.DraftId.make(draftId))
          ?.environmentId,
      ).toBe(origin);
    });
  });

  it.each(["other-session", "excluded", "unavailable"] as const)(
    "never follows a stored binding its server now refuses (%s), after a reload",
    async (reason) => {
      await withStorage(async (memory) => {
        const tab = await openTab();
        const draftId = composeDraft(tab, `reconciled-${reason}`);
        const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> =
          [];
        expect((await place(tab, draftId, admittedTo(seen, memory, draftId))).type).toBe("placed");
        const bound = storedOperation(memory, draftId);
        vi.clearAllTimers();
        vi.resetModules();
        const reloaded = await openTab();
        // Another sign-in now, the machine excluded since, or this sign-in gone: refused there.
        const asked: Array<string> = [];
        const outcome = await place(reloaded, draftId, refusing(reason, asked));
        expect(outcome.type).toBe("failed");
        expect(asked).toEqual([bound.commandId]);
        // The operation and its binding stay as they were, for reconciling where it runs.
        expect(storedOperation(memory, draftId)).toEqual(bound);
        expect(
          reloaded.store.useComposerDraftStore
            .getState()
            .getDraftSession(reloaded.store.DraftId.make(draftId))?.environmentId,
        ).toBe(origin);
      });
    },
  );

  it("refuses changed work while an operation is open, without asking or replacing it", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "changed");
      const lost: Admit = async () => AsyncResult.failure(Cause.die("connection lost"));
      expect((await place(tab, draftId, lost)).type).toBe("failed");
      const reserved = storedOperation(memory, draftId);
      vi.clearAllTimers();
      vi.resetModules();
      const reloaded = await openTab();
      const asked: Array<string> = [];
      const changed: ReadonlyArray<PlacementRequest> = [
        {
          ...request,
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
          },
        },
        { ...request, runtimeMode: "approval-required" },
      ];
      for (const changedRequest of changed) {
        const outcome = await place(reloaded, draftId, refusing("unavailable", asked), {
          request: changedRequest,
        });
        expect(outcome).toMatchObject({
          type: "failed",
          title: "Your last send's placement is still open",
        });
      }
      expect(asked).toEqual([]);
      expect(storedOperation(memory, draftId)).toEqual(reserved);
      // Sent unchanged, it is the same operation again.
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      expect((await place(reloaded, draftId, admittedTo(seen, memory, draftId))).type).toBe(
        "placed",
      );
      expect(seen.map(({ commandId }) => commandId)).toEqual([reserved.commandId]);
    });
  });

  it("starts new work only after its server refused the last one without binding it", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "released");
      const asked: Array<string> = [];
      expect((await place(tab, draftId, refusing("no-eligible-environment", asked))).type).toBe(
        "failed",
      );
      expect(storedOperation(memory, draftId) ?? null).toBeNull();
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      expect((await place(tab, draftId, admittedTo(seen, memory, draftId))).type).toBe("placed");
      expect(seen[0]?.commandId).not.toBe(asked[0]);
    });
  });

  it("keeps attachments on the machine they were added on, rather than moving them", async () => {
    await withStorage(async (memory) => {
      const tab = await openTab();
      const draftId = composeDraft(tab, "attached");
      const seen: Array<{ environmentId: EnvironmentId; commandId: string; stored: unknown }> = [];
      const outcome = await place(tab, draftId, admittedTo(seen, memory, draftId), {
        hasAttachments: true,
      });
      expect(outcome).toMatchObject({ type: "failed" });
      expect(
        tab.store.useComposerDraftStore.getState().getDraftSession(tab.store.DraftId.make(draftId))
          ?.environmentId,
      ).toBe(origin);
    });
  });

  it("reconciles a held operation first, whatever automatic routing allows new work", async () => {
    await withStorage(async () => {
      const tab = await openTab();
      const held = { placementOperation: heldOperation, promotedTo: null };
      const fresh = { placementOperation: null, promotedTo: null };
      const multiple: PlacementRequest = { ...request, multipleModels: true };
      const cases: ReadonlyArray<
        readonly [typeof held | typeof fresh, boolean, boolean, PlacementRequest, boolean]
      > = [
        [held, false, true, multiple, true],
        [held, true, false, request, true],
        [fresh, true, false, request, true],
        [fresh, false, false, request, false],
        [fresh, true, true, request, false],
        [fresh, true, false, multiple, false],
      ];
      for (const [draft, automatic, hasAttachments, asked, places] of cases) {
        expect(
          tab.placement.placesBeforeSend({ draft, automatic, hasAttachments, request: asked }),
        ).toBe(places);
      }
      // A send already bound for its launch is not placed again.
      expect(
        tab.placement.placesBeforeSend({
          draft: { ...held, promotedTo: scopeThreadRef(box, ThreadId.make("thread")) },
          automatic: true,
          hasAttachments: false,
          request,
        }),
      ).toBe(false);
    });
  });
});

const heldOperation = {
  commandId: "command",
  messageId: "message",
  createdAt: "2026-11-18T12:00:00.000Z",
  admittedOn: origin,
  admittedProjectId: projectHere,
  intent: "{}",
};
