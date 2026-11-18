import { describe, expect, it } from "vite-plus/test";
import { chooseThreadPlacement, type ThreadPlacementCandidate } from "./threadPlacement.ts";

const now = 1_000_000;
const GiB = 1024 ** 3;
const host = (
  environmentId: string,
  cpuUtilization: number | null,
  overrides: Partial<ThreadPlacementCandidate> = {},
): ThreadPlacementCandidate => ({
  environmentId,
  resources: {
    sampledAt: now,
    cpuUtilization,
    cpuCount: 8,
    availableMemoryBytes: 8 * GiB,
    totalMemoryBytes: 16 * GiB,
  },
  receivedAt: now,
  weight: 50,
  operable: true,
  projectAvailable: true,
  modelAvailable: true,
  ...overrides,
});
const origin = { originEnvironmentId: "here" };

describe("chooseThreadPlacement", () => {
  it("lets a named target and local state win over capacity", () => {
    const candidates = [host("here", 0.9), host("idle", 0.01)];
    expect(
      chooseThreadPlacement({ ...origin, pinnedEnvironmentId: "here" }, candidates, now),
    ).toEqual({ accepted: true, environmentId: "here", reason: "pinned" });
    expect(chooseThreadPlacement({ ...origin, requiresOrigin: true }, candidates, now)).toEqual({
      accepted: true,
      environmentId: "here",
      reason: "local-state",
    });
    expect(
      chooseThreadPlacement(
        { ...origin, pinnedEnvironmentId: "idle", requiresOrigin: true },
        candidates,
        now,
      ),
    ).toEqual({ accepted: false, reason: "conflicting-locality" });
  });

  it("places independent work on the eligible host with the most headroom, in any input order", () => {
    const candidates = [host("here", 0.7), host("idle", 0.1), host("busy", 0.5)];
    for (const order of [candidates, [...candidates].reverse()]) {
      expect(chooseThreadPlacement(origin, order, now)).toEqual({
        accepted: true,
        environmentId: "idle",
        reason: "capacity",
      });
    }
  });

  it("never picks a host without an operate link, the project, or the requested model", () => {
    for (const missing of ["operable", "projectAvailable", "modelAvailable"] as const) {
      const decision = chooseThreadPlacement(
        origin,
        [host("here", 0.8), host("idle", 0.01, { [missing]: false })],
        now,
      );
      expect(decision).toEqual({ accepted: true, environmentId: "here", reason: "capacity" });
    }
  });

  it("fails explicitly when no host has fresh, unsaturated resources", () => {
    const candidates = [
      host("stale", 0.1, { receivedAt: now - 15_001 }),
      host("cpu", 0.95),
      host("unknown", null),
      host("ram", 0.1, {
        resources: {
          sampledAt: now,
          cpuUtilization: 0.1,
          cpuCount: 8,
          availableMemoryBytes: 0.05 * 16 * GiB,
          totalMemoryBytes: 16 * GiB,
        },
      }),
      host("absent", 0.1, { resources: null }),
    ];
    expect(chooseThreadPlacement(origin, candidates, now)).toEqual({
      accepted: false,
      reason: "no-eligible-environment",
    });
    expect(chooseThreadPlacement(origin, [], now)).toEqual({
      accepted: false,
      reason: "no-eligible-environment",
    });
  });

  it("refuses evidence that names one environment twice", () => {
    expect(chooseThreadPlacement(origin, [host("a", 0.1), host("a", 0.2)], now)).toEqual({
      accepted: false,
      reason: "ambiguous-environment",
    });
  });
});
