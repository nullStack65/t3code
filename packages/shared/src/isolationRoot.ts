// @effect-diagnostics nodeBuiltinImport:off -- Electron requires synchronous profile validation before app readiness and before eager imports.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const ISOLATION_ROOT_ENV = "T3CODE_ISOLATION_ROOT";
const ISOLATION_ROOT_FLAG = "--isolation-root";
const PROFILE_MARKER = ".t3code-isolation-profile.json";
const PROFILE_VERSION = 1;

export class IsolationRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationRootError";
  }
}

export interface IsolationProfilePaths {
  readonly root: string;
  readonly homeDirectory: string;
  readonly appDataDirectory: string;
  readonly userDataDirectory: string;
  readonly sessionDataDirectory: string;
  readonly t3Home: string;
}

export function setElectronIsolationPaths(
  setPath: (name: string, value: string) => void,
  profile: IsolationProfilePaths,
): void {
  setPath("home", profile.homeDirectory);
  setPath("appData", profile.appDataDirectory);
  setPath("userData", profile.userDataDirectory);
  setPath("sessionData", profile.sessionDataDirectory);
}

export function parseIsolationRoot(
  argv: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const argumentValues: Array<string> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === ISOLATION_ROOT_FLAG) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new IsolationRootError(`${ISOLATION_ROOT_FLAG} requires an absolute directory path.`);
      }
      argumentValues.push(value);
      index += 1;
    } else if (argument.startsWith(`${ISOLATION_ROOT_FLAG}=`)) {
      argumentValues.push(argument.slice(ISOLATION_ROOT_FLAG.length + 1));
    }
  }

  const configuredValue = environment[ISOLATION_ROOT_ENV];
  let internalValue: string | undefined;
  if (configuredValue !== undefined) {
    internalValue = configuredValue.trim();
    if (!internalValue) {
      throw new IsolationRootError(`${ISOLATION_ROOT_ENV} cannot be empty.`);
    }
  }
  if (argumentValues.length > 1) {
    throw new IsolationRootError(`${ISOLATION_ROOT_FLAG} may be supplied only once.`);
  }
  const argumentValue = argumentValues[0];
  if (argumentValue !== undefined && internalValue !== undefined) {
    if (
      !NodePath.isAbsolute(argumentValue) ||
      NodePath.normalize(argumentValue) !== NodePath.normalize(internalValue)
    ) {
      throw new IsolationRootError(
        `${ISOLATION_ROOT_ENV} does not match the explicit ${ISOLATION_ROOT_FLAG}.`,
      );
    }
  }
  if (argumentValue === undefined && internalValue === undefined) return undefined;

  const raw = argumentValue ?? internalValue ?? "";
  if (!raw || raw.includes("\0") || !NodePath.isAbsolute(raw)) {
    throw new IsolationRootError(`${ISOLATION_ROOT_FLAG} requires an absolute directory path.`);
  }
  return NodePath.normalize(raw);
}

const overlaps = (left: string, right: string): boolean => {
  // macOS default volumes are case-insensitive. Case-fold on every platform so
  // the same profile selection is safe when validated on a case-sensitive host.
  const relative = NodePath.relative(left.toLowerCase(), right.toLowerCase());
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
};

