import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { undismissLinkedEnvironment } from "../state/linkedEnvironmentDismissals";
import { connectionAtomRuntime } from "./runtime";

// Adding a machine by any path is the way back from removing it, so it may be added on its own again.
const undismissAdded = (environmentId: EnvironmentId) =>
  Effect.sync(() => void undismissLinkedEnvironment(environmentId));

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
      Effect.tap(undismissAdded),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
      Effect.tap(undismissAdded),
    ),
});

export const reachesEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:reaches-environment",
  execute: (input: { readonly host: string; readonly environmentId: EnvironmentId }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.reaches(input)),
    ),
});
