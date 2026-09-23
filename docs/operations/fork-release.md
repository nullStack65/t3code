# Fork release procedure

> For maintainers of the `nullStack65/t3code` fork. Upstream release docs live in
> [release.md](./release.md) and do not apply here.

This fork ships its own desktop and CLI artifacts from its own GitHub Releases.
It deliberately does not use `.github/workflows/release.yml`: that workflow
requires upstream's Blacksmith runners, the production relay/Clerk/Cloudflare/
Vercel credentials, and publishes upstream npm packages. The fork entry point is
`.github/workflows/fork-release.yml`, which reuses the existing packaging scripts
and `release-desktop.yml`.

## Runners

Runner capacity is an explicit, authorized input. `fork-release.yml` has no
default runner label: the operator must pass `linux_runner`, `windows_runner`,
and `macos_x64_runner`, and every label must appear in the repository variable
`T3CODE_AUTHORIZED_RUNNERS` or preflight fails closed. This prevents a workflow
dispatch from silently landing on GitHub-hosted or paid capacity that was never
authorized.

- No self-hosted label is guessed.
- No personal machine is registered to run public-PR jobs.
- No hosted/paid fallback is added silently.

When no authorized CI runner is available, build the candidate on the already
authorized Windows/WSL and Intel macOS machines with the same scripts:

```sh
# Linux x64 runtime archive + resource monitor, inside the WSL distro:
node scripts/build-fork-candidate.ts --target linux --version 0.0.43 --sha <full-sha>

# Windows x64 installer (embeds the Linux archive), on Windows:
node scripts/build-fork-candidate.ts --target win --version 0.0.43 --sha <full-sha> \
  --linux-archive candidate/t3-0.0.43-linux-x64.tar.gz

# Intel macOS DMG, on the Intel Mac:
node scripts/build-fork-candidate.ts --target mac --version 0.0.43 --sha <full-sha>
```

`build-fork-candidate.ts` prints the plan by default and runs it with
`--execute`. It verifies the checked-out HEAD equals the requested source, runs
the same `build-cli-archive.ts`/`build-desktop-artifact.ts`/`smoke-cli-archive.ts`
steps, and freezes the candidate with the same `verify-fork-candidate.ts` the
workflow uses. It never invents a native acceptance receipt.

Apple Silicon macOS is built only when `include_macos_arm64` is set and an
authorized `macos_arm64_runner` is supplied; it is reported untested.

## Versioning

Fork releases are plain `X.Y.Z` and are strictly increasing. The fork version is
the fork's own line, independent of the upstream base version it was built from;
`upstream_base` is recorded in the release notes only. The workflow validates the
requested version with `scripts/fork-release-version.ts`:

```sh
# Next version above upstream base 0.0.42 and the existing 0.0.43.
node scripts/fork-release-version.ts --upstream-base 0.0.42 --existing 0.0.43

# Reject anything that is not newer, or that carries a prerelease identifier.
node scripts/fork-release-version.ts --upstream-base 0.0.42 --version 0.0.43-preview.20260923.1
```

Rules:

- Preview and nightly identifiers are rejected. A fork preview is a manual
  download and must never be discoverable as an update.
- The version must be newer than the upstream base it was built from and newer
  than every existing fork release, so an update can never move backwards and
  never lands on a version number an upstream build also uses.
- SemVer build metadata is never used for ordering: `0.0.43+fork.1` is rejected.

## Release procedure

1. Pick the immutable source SHA on `main` and the upstream base version.
2. Run **Fork release** (`workflow_dispatch`) with `sha`, `version`,
   `upstream_base`, and the authorized runner labels. Leave `publish` off to
   build a candidate.
3. Preflight checks out that explicit SHA (never `FETCH_HEAD`), asserts
   `HEAD == sha`, and asserts the SHA is an ancestor of `origin/main` with
   `scripts/select-release-source.ts`.
4. The workflow builds the JS bundle once, then packages:
   - `T3-Code-<version>-x64.exe` (NSIS) with the matching
     `t3-<version>-linux-x64.tar.gz` embedded as its WSL runtime;
   - `T3-Code-<version>-x64.dmg` (Intel macOS, unsigned unless Apple secrets
     exist);
   - `t3-<version>-linux-x64.tar.gz` (self-contained Linux runtime archive);
   - `t3-<version>-win32-x64.zip` (self-contained Windows CLI archive).
5. `qualify` drops updater manifests, checks the required asset set, verifies
   the Linux archive provenance, verifies the embedded WSL runtime equals the
   standalone archive, and freezes `fork-release-candidate` with
   `fork-release-manifest.json` and `SHA256SUMS` written from the exact
   distributed bytes.
6. Native acceptance on real Windows/WSL and Intel macOS hardware. The accepted
   bytes are recorded as `fork-native-receipts.json` and uploaded as the
   `fork-release-native-receipts` artifact on the same run. A changed/rebuilt
   asset invalidates its previous receipt.
7. Re-run with `publish: true` and `candidate_run_id` set to the qualifying
   run. Promotion downloads that immutable artifact, verifies the manifest,
   checksums, receipts, tag target, no-overwrite, version ordering, and the
   authorization gate, then creates the release. It never rebuilds.

Queued CI is not a passed release gate; a release is only qualified when the
candidate artifact set exists and native smoke tests pass.

## Provenance and checksums

Every artifact embeds the repository, full source SHA, version, architecture,
and the workflow revision separately:

