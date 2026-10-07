/**
 * Names of the WSL runtime archive and its digest sidecar embedded in desktop
 * resources. Keep these in the shared scripts/lib surface so build and
 * provenance inspection tools can use the same contract without importing the
 * full desktop build command graph.
 */
export const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
export const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
