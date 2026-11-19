import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeStagedDesktopUpdate,
  isOfferableStagedUpdate,
  overlayStagedUpdate,
  STAGED_UPDATE_SCHEMA,
  stagedRelaunchCommand,
} from "./stagedUpdate.ts";

const commit = "4f4c0fbb936f12b27d7d97f05dd9b2e0a9732cb1";
const record = {
  schema: STAGED_UPDATE_SCHEMA,
  commit,
  artifact: "/home/user/.local/share/closura/t3-releases/4f4c/T3-Code-0.1.10-x86_64.AppImage",
  sha256: "2580bdd1".padEnd(64, "0"),
  source_ref: "release/native-0.1.10",
  staged_at: "2026-11-19T02:04:00Z",
};

const idle: DesktopUpdateState = {
  enabled: false,
  status: "disabled",
  channel: "latest",
  currentVersion: "0.1.10",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: "Automatic updates are not available.",
  errorContext: null,
  canRetry: false,
};

describe("decodeStagedDesktopUpdate", () => {
  it("accepts a complete record", () => {
    expect(decodeStagedDesktopUpdate(JSON.stringify(record))).toEqual({
      commit,
      artifact: record.artifact,
      sha256: record.sha256,
      sourceRef: record.source_ref,
      stagedAt: record.staged_at,
    });
  });

  it("rejects malformed, foreign, short and relative records", () => {
    expect(decodeStagedDesktopUpdate("{")).toBeNull();
    expect(decodeStagedDesktopUpdate("[]")).toBeNull();
    for (const patch of [
      { schema: "other.v1" },
      { commit: "4f4c0fbb" },
      { commit: commit.toUpperCase() },
      { sha256: "abc" },
      { artifact: "relative/T3.AppImage" },
      { source_ref: "" },
      { staged_at: undefined },
    ]) {
      expect(decodeStagedDesktopUpdate(JSON.stringify({ ...record, ...patch }))).toBeNull();
    }
  });
});

describe("isOfferableStagedUpdate", () => {
  const staged = decodeStagedDesktopUpdate(JSON.stringify(record))!;
  it("offers a different or unknown running build only when the file exists", () => {
    expect(isOfferableStagedUpdate(staged, "0".repeat(40), true)).toBe(true);
    expect(isOfferableStagedUpdate(staged, undefined, true)).toBe(true);
    expect(isOfferableStagedUpdate(staged, commit, true)).toBe(false);
    expect(isOfferableStagedUpdate(staged, undefined, false)).toBe(false);
  });
});

describe("overlayStagedUpdate", () => {
  const staged = decodeStagedDesktopUpdate(JSON.stringify(record))!;
  it("presents the staged build as ready to restart", () => {
    expect(overlayStagedUpdate(idle, staged)).toMatchObject({
      enabled: true,
      status: "downloaded",
      downloadedVersion: "4f4c0fbb",
      message: null,
      stagedBuild: { commit },
    });
    expect(overlayStagedUpdate(idle, null)).toBe(idle);
  });

  it("leaves a real release update in charge of the button", () => {
    for (const status of ["available", "downloading", "downloaded"] as const) {
      const stock = { ...idle, enabled: true, status, downloadedVersion: "0.1.11" };
      expect(overlayStagedUpdate(stock, staged)).toBe(stock);
    }
  });
});

describe("stagedRelaunchCommand", () => {
  const env = {
    HOME: "/home/user",
    APPIMAGE: "/old.AppImage",
    APPDIR: "/tmp/.mount",
    PATH: "/bin",
  };

  it("waits for this process, then runs the AppImage with its switches and a clean launcher env", () => {
    const command = stagedRelaunchCommand({
      platform: "linux",
      pid: 4242,
      artifact: record.artifact,
      switches: ["--ozone-platform=wayland", "t3://ignored"],
      env,
    })!;
    expect(command.command).toBe("/bin/sh");
    expect(command.args.slice(2)).toEqual([
      "t3-staged-relaunch",
      "4242",
      record.artifact,
      "--ozone-platform=wayland",
    ]);
    expect(command.args[1]).toContain('kill -0 "$pid"');
    expect(command.env).toEqual({ HOME: "/home/user", PATH: "/bin" });
  });

  it("opens a new macOS app instance and declines other platforms", () => {
    const mac = stagedRelaunchCommand({
      platform: "darwin",
      pid: 7,
      artifact: "/Users/u/.local/share/closura/t3-releases/4f4c/T3 Code.app",
      switches: [],
      env: {},
    })!;
    expect(mac.args.slice(4)).toEqual([
      "/usr/bin/open",
      "-n",
      "/Users/u/.local/share/closura/t3-releases/4f4c/T3 Code.app",
    ]);
    expect(
      stagedRelaunchCommand({ platform: "win32", pid: 1, artifact: "C:/x", switches: [], env: {} }),
    ).toBeNull();
  });
});
