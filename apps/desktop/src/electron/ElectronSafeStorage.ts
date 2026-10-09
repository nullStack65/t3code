import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import * as DesktopIsolationProfile from "../app/DesktopIsolationProfile.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ElectronSafeStorage, makeService } from "./ElectronSafeStorageService.ts";

export * from "./ElectronSafeStorageService.ts";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const isIsolationProfile = DesktopIsolationProfile.isolationProfile !== undefined;
  return makeService(platform, isIsolationProfile, Electron.safeStorage);
});

export const layer = Layer.effect(ElectronSafeStorage, make);