- Desktop: `apps/desktop` staged `package.json` fields
  (`t3codeSourceRepository`, `t3codeSourceSha`, `t3codeWorkflowRevision`,
  `t3codeBuildVersion`, `t3codeBuildArch`) plus a readable
  `t3code-build-info.json` in the packaged app.
- CLI archive: a readable `t3code-build-info.json` at the archive root.

Release builds set `T3CODE_RELEASE_BUILD=1` and `T3CODE_SOURCE_SHA=<selected
sha>`. In that mode the actual checkout is authoritative: an explicit
`T3CODE_SOURCE_SHA` that disagrees with `HEAD` fails the build, and `GITHUB_SHA`
(the workflow-dispatch revision) is recorded only as `workflowRevision`. A
manual dispatch that builds an older selected SHA therefore cannot mislabel the
payload with the dispatch commit.

`SHA256SUMS` is generated by `qualify` from the bytes that are actually
distributed, after updater manifests are dropped. The Windows installer's
embedded WSL payload is verified against the standalone archive (byte-identical
plus matching source/version/architecture) by `scripts/verify-windows-installer.ts`
using 7-Zip. Native helpers are rebuilt from the selected source; they are never
copied from an installed app.

## Update isolation

No fork install or update path may select an upstream `pingdotgg` release:

- `packages/shared/src/cliRelease.ts` defaults the release repository to
  `nullStack65/t3code` for both the download base URL and the release-index
  lookup that `t3 update` and the install scripts use. `T3CODE_RELEASE_REPOSITORY`
  overrides it; `T3CODE_RELEASE_BASE_URL` still overrides only the download
  origin for mirrors.
- `scripts/install.sh` and `scripts/install.ps1` default to the fork and honor
  `T3CODE_RELEASE_REPOSITORY`. Both check the release's `SHA256SUMS` for the
  requested archive and fail with a clear message for an unsupported
  platform/architecture before attempting a download.
- Desktop `app-update.yml` is derived from `T3CODE_DESKTOP_UPDATE_REPOSITORY`
  or `GITHUB_REPOSITORY`, which is the fork in this repository.

The fork release attaches `linux-x64` and `win32-x64` self-contained archives.
Other platform keys are rejected clearly by the installers and `t3 update`
rather than producing a predictable missing-asset error.

## Signing and updates

Three distinct support levels:

- **Unsigned manual install** (always buildable): Windows and macOS artifacts
  are produced without credentials. On macOS this means the app is not
  notarized and the user opens it once via Gatekeeper's Open action.
- **Signed/notarized** (only when Apple/Azure secrets exist): the existing
  auto-detect path in `release-desktop.yml` is reused.
- **In-app desktop update**: not advertised for the first release. No updater
  manifest (`latest.yml`) is attached. Windows automatic update is enabled only
  after an N -> N+1 update acceptance test passes with the real
  publisher/signature configuration intact; until then installs update by
  downloading the new artifact. An unsigned macOS build cannot complete a
  Squirrel.Mac update at all.

No signing credentials are provisioned or purchased by this workflow.

## Migrating existing installs

Installs that were built without a feed (today's local `0.0.42` builds) do not
self-migrate. Install the first release-managed build explicitly by downloading
the installer or archive from the fork release and running it over the existing
install; user data, credentials, pairings, projects, and databases are
preserved because `appId`, product name, and user-data paths are unchanged.

Recovery note: an older binary is not automatically a safe database rollback.
If a release adds a database migration, restore a pre-upgrade snapshot rather
than only reinstalling the older binary.

### Windows package-manager identity

The fork installer keeps the upstream `appId` (`com.t3tools.t3code`) and the
Winget ARP entry `T3Tools.T3Code`, so an existing Winget install is upgraded in
place and its user data is preserved. A normal Winget pin (`winget pin add --id
T3Tools.T3Code`, pin type `Pinning`) does **not** block an explicit
`winget upgrade T3Tools.T3Code`, and `--include-pinned` bypasses it entirely. To
retain the upstream package identity while preventing package-manager
replacement, use a blocking pin (`winget pin add --blocking --id
T3Tools.T3Code`) or remove the Winget package. Document that removing the pin is
deliberate, not accidental.

## Prerequisites

For users (not build tooling):

- Windows: x64, WSL 2 with a distro selected in **Settings → Connections** for
  the WSL backend. Provider CLIs are installed inside the distro.
- Intel macOS: macOS with the x64 build. Unsigned builds need a one-time
  Gatekeeper approval.
- Linux: x64 with `sh`, `tar`, and `sha256sum` or `shasum`; the runtime archive
  needs no Node, npm, or compiler.

Building locally needs Node (per `engines.node`), `vp`, and Rust only when the
native helpers are rebuilt. The release workflow installs all of these. The
Intel macOS native `node-pty` build requires Homebrew LLVM 20 with an explicit
`-isysroot` on `CFLAGS`, `CXXFLAGS`, and `LDFLAGS` (Apple clang 12 rejects
`-std=gnu++20`, and Homebrew LLVM links against a default sysroot that does not
exist on a Command Line Tools-only host).

## Known limitations

- Apple Silicon macOS is available but untested by default.
- Intel macOS has no `t3` CLI archive: Node single-executables are unsupported
  on x64 macOS.
- Automatic desktop update is not enabled for the first release; installs update
  by downloading the new artifact.
- The fork still points at the public upstream T3 Connect relay/Clerk
  identifiers by default, so pairing state survives upgrades; override with
  repository variables to disable cloud features.
