import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as ElectronSafeStorageService from "./ElectronSafeStorageService.ts";

it.effect("does not call native safe storage in an isolation profile", () => {
  let nativeCalls = 0;
  const native = () => {
    nativeCalls += 1;
    throw new Error("native safe storage must not be called");
  };
  const service = ElectronSafeStorageService.makeService("darwin", true, {
    isEncryptionAvailable: native,
    encryptString: native,
    decryptString: native,
    getSelectedStorageBackend: native,
  });

  return Effect.gen(function* () {
    assert.isFalse(yield* service.isEncryptionAvailable);
    assert.isTrue(Option.isNone(yield* service.selectedStorageBackend));
    assert.isTrue(Result.isFailure(yield* Effect.result(service.encryptString("synthetic"))));
    assert.isTrue(Result.isFailure(yield* Effect.result(service.decryptString(new Uint8Array()))));
    assert.equal(nativeCalls, 0);
  });
});
