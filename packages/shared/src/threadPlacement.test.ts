import { describe, expect, it } from "vite-plus/test";
import {
  chooseThreadPlacement,
  placementHostLimits,
  type ThreadPlacementCandidate,
} from "./threadPlacement.ts";

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
    loadPerCpu: 0,
    runningAgents: 0,
    placementRole: "headless",
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
          placementRole: "headless",
        },
      }),
      host("queued", 0.1, { resources: { ...host("q", 0.1).resources!, loadPerCpu: 1 } }),
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

  it("fills headless machines first, by run queue and running agents as well as CPU", () => {
    const busy = (id: string, extra: object) =>
      host(id, 0.2, { resources: { ...host(id, 0.2).resources!, ...extra } });
    // A short CPU sample can look idle while 8 runnable tasks per core wait (load 64 on 8 cores).
    expect(
      chooseThreadPlacement(origin, [busy("asus", { loadPerCpu: 8 }), host("r720", 0.6)], now),
    ).toMatchObject({ environmentId: "r720" });
    // Equal machines split by how many agents each already runs.
    expect(
      chooseThreadPlacement(
        origin,
        [busy("three", { runningAgents: 3 }), busy("one", { runningAgents: 1 })],
        now,
      ),
    ).toMatchObject({ environmentId: "one" });
  });

  it("uses a person's computer only when every headless machine is full and they are away", () => {
    const laptop = (extra: object) =>
      host("laptop", 0.05, {
        resources: {
          ...host("laptop", 0.05).resources!,
          placementRole: "interactive",
          humanActive: false,
          ...extra,
        },
      });
    const full = host("r720", 0.96);
    expect(chooseThreadPlacement(origin, [laptop({}), host("r720", 0.8)], now)).toMatchObject({
      environmentId: "r720",
    });
    expect(chooseThreadPlacement(origin, [laptop({}), full], now)).toMatchObject({
      environmentId: "laptop",
    });
    // Present, unsure, an older server that cannot say, or near the person's own headroom: never.
    for (const extra of [
      { humanActive: true },
      { humanActive: undefined },
      { placementRole: undefined, humanActive: undefined },
      { loadPerCpu: undefined },
      { cpuUtilization: 0.5 },
      { loadPerCpu: 0.5 },
      { runningAgents: 2 },
      { availableMemoryBytes: 6 * GiB },
      { availableMemoryBytes: 2.9 * GiB, totalMemoryBytes: 4 * GiB },
    ]) {
      expect(chooseThreadPlacement(origin, [laptop(extra), full], now)).toEqual({
        accepted: false,
        reason: "no-eligible-environment",
      });
    }
  });

  it("never keeps work on the person's own machine when nothing else has room", () => {
    const desk = host("here", 0.3, {
      resources: {
        ...host("here", 0.3).resources!,
        placementRole: "interactive",
        humanActive: true,
      },
    });
    expect(chooseThreadPlacement(origin, [desk, host("r720", 0.97)], now)).toEqual({
      accepted: false,
      reason: "no-eligible-environment",
    });
    expect(chooseThreadPlacement(origin, [desk, host("r720", 0.5)], now)).toMatchObject({
      environmentId: "r720",
    });
    expect(chooseThreadPlacement(origin, [host("here", 0.97), host("r720", 0.97)], now)).toEqual({
      accepted: false,
      reason: "no-eligible-environment",
    });
  });

  describe("with the fleet host order and caps", () => {
    const fleet = [
      { environmentId: "r720", maxLanes: 4, minAvailableMemoryGiB: 4 },
      { environmentId: "asus", maxLanes: 1, minAvailableMemoryGiB: 4 },
      { environmentId: "omarchy", maxLanes: 1, minAvailableMemoryGiB: 4 },
      { environmentId: "laptop", maxLanes: 0, minAvailableMemoryGiB: 4 },
    ];
    const machine = (
      environmentId: string,
      cpuUtilization: number,
      extra: Partial<NonNullable<ThreadPlacementCandidate["resources"]>> = {},
    ) =>
      host(environmentId, cpuUtilization, {
        resources: { ...host(environmentId, cpuUtilization).resources!, ...extra },
        ...placementHostLimits(fleet, environmentId),
      });
    const away = { placementRole: "interactive", humanActive: false } as const;
    const laptopOrigin = { originEnvironmentId: "laptop" };

    it("sends a lane started from the laptop to R720, then ASUS, then the Omarchy desktop", () => {
      const laptop = machine("laptop", 0.01, away);
      expect(
        chooseThreadPlacement(
          laptopOrigin,
          [laptop, machine("omarchy", 0.01, away), machine("asus", 0.01), machine("r720", 0.6)],
          now,
        ),
      ).toEqual({ accepted: true, environmentId: "r720", reason: "capacity" });
      expect(
        chooseThreadPlacement(
          laptopOrigin,
          [
            laptop,
            machine("omarchy", 0.01, away),
            machine("asus", 0.6),
            machine("r720", 0.1, { runningAgents: 4 }),
          ],
          now,
        ),
      ).toMatchObject({ environmentId: "asus" });
      expect(
        chooseThreadPlacement(
          laptopOrigin,
          [
            laptop,
            machine("omarchy", 0.01, away),
            machine("asus", 0.1, { runningAgents: 1 }),
            machine("r720", 0.1, { runningAgents: 4 }),
          ],
          now,
        ),
      ).toMatchObject({ environmentId: "omarchy" });
    });

    it("refuses with no-eligible-environment when every host is at its cap, never the laptop", () => {
      expect(
        chooseThreadPlacement(
          laptopOrigin,
          [
            machine("laptop", 0.01, away),
            machine("omarchy", 0.01, { ...away, runningAgents: 1 }),
            machine("asus", 0.1, { runningAgents: 1 }),
            machine("r720", 0.1, { runningAgents: 4 }),
          ],
          now,
        ),
      ).toEqual({ accepted: false, reason: "no-eligible-environment" });
    });

    it("caps R720 at four lanes and a memory floor, and refuses a host that cannot count its lanes", () => {
      for (const [extra, expected] of [
        [{ runningAgents: 3 }, "r720"],
        [{ runningAgents: 4 }, null],
        [{ runningAgents: 18 }, null],
        [{ runningAgents: 0, availableMemoryBytes: 3.9 * GiB }, null],
        [{ runningAgents: undefined }, null],
      ] as const) {
        const decision = chooseThreadPlacement(origin, [machine("r720", 0.1, extra)], now);
        expect(decision.accepted ? decision.environmentId : null).toBe(expected);
      }
    });

    it("tries unlisted hosts after listed ones, without a cap", () => {
      expect(
        chooseThreadPlacement(origin, [machine("spare", 0.01), machine("asus", 0.5)], now),
      ).toMatchObject({ environmentId: "asus" });
      expect(
        chooseThreadPlacement(
          origin,
          [
            machine("spare", 0.5, { runningAgents: 30 }),
            machine("asus", 0.1, { runningAgents: 1 }),
          ],
          now,
        ),
      ).toMatchObject({ environmentId: "spare" });
    });

    it("still runs laptop-bound work on the laptop", () => {
      expect(
        chooseThreadPlacement(
          { ...laptopOrigin, requiresOrigin: true },
          [machine("laptop", 0.9), machine("r720", 0.1)],
          now,
        ),
      ).toEqual({ accepted: true, environmentId: "laptop", reason: "local-state" });
    });
  });

  it("refuses evidence that names one environment twice", () => {
    expect(chooseThreadPlacement(origin, [host("a", 0.1), host("a", 0.2)], now)).toEqual({
      accepted: false,
      reason: "ambiguous-environment",
    });
  });
});
