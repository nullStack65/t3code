import * as Electron from "electron";
import * as NodeOS from "node:os";

import {
  ISOLATION_ROOT_ENV,
  resolveDesktopIsolationProfile,
  setElectronIsolationPaths,
} from "@t3tools/shared/isolationRoot";

export const isolationProfile = resolveDesktopIsolationProfile({
  argv: process.argv,
  isPackaged: Electron.app.isPackaged,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The synchronous pre-ready bootstrap must reject unsupported OS targets before Effect services can start.
  platform: NodeOS.platform(),
});

if (isolationProfile !== undefined) {
  // This app-owned marker is propagated only to owned child processes. It does
  // not rewrite HOME or CODEX_HOME and is always resolved from our CLI option.
  process.env[ISOLATION_ROOT_ENV] = isolationProfile.root;
  // Electron's session and single-instance storage paths are selected during
  // startup, before the Clerk bridge and BrowserWindow can initialize them.
  setElectronIsolationPaths((name, value) => Electron.app.setPath(name, value), isolationProfile);
}

export const homeDirectory = (): string => isolationProfile?.homeDirectory ?? NodeOS.homedir();
