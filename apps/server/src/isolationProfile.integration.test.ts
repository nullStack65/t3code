// @effect-diagnostics nodeBuiltinImport:off -- The isolation boundary test owns a private temporary profile marker.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerSettings from "./serverSettings.ts";
import { ISOLATION_ROOT_ENV, prepareIsolationProfile } from "@t3tools/shared/isolationRoot";

it.live(
  "blocks cloud credentials, relay startup, and awareness publishing in a claimed profile",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-isolation-test-"));
    const profileRoot = NodePath.join(parent, "profile");
    prepareIsolationProfile(profileRoot, [NodePath.join(parent, "account-home")]);
    const previousRoot = process.env[ISOLATION_ROOT_ENV];
    process.env[ISOLATION_ROOT_ENV] = profileRoot;

    return Effect.gen(function* () {
      const [tokenModule, runtimeModule, awarenessModule, deviceModule] = yield* Effect.promise(
        () =>
          Promise.all([
            import("./cloud/CliTokenManager.ts"),
            import("./cloud/ManagedEndpointRuntime.ts"),
            import("./relay/AgentAwarenessRelay.ts"),
            import("./device/DeviceService.ts"),
          ]),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tokens = yield* tokenModule.CloudCliTokenManager;
          assert.isTrue(Option.isNone(yield* tokens.getExisting));
          assert.isFalse(yield* tokens.hasCredential);
          const authError = yield* tokens.get.pipe(Effect.flip);
          assert.equal(authError._tag, "CloudCliAuthorizationError");
          assert.equal(
            (yield* Effect.result(
              tokens.store({
                accessToken: "must-not-store",
                refreshToken: "must-not-store",
                expiresAtEpochMs: 1,
              }),
            ))._tag,
            "Failure",
          );

          const runtime = yield* runtimeModule.CloudManagedEndpointRuntime;
          assert.deepEqual(yield* runtime.applyConfig(null), { status: "disabled" });

          const relay = yield* awarenessModule.AgentAwarenessRelay;
          yield* relay.publishThread(ThreadId.make("isolated-thread"));
          yield* relay.start();

          const deviceLayer = deviceModule.layerDisabled.pipe(
            Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
            Layer.provide(FetchHttpClient.layer),
          );
          const devices = yield* deviceModule.DeviceService.pipe(
            Effect.provide(Layer.mergeAll(deviceLayer, NodeServices.layer)),
          );
          assert.deepEqual((yield* devices.state).hosts, []);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            tokenModule.layerDisabled,
            runtimeModule.layerDisabled,
            awarenessModule.layerDisabled,
          ),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousRoot === undefined) delete process.env[ISOLATION_ROOT_ENV];
          else process.env[ISOLATION_ROOT_ENV] = previousRoot;
          NodeFS.rmSync(parent, { recursive: true, force: true });
        }),
      ),
    );
  },
);
