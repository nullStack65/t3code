import type { MessageId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export interface CurrentSkillRequest {
  readonly messageId: MessageId;
  readonly text: string;
  readonly activationAllowed: boolean;
  readonly conversation: Effect.Effect<
    ReadonlyArray<{ readonly id: MessageId; readonly role: string; readonly text: string }>,
    ProjectionRepositoryError
  >;
}

// This capability follows the current client message through prompt assembly.
// JSON, retrieved context and provider output cannot create it.
const requests = new WeakMap<object, CurrentSkillRequest>();

export function bindCurrentSkillRequest(target: object, request: CurrentSkillRequest): void {
  requests.set(target, Object.freeze({ ...request }));
}

export function currentSkillRequest(target: object): CurrentSkillRequest | undefined {
  return requests.get(target);
}

export function carryCurrentSkillRequest(source: object, target: object): void {
  const request = requests.get(source);
  if (request) requests.set(target, request);
}
