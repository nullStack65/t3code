// @effect-diagnostics nodeBuiltinImport:off - The smoke check reads a built bundle from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Keep aligned with `CONNECT_PAIRING_DISCOVERY_PATH` in packages/contracts. */
export const CONNECT_PAIRING_DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".html", ".json"]);

export function bundleContainsConnectPairingEndpoint(root: string): boolean {
  return collectText(root).some((text) => text.includes(CONNECT_PAIRING_DISCOVERY_PATH));
}

function collectText(root: string): ReadonlyArray<string> {
  const stats = NodeFS.statSync(root, { throwIfNoEntry: false });
  if (!stats) return [];
  if (stats.isFile()) {
    return TEXT_EXTENSIONS.has(NodePath.extname(root)) ? [NodeFS.readFileSync(root, "utf8")] : [];
  }
  const texts: string[] = [];
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    texts.push(...collectText(NodePath.join(root, entry.name)));
  }
  return texts;
}
