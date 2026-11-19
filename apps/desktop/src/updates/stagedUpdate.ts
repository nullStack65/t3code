import type { DesktopUpdateState } from "@t3tools/contracts";

/**
 * A private update channel: a deployment tool stages a complete build on this machine and
 * records it in `~/.local/share/closura/t3-releases/pending.json`. The app offers it as
 * "New version ready. Click to restart." and restarts into it only when the person clicks. It never
 * downloads anything and never restarts on its own.
 */
export const STAGED_UPDATE_SCHEMA = "closura.t3-desktop-pending.v1";
export const STAGED_UPDATE_FILE = "pending.json";
export const STAGED_UPDATE_DIR_SEGMENTS = [".local", "share", "closura", "t3-releases"] as const;

export interface StagedDesktopUpdate {
  readonly commit: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly sourceRef: string;
  readonly stagedAt: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/** Decodes pending.json; anything malformed, relative or unrecognized is not an offer. */
export function decodeStagedDesktopUpdate(text: string): StagedDesktopUpdate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== STAGED_UPDATE_SCHEMA) return null;
  const { commit, artifact, sha256, source_ref: sourceRef, staged_at: stagedAt } = record;
  if (typeof commit !== "string" || !COMMIT.test(commit)) return null;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  if (!nonEmptyString(artifact) || !artifact.startsWith("/")) return null;
  if (!nonEmptyString(sourceRef) || !nonEmptyString(stagedAt)) return null;
  return { commit, artifact, sha256, sourceRef, stagedAt };
}

/** A staged build is offered when its file exists and it is not the build already running. */
export function isOfferableStagedUpdate(
  staged: StagedDesktopUpdate,
  runningCommit: string | undefined,
  artifactExists: boolean,
): boolean {
  return artifactExists && staged.commit !== runningCommit;
}

export function stagedUpdateVersionLabel(staged: StagedDesktopUpdate): string {
  return staged.commit.slice(0, 8);
}

/** The stock updater found, is fetching or holds a real release; that release keeps the button. */
function hasStockUpdate(state: DesktopUpdateState): boolean {
  return (
    state.status === "available" || state.status === "downloading" || state.status === "downloaded"
  );
}

export function stagedUpdateApplies(
  state: DesktopUpdateState,
  staged: StagedDesktopUpdate | null,
): staged is StagedDesktopUpdate {
  return staged !== null && !hasStockUpdate(state);
}

/** Presents a staged build through the existing "downloaded, restart to install" UI. */
export function overlayStagedUpdate(
  state: DesktopUpdateState,
  staged: StagedDesktopUpdate | null,
): DesktopUpdateState {
  if (!stagedUpdateApplies(state, staged)) return state;
  return {
    ...state,
    enabled: true,
    status: "downloaded",
    availableVersion: null,
    downloadedVersion: stagedUpdateVersionLabel(staged),
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
    stagedBuild: { commit: staged.commit },
  };
}

/** Launcher environment the old build set for itself; the staged build sets its own. */
const INHERITED_LAUNCH_VARIABLES = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] as const;

export interface StagedRelaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}

/**
 * A detached shell waits until this process has exited, so the single-instance lock and the
 * bundled server's port are free, then starts the staged build. Linux runs the AppImage with
 * the current switches; macOS opens the staged app bundle.
 */
export function stagedRelaunchCommand(input: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly artifact: string;
  readonly switches: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): StagedRelaunchCommand | null {
  const target =
    input.platform === "linux"
      ? [input.artifact, ...input.switches.filter((value) => value.startsWith("--"))]
      : input.platform === "darwin"
        ? ["/usr/bin/open", "-n", input.artifact]
        : null;
  if (target === null) return null;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (
      value !== undefined &&
      !(INHERITED_LAUNCH_VARIABLES as ReadonlyArray<string>).includes(key)
    ) {
      env[key] = value;
    }
  }
  return {
    command: "/bin/sh",
    args: [
      "-c",
      'pid="$1"; shift; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done; exec "$@"',
      "t3-staged-relaunch",
      String(input.pid),
      ...target,
    ],
    env,
  };
}
