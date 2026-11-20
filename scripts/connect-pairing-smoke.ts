// @effect-diagnostics nodeBuiltinImport:off - The smoke check reads a built bundle from disk.
// @effect-diagnostics globalConsole:off - This is a one-shot CLI, not an Effect program.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  bundleContainsConnectPairingEndpoint,
  CONNECT_PAIRING_DISCOVERY_PATH,
} from "./lib/connect-pairing-bundle.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : [NodePath.join(repoRoot, "apps/server/dist")];

let missing = false;
for (const root of targets) {
  const resolved = NodePath.resolve(root);
  if (!bundleContainsConnectPairingEndpoint(resolved)) {
    missing = true;
    console.error(
      `Connect pairing endpoint ${CONNECT_PAIRING_DISCOVERY_PATH} is missing from ${resolved}`,
    );
  } else {
    console.log(`Connect pairing endpoint is present in ${resolved}`);
  }
}

if (missing) {
  process.exit(1);
}
