import type { ScopedThreadRef, ThreadStanding } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { defaultBotPersona, requestBotPersona } from "./BotPersonaDialog";

/** Runs a bot menu action; returns false for any other action. */
export async function runBotMenuAction<R>(input: {
  readonly action: string;
  readonly threadRef: ScopedThreadRef;
  readonly thread: Pick<EnvironmentThreadShell, "id" | "title" | "standing">;
  readonly setThreadStanding: (
    target: ScopedThreadRef,
    standing: ThreadStanding | null,
  ) => Promise<R>;
  readonly report: (title: string, run: () => Promise<R>) => Promise<void>;
}): Promise<boolean> {
  const { action, threadRef, thread } = input;
  if (action === "make-ordinary") {
    await input.report("Failed to make an ordinary thread", () =>
      input.setThreadStanding(threadRef, null),
    );
    return true;
  }
  if (action !== "make-bot" && action !== "edit-bot") return false;
  const persona = await requestBotPersona({
    initial: thread.standing ?? defaultBotPersona(thread),
    isNew: thread.standing === null,
  });
  if (persona === null) return true;
  await input.report("Failed to save the bot persona", () =>
    input.setThreadStanding(threadRef, persona),
  );
  return true;
}