function assertNoSymlinkComponents(root: string): void {
  const parsed = NodePath.parse(root);
  let current = parsed.root;
  for (const component of root.slice(parsed.root.length).split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, component);
    try {
      if (NodeFS.lstatSync(current).isSymbolicLink()) {
        throw new IsolationRootError("The isolation profile path cannot contain symbolic links.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

function assertOwnedPrivatePath(path: string, directory: boolean): void {
  const stat = NodeFS.lstatSync(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (currentUid !== undefined && stat.uid !== currentUid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new IsolationRootError(
      "The isolation profile must be owned by this account and private.",
    );
  }
}

function claimProfile(root: string, accountHomes: ReadonlyArray<string>): void {
  assertNoSymlinkComponents(root);
  const canonicalRoot = NodePath.resolve(root);
  for (const accountHome of accountHomes) {
    const canonicalHome = NodePath.resolve(accountHome);
    if (overlaps(canonicalRoot, canonicalHome) || overlaps(canonicalHome, canonicalRoot)) {
      throw new IsolationRootError("The isolation profile must be separate from the account home.");
    }
  }

  NodeFS.mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
  assertOwnedPrivatePath(canonicalRoot, true);
  const markerPath = NodePath.join(canonicalRoot, PROFILE_MARKER);
  try {
    assertOwnedPrivatePath(markerPath, false);
    const marker = JSON.parse(NodeFS.readFileSync(markerPath, "utf8")) as {
      readonly version?: unknown;
      readonly root?: unknown;
    };
    if (marker.version !== PROFILE_VERSION || marker.root !== canonicalRoot) {
      throw new IsolationRootError("The isolation profile marker does not match this path.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof IsolationRootError) throw error;
      throw new IsolationRootError("The isolation profile marker is invalid.");
    }
    const entries = NodeFS.readdirSync(canonicalRoot);
    if (entries.length > 0) {
      throw new IsolationRootError("The isolation profile path already contains unowned files.");
    }
    try {
      NodeFS.writeFileSync(
        markerPath,
        `${JSON.stringify({ version: PROFILE_VERSION, root: canonicalRoot })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch {
      throw new IsolationRootError("Could not claim the empty isolation profile directory.");
    }
  }
}

export function assertClaimedIsolationProfile(root: string): void {
  if (!NodePath.isAbsolute(root) || root.includes("\0")) {
    throw new IsolationRootError("The isolation profile path must be absolute.");
  }
  const canonicalRoot = NodePath.resolve(root);
  assertNoSymlinkComponents(canonicalRoot);
  const markerPath = NodePath.join(canonicalRoot, PROFILE_MARKER);
  try {
    assertOwnedPrivatePath(canonicalRoot, true);
    assertOwnedPrivatePath(markerPath, false);
    const marker = JSON.parse(NodeFS.readFileSync(markerPath, "utf8")) as {
      readonly version?: unknown;
      readonly root?: unknown;
    };
    if (marker.version !== PROFILE_VERSION || marker.root !== canonicalRoot) {
      throw new IsolationRootError("The isolation profile marker does not match this path.");
    }
  } catch (error) {
    if (error instanceof IsolationRootError) throw error;
    throw new IsolationRootError("The isolation profile is not claimed by T3 Code.");
  }
  for (const directory of [
    "Library",
    NodePath.join("Library", "Application Support"),
    "userData",
    "sessionData",
    ".t3",
  ]) {
    const path = NodePath.join(canonicalRoot, directory);
    assertNoSymlinkComponents(path);
    assertOwnedPrivatePath(path, true);
  }
}

export function isolationRootFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const root = parseIsolationRoot([], environment);
  if (root !== undefined) assertClaimedIsolationProfile(root);
  return root;
}

export const isIsolationProfileActive = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean => isolationRootFromEnvironment(environment) !== undefined;

export function resolveDesktopIsolationProfile(input: {
  readonly argv: ReadonlyArray<string>;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly accountHomes?: ReadonlyArray<string>;
}): IsolationProfilePaths | undefined {
  const root = parseIsolationRoot(input.argv, {});
  if (root === undefined) return undefined;
  if (!input.isPackaged || input.platform !== "darwin") {
    throw new IsolationRootError("--isolation-root is only supported by packaged macOS builds.");
  }
  return prepareIsolationProfile(root, input.accountHomes);
}

export function prepareIsolationProfile(
  root: string,
  accountHomes: ReadonlyArray<string> = [NodeOS.homedir(), NodeOS.userInfo().homedir],
): IsolationProfilePaths {
  if (!NodePath.isAbsolute(root) || root.includes("\0")) {
    throw new IsolationRootError("The isolation profile path must be absolute.");
  }
  const canonicalRoot = NodePath.resolve(root);
  claimProfile(canonicalRoot, accountHomes);

  const profile: IsolationProfilePaths = {
    root: canonicalRoot,
    homeDirectory: canonicalRoot,
    appDataDirectory: NodePath.join(canonicalRoot, "Library", "Application Support"),
    userDataDirectory: NodePath.join(canonicalRoot, "userData"),
    sessionDataDirectory: NodePath.join(canonicalRoot, "sessionData"),
    t3Home: NodePath.join(canonicalRoot, ".t3"),
  };
  for (const directory of [
    profile.appDataDirectory,
    profile.userDataDirectory,
    profile.sessionDataDirectory,
    profile.t3Home,
  ]) {
    assertNoSymlinkComponents(directory);
    NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(directory);
  }
  return profile;
}

export function effectiveHomeDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  argv: ReadonlyArray<string> = process.argv,
  fallback?: string,
): string {
  const root = parseIsolationRoot(argv, environment);
  if (root === undefined) return fallback ?? NodeOS.homedir();
  if (environment[ISOLATION_ROOT_ENV] !== undefined) assertClaimedIsolationProfile(root);
  return root;
}
