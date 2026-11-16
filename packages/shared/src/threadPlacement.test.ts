import { describe, expect, it } from "vite-plus/test";
import { chooseThreadPlacement, type ThreadPlacementCandidate } from "./threadPlacement.ts";
const now = 1_000_000;
const candidate = (environmentId: string, weight = 1): ThreadPlacementCandidate => ({
  environmentId,
  weight,
  receivedAt: now,
  resources: {
    sampledAt: now,
    cpuCount: 8,
    cpuUtilization: 0.2,
    totalMemoryBytes: 1000,
    availableMemoryBytes: 500,
  },
  online: true,
  protocolCompatible: true,
  operateGranted: true,
  audienceGranted: true,
  runtimeModeGranted: true,
  projectAvailable: true,
  providerAvailable: true,
  modelAvailable: true,
  hostedToolsAvailable: true,
  contextCompatible: true,
});
const request = { originEnvironmentId: "crown", requiresLocalState: false };
const fleet = [
  candidate("crown"),
  candidate("asus", 3),
  candidate("r720", 4),
  candidate("desktop", 2),
  candidate("air"),
];
describe("shared native placement policy", () => {
  it("uses the native capacity selector across five eligible hosts", () => {
    expect(chooseThreadPlacement(request, fleet, now)).toEqual({
      accepted: true,
      environmentId: "r720",
      reason: "capacity",
    });
    expect(chooseThreadPlacement(request, [...fleet.slice(2), ...fleet.slice(0, 2)], now)).toEqual(
      chooseThreadPlacement(request, fleet, now),
    );
  });
  it.each([
    "online",
    "protocolCompatible",
    "operateGranted",
    "audienceGranted",
    "runtimeModeGranted",
    "projectAvailable",
    "providerAvailable",
    "modelAvailable",
    "contextCompatible",
  ] as const)("refuses %s=false without silent local fallback", (gate) => {
    expect(
      chooseThreadPlacement(request, [{ ...candidate("r720"), [gate]: false }], now).accepted,
    ).toBe(false);
  });
  it("pins existing threads, explicit hosts and local child state", () => {
    expect(
      chooseThreadPlacement({ ...request, existingThreadEnvironmentId: "air" }, fleet, now),
    ).toMatchObject({ environmentId: "air", reason: "existing" });
    expect(
      chooseThreadPlacement({ ...request, pinnedEnvironmentId: "desktop" }, fleet, now),
    ).toMatchObject({ environmentId: "desktop", reason: "pinned" });
    expect(
      chooseThreadPlacement({ ...request, requiresLocalState: true }, fleet, now),
    ).toMatchObject({ environmentId: "crown", reason: "locality" });
    expect(
      chooseThreadPlacement(
        { ...request, requiresLocalState: true, pinnedEnvironmentId: "r720" },
        fleet,
        now,
      ),
    ).toEqual({ accepted: false, reason: "conflicting-locality" });
  });
  it("fails closed on overload, missing/stale metrics and invalid telemetry", () => {
    const base = candidate("r720");
    for (const resources of [
      null,
      { ...base.resources!, cpuUtilization: 0.95 },
      { ...base.resources!, availableMemoryBytes: 50 },
      { ...base.resources!, cpuCount: NaN },
      { ...base.resources!, availableMemoryBytes: Infinity },
    ]) {
      expect(chooseThreadPlacement(request, [{ ...base, resources }], now).accepted).toBe(false);
    }
    expect(
      chooseThreadPlacement(request, [{ ...base, receivedAt: now - 15_001 }], now).accepted,
    ).toBe(false);
    expect(
      chooseThreadPlacement(request, [{ ...base, receivedAt: now + 5_001 }], now).accepted,
    ).toBe(false);
    expect(chooseThreadPlacement(request, [base, base], now)).toEqual({
      accepted: false,
      reason: "ambiguous-environment",
    });
  });
  it("keeps dependent children at the parent and checks hosted tool capability", () => {
    expect(
      chooseThreadPlacement({ ...request, parentEnvironmentId: "asus" }, fleet, now),
    ).toMatchObject({ accepted: true, environmentId: "asus", reason: "locality" });
    expect(
      chooseThreadPlacement(
        { ...request, parentEnvironmentId: "asus", independentTask: true },
        fleet,
        now,
      ),
    ).toMatchObject({ accepted: true, environmentId: "r720" });
    expect(
      chooseThreadPlacement(
        { ...request, parentEnvironmentId: "asus", pinnedEnvironmentId: "r720" },
        fleet,
        now,
      ).accepted,
    ).toBe(false);
    expect(
      chooseThreadPlacement(
        { ...request, requiresHostedTools: true },
        [{ ...candidate("r720"), hostedToolsAvailable: false }],
        now,
      ).accepted,
    ).toBe(false);
  });
});
