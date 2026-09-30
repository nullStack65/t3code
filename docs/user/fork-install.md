# Install the fork build of T3 Code

> This page is for the `nullStack65/t3code` fork. Official T3 Code installs and
> updates come from `pingdotgg/t3code`; see [install.md](./install.md) for those.

Fork builds are published on the fork's
[GitHub Releases](https://github.com/nullStack65/t3code/releases). Download the
artifact for your platform and install it; nothing here needs Node, npm, or a
compiler.

## Windows x64

1. Download `T3-Code-<version>-x64.exe` and run it. It installs per user and
   upgrades an existing T3 Code install in place.
2. For the WSL backend, install WSL 2 and a distro, then pick it in
   **Settings → Connections**. The installer already contains the matching
   Linux runtime, so no separate download is needed.
3. The fork also publishes `t3-<version>-win32-x64.zip`, a self-contained
   Windows CLI archive for `t3` outside the desktop app.

## Intel macOS

1. Download `T3-Code-<version>-x64.dmg` and copy the app to Applications.
2. The fork build is unsigned unless the maintainers signed it. If macOS
   refuses to open it, right-click the app and choose **Open** once.
3. macOS has no fork `t3` CLI archive; run the desktop app, or build the server
   from source.

## Linux x64

Download the self-contained runtime archive and extract it, or install with the
fork installer:

```sh
curl -fsSL https://raw.githubusercontent.com/nullStack65/t3code/main/scripts/install.sh | sh
```

This puts `t3` in `~/.local/bin`. Set `T3CODE_CHANNEL=nightly` only if you know
why; fork releases are plain stable versions. `T3CODE_RELEASE_REPOSITORY` and
`T3CODE_RELEASE_BASE_URL` exist for mirrors.

## Updating

Download the newer artifact and install it over the existing one. Your settings,
sign-in, pairings, projects, and databases are preserved.

- Fork releases do not enable automatic desktop updates yet; install the new
  Windows or macOS artifact by hand.
- On Linux, `t3 update` and the installer download the newer fork archive.
- Intel macOS updates by downloading the new DMG; in-app macOS updates are not
  supported for unsigned fork builds.

The fork publishes `linux-x64` and `win32-x64` CLI archives. Other
platform/architecture combinations fail with a clear message instead of
downloading a missing asset.

If you are coming from a build that had no update feed, this first
release-managed install is the migration: install it once by hand, and later
updates can follow the fork release channel.
