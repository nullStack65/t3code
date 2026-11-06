// @effect-diagnostics nodeBuiltinImport:off -- Filesystem ownership and symlink rejection need native lstat fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  effectiveHomeDirectory,
  IsolationRootError,
  parseIsolationRoot,
  prepareIsolationProfile,
  resolveDesktopIsolationProfile,
  setElectronIsolationPaths,
} from "./isolationRoot.ts";

const scratchRoots: string[] = [];

const makeScratchRoot = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-isolation-root-test-"));
  scratchRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("isolationRoot", () => {
  it("requires exactly one absolute root and rejects malformed selections", () => {
    expect(() => parseIsolationRoot(["--isolation-root"])).toThrow(IsolationRootError);
    expect(() => parseIsolationRoot(["--isolation-root", "relative"])).toThrow(
      "requires an absolute directory path",
    );
    expect(() =>
      parseIsolationRoot(["--isolation-root", "/tmp/a", "--isolation-root=/tmp/b"]),
    ).toThrow("may be supplied only once");
    expect(parseIsolationRoot([], {})).toBeUndefined();
    expect(parseIsolationRoot(["--isolation-root", "/tmp/t3-profile"], {})).toBe("/tmp/t3-profile");
    expect(
      parseIsolationRoot(["--isolation-root", "/tmp/t3-profile"], {
        T3CODE_ISOLATION_ROOT: "/tmp/t3-profile",
      }),
    ).toBe("/tmp/t3-profile");
    expect(() =>
      parseIsolationRoot(["--isolation-root", "/tmp/t3-profile"], {
        T3CODE_ISOLATION_ROOT: "/tmp/other-profile",
      }),
    ).toThrow("does not match the explicit");
  });

  it("routes all desktop and T3 state paths beneath a claimed profile and reuses its marker", () => {
    const parent = makeScratchRoot();
    const profileRoot = NodePath.join(parent, "profile");
    const paths = prepareIsolationProfile(profileRoot, [NodePath.join(parent, "account-home")]);

    expect(paths.homeDirectory).toBe(profileRoot);
    expect(paths.appDataDirectory).toBe(
      NodePath.join(profileRoot, "Library", "Application Support"),
    );
    expect(paths.userDataDirectory).toBe(NodePath.join(profileRoot, "userData"));
    expect(paths.sessionDataDirectory).toBe(NodePath.join(profileRoot, "sessionData"));
    expect(paths.t3Home).toBe(NodePath.join(profileRoot, ".t3"));
    expect(prepareIsolationProfile(profileRoot, [NodePath.join(parent, "account-home")])).toEqual(
      paths,
    );
    const setPathCalls: Array<[string, string]> = [];
    setElectronIsolationPaths((name, value) => setPathCalls.push([name, value]), paths);
    expect(setPathCalls).toEqual([
      ["home", paths.homeDirectory],
      ["appData", paths.appDataDirectory],
      ["userData", paths.userDataDirectory],
      ["sessionData", paths.sessionDataDirectory],
    ]);
  });

  it("rejects a profile that overlaps account home, has unowned files, or traverses a symlink", () => {
    const parent = makeScratchRoot();
    const accountHome = NodePath.join(parent, "account-home");
    NodeFS.mkdirSync(accountHome);
    expect(() =>
      prepareIsolationProfile(NodePath.join(accountHome, "nested"), [accountHome]),
    ).toThrow("separate from the account home");

    const occupied = NodePath.join(parent, "occupied");
    NodeFS.mkdirSync(occupied);
    NodeFS.writeFileSync(NodePath.join(occupied, "settings.json"), "synthetic");
    expect(() => prepareIsolationProfile(occupied, [accountHome])).toThrow("unowned files");

    const realDirectory = NodePath.join(parent, "real");
    NodeFS.mkdirSync(realDirectory);
    const symlinkDirectory = NodePath.join(parent, "linked");
    NodeFS.symlinkSync(realDirectory, symlinkDirectory, "dir");
    expect(() =>
      prepareIsolationProfile(NodePath.join(symlinkDirectory, "profile"), [accountHome]),
    ).toThrow("symbolic links");

    const caseVariantHome = NodePath.join(parent, "BUSINESSACCOUNT");
    expect(() =>
      prepareIsolationProfile(NodePath.join(parent, "businessaccount", "profile"), [
        caseVariantHome,
      ]),
    ).toThrow("separate from the account home");
  });

  it("rejects a symlinked marker before reading its target", () => {
    const parent = makeScratchRoot();
    const root = NodePath.join(parent, "profile");
    NodeFS.mkdirSync(root, { mode: 0o700 });
    const outsideMarker = NodePath.join(parent, "outside-marker.json");
    NodeFS.writeFileSync(outsideMarker, JSON.stringify({ version: 1, root }), { mode: 0o600 });
    NodeFS.symlinkSync(outsideMarker, NodePath.join(root, ".t3code-isolation-profile.json"));

    expect(() => prepareIsolationProfile(root, [NodePath.join(parent, "account-home")])).toThrow(
      "owned by this account and private",
    );
  });

  it("uses the internal root before its fallback without consulting HOME or CODEX_HOME", () => {
    const root = NodePath.join(makeScratchRoot(), "profile");
    prepareIsolationProfile(root, [NodePath.join(NodeOS.tmpdir(), "different-account-home")]);
    expect(
      effectiveHomeDirectory(
        { T3CODE_ISOLATION_ROOT: root, HOME: "/outside/home", CODEX_HOME: "/outside/codex" },
        [],
        "/outside/default",
      ),
    ).toBe(root);
    expect(
      effectiveHomeDirectory({ T3CODE_ISOLATION_ROOT: root, HOME: "/outside/home" }, [
        "desktop",
        "--isolation-root",
        root,
      ]),
    ).toBe(root);
    expect(effectiveHomeDirectory({}, [], "/normal/home")).toBe("/normal/home");
  });

  it("only enables the explicit profile for packaged macOS and rejects an empty internal root", () => {
    expect(() =>
      resolveDesktopIsolationProfile({
        argv: ["--isolation-root", "/tmp/profile"],
        isPackaged: false,
        platform: "darwin",
      }),
    ).toThrow("only supported by packaged macOS builds");
    const parent = makeScratchRoot();
    expect(() =>
      resolveDesktopIsolationProfile({
        argv: ["--isolation-root", NodePath.join(parent, "profile")],
        isPackaged: true,
        platform: "darwin",
        accountHomes: [NodePath.join(parent, "account-home")],
      }),
    ).not.toThrow();
    expect(() => parseIsolationRoot([], { T3CODE_ISOLATION_ROOT: " " })).toThrow("cannot be empty");
  });
});
