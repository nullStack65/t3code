import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { CodexSessionGuardSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeCodexGuardFixture, writeDeviceDocument } from "../testUtils/codexGuardFixture.ts";
import { admitCodexSession, CodexSessionGuardRefused } from "./CodexSessionGuard.ts";
import type { CodexSessionGuardAdmission } from "./CodexSessionGuard.ts";

const admit = (
  settings: CodexSessionGuardSettings,
  overrides: {
    readonly homePath?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: string;
  } = {},
) =>
  admitCodexSession({
    settings,
    homePath: overrides.homePath ?? "",
    environment: overrides.environment ?? {},
    platform: overrides.platform ?? "darwin",
  });

const expectRefused = (admission: CodexSessionGuardAdmission) => {
  if (admission.status !== "refused") throw new Error("expected a refusal");
  return admission.refused;
};

it.layer(NodeServices.layer)("CodexSessionGuard", (it) => {
  it.effect("leaves hosts that never opted in on the existing spawn path", () =>
    Effect.gen(function* () {
      // Nothing here could validate: the point is that `disabled` never looks.
      const refused = yield* admit({
        mode: "disabled",
        interpreter: "",
        launcher: "",
        sourceRoot: "",
        deviceFile: "",
        stateRoot: "",
      });
      expect(refused).toEqual({ status: "disabled" });
    }),
  );

  it.effect("is stateless, so re-enrolling and reverting re-decide from scratch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const enabled = expectRefused(yield* admit(fixture.settings));
      expect(enabled.reason).toBe("unqualified-host");
      const reverted = yield* admit({ ...fixture.settings, mode: "disabled" });
      expect(reverted).toEqual({ status: "disabled" });
    }),
  );

  it.effect("refuses enrolled hosts whose references are missing", () =>
    Effect.gen(function* () {
      const refused = expectRefused(
        yield* admit({
          mode: "enforce",
          interpreter: "",
          launcher: "",
          sourceRoot: "",
          deviceFile: "",
          stateRoot: "",
        }),
      );
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.blockers).toEqual([]);
      expect(refused.detail).toContain("interpreter");
    }),
  );

  it.effect("refuses a launcher that is not the reviewed entrypoint", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const path = yield* Path.Path;
      const renamed = path.join(path.dirname(fixture.launcher), "launcher.py");
      const fs = yield* FileSystem.FileSystem;
      yield* fs.rename(fixture.launcher, renamed);
      const refused = expectRefused(yield* admit({ ...fixture.settings, launcher: renamed }));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("launcher");
    }),
  );

  it.effect("pins the exact reviewed launcher path, not just its depth and basename", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const lookalike = path.join(
        fixture.sourceRoot,
        "company",
        "agent-environment",
        "other-delivery",
        "launch_provider.py",
      );
      yield* fs.makeDirectory(path.dirname(lookalike), { recursive: true });
      yield* fs.writeFileString(lookalike, "# looks reviewed\n");
      const refused = expectRefused(yield* admit({ ...fixture.settings, launcher: lookalike }));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("launcher");
    }),
  );

  it.effect("refuses a source root that does not contain the launcher", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const path = yield* Path.Path;
      const otherRoot = path.join(fixture.sourceRoot, "other");
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(otherRoot, { recursive: true });
      const refused = expectRefused(yield* admit({ ...fixture.settings, sourceRoot: otherRoot }));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("sourceRoot");
    }),
  );

  it.effect("refuses an aliased state root instead of following it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const alias = path.join(fixture.sourceRoot, "state-alias");
      yield* fs.symlink(fixture.stateRoot, alias);
      const refused = expectRefused(yield* admit({ ...fixture.settings, stateRoot: alias }));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("canonical");
    }),
  );

  it.effect("refuses a device document that names a different state root", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const otherRoot = path.join(fixture.sourceRoot, "other-state");
      yield* fs.makeDirectory(path.join(otherRoot, "session-fence"), { recursive: true });
      yield* fs.writeFileString(
        path.join(otherRoot, "session-fence", ".omp-company-profile.lock"),
        "",
      );
      yield* writeDeviceDocument(fixture.deviceFile, otherRoot);
      const refused = expectRefused(yield* admit(fixture.settings));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("does not match the device state_root");
    }),
  );

  it.effect("refuses a fence inode that is not a single link", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.link(fixture.fence, path.join(fixture.stateRoot, "second-link"));
      const refused = expectRefused(yield* admit(fixture.settings));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("single-link");
    }),
  );

  it.effect("refuses an uninitialized fence", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(fixture.fence);
      const refused = expectRefused(yield* admit(fixture.settings));
      expect(refused.reason).toBe("invalid-settings");
      expect(refused.detail).toContain("session fence");
    }),
  );

  it.effect("refuses a qualified-looking host because Codex descriptor retention is unproven", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const refused = expectRefused(yield* admit(fixture.settings));
      expect(refused.reason).toBe("unqualified-host");
      expect(refused.blockers).toEqual(["provider-descriptor-retention-unqualified"]);
      expect(refused.message).toContain("provider-descriptor-retention-unqualified");
    }),
  );

  it.effect("reports provider-root overrides instead of stripping them", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const refused = expectRefused(
        yield* admit(fixture.settings, {
          homePath: "/tmp/codex-work",
          environment: { ANTHROPIC_API_KEY: "sk-fixture-never-echo" },
        }),
      );
      expect(refused.reason).toBe("unqualified-host");
      expect(refused.blockers).toEqual([
        "provider-root-override",
        "provider-descriptor-retention-unqualified",
      ]);
      expect(refused.detail).toContain("CODEX_HOME");
      // No credential or environment value may reach diagnostics.
      expect(refused.message).not.toContain("sk-fixture-never-echo");
    }),
  );

  it.effect("treats an inherited provider-root override as an override", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const refused = expectRefused(
        yield* admit(fixture.settings, { environment: { CODEX_HOME: "/inherited/codex" } }),
      );
      expect(refused.blockers).toContain("provider-root-override");
      expect(refused.detail).not.toContain("/inherited/codex");
    }),
  );

  it.effect("refuses platforms the fence contract does not cover", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const refused = expectRefused(yield* admit(fixture.settings, { platform: "win32" }));
      expect(refused.blockers).toEqual([
        "platform-unqualified",
        "provider-descriptor-retention-unqualified",
      ]);
    }),
  );

  it.effect("serializes refusals through the tagged error contract", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCodexGuardFixture();
      const refused = expectRefused(yield* admit(fixture.settings));
      expect(refused).toBeInstanceOf(CodexSessionGuardRefused);
      expect(refused._tag).toBe("CodexSessionGuardRefused");
    }),
  );
});
