// @effect-diagnostics deterministicKeys:off -- Preserve the existing public service identifier while isolating pure logic from Electron imports.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const errorFields = { cause: Schema.Defect() };

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedError<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  errorFields,
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedError<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  errorFields,
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedError<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  errorFields,
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;

export interface ElectronSafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
  getSelectedStorageBackend(): string | undefined;
}

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/electron/ElectronSafeStorage") {}

export function makeService(
  platform: string,
  isIsolationProfile: boolean,
  safeStorage: ElectronSafeStorageAdapter,
): ElectronSafeStorage["Service"] {
  return ElectronSafeStorage.of({
    isEncryptionAvailable: isIsolationProfile
      ? Effect.succeed(false)
      : Effect.try({
          try: () => safeStorage.isEncryptionAvailable(),
          catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
        }),
    encryptString: (value) =>
      isIsolationProfile
        ? Effect.fail(
            new ElectronSafeStorageEncryptError({ cause: new Error("isolation profile") }),
          )
        : Effect.try({
            try: () => safeStorage.encryptString(value),
            catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
          }),
    decryptString: (value) =>
      isIsolationProfile
        ? Effect.fail(
            new ElectronSafeStorageDecryptError({ cause: new Error("isolation profile") }),
          )
        : Effect.try({
            try: () => safeStorage.decryptString(value),
            catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
          }),
    selectedStorageBackend: Effect.sync(() => {
      if (isIsolationProfile || platform !== "linux") return Option.none();
      try {
        return Option.fromNullishOr(safeStorage.getSelectedStorageBackend());
      } catch {
        return Option.none();
      }
    }),
  });
}
