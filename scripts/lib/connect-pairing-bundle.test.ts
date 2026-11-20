// @effect-diagnostics nodeBuiltinImport:off - The smoke check reads a built bundle from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  bundleContainsConnectPairingEndpoint,
  CONNECT_PAIRING_DISCOVERY_PATH,
} from "./connect-pairing-bundle.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeBundle(files: Readonly<Record<string, string>>): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-connect-pairing-"));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    const file = NodePath.join(directory, name);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, contents);
  }
  return directory;
}

describe("Connect pairing bundle smoke", () => {
  it("finds the discovery endpoint in a built bundle and rejects a bundle without it", () => {
    const present = makeBundle({
      "dist/bin.mjs": `const path = ${JSON.stringify(CONNECT_PAIRING_DISCOVERY_PATH)};`,
    });
    const absent = makeBundle({
      "dist/bin.mjs": 'const path = "/.well-known/t3/environment";',
    });

    expect(bundleContainsConnectPairingEndpoint(present)).toBe(true);
    expect(bundleContainsConnectPairingEndpoint(absent)).toBe(false);
    expect(bundleContainsConnectPairingEndpoint(NodePath.join(absent, "missing"))).toBe(false);
  });
});
