// Baked in from T3CODE_BUILD_COMMIT by the desktop build; absent on unstamped builds.
declare const __T3CODE_BUILD_COMMIT__: string | undefined;

export const desktopBuildCommit: string | undefined =
  typeof __T3CODE_BUILD_COMMIT__ === "undefined" || __T3CODE_BUILD_COMMIT__ === ""
    ? undefined
    : __T3CODE_BUILD_COMMIT__;
