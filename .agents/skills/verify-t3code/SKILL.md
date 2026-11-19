---
name: verify-t3code
description: Drive a real, isolated T3 Code web build (server + web UI) the way a user does and prove each feature by what the user sees. Use before calling a user-facing change to the sidebar, threads, projects, settings, search, usage or connections done, when a bug got past the tests, or when adding a feature that has no feature file yet.
---

# Verify T3 Code

Run an isolated copy of this checkout, drive the web UI as a user would, and record
the end state each feature must reach. It is written for an agent that has not seen
T3 Code before and is reading it mid-task. For the in-app Browser panel route and
fixture seeding, see [test-t3-app](../test-t3-app/SKILL.md); this skill adds the
feature map, a mock provider and a scripted drive that works headless on ASUS.

## Rules that keep the live server safe

This host runs the T3 server that hosts your own thread. Read the "three ways to hurt
yourself" in [AGENTS.md](../../../AGENTS.md) first.

- Never use `~/.t3`, never pass the live port, never stop a process you did not start.
- Your shell inherits `T3CODE_TAILSCALE_SERVE=1`, `T3CODE_PORT` and `T3CODE_HOME` from
  the parent T3 session. A dev server that inherits them replaces the live server's
  `tailscale serve` mapping on `:443`, then removes it on exit, which cuts remote access.
  `launch.sh` scrubs every `T3CODE_*` variable and sets `T3CODE_TAILSCALE_SERVE=0`;
  Doctor fails if the instance configured a mapping. Do not launch with a bare
  `vp run dev`.
- Heavy builds and browsers run on ASUS, never on the 8 GB laptop. Siblings run builds
  on the same host: keep yours sequential, and expect load averages of 20 to 90.

## Launch

Prerequisites on ASUS (once per worktree):

```bash
pnpm install --frozen-lockfile --ignore-scripts      # vp is not installed on ASUS; pnpm is
# --ignore-scripts skips node-pty's native build; the server will not start without it:
cd node_modules/.pnpm/node-pty@*/node_modules/node-pty && PATH=~/.cache/ship-live-node/bin:$PATH npx --yes node-gyp rebuild
```

Put the worktree on the home disk (`~/.t3/worktrees/t3code/<name>`), not `/tmp`: `/tmp`
is a 15 GB tmpfs shared with other sessions and the install fails with `-122` there.
The dev runner needs Node 24 or newer to run TypeScript; `/usr/bin/node` is 22.
`launch.sh` picks `$T3_VERIFY_NODE`, then `node` on PATH, then `~/.cache/ship-live-node/bin/node`.

One command does the whole run (launch, browser, readiness wait, Doctor, seed, drive):

```bash
.agents/skills/verify-t3code/scripts/run-all.sh ~/.cache/verify-t3code/<run-name>
```

Or step by step (RUN is the directory `launch.sh` prints):

```bash
S=.agents/skills/verify-t3code/scripts
RUN=$($S/launch.sh ~/.cache/verify-t3code/<run-name>)   # isolated home, random server port, web port from the worktree path
export PATH=~/.cache/ship-live-node/bin:$PATH
node $S/browser.mjs up $RUN                             # headless Chromium on a loopback DevTools port, paired
$S/doctor.sh $RUN
node $S/seed.mjs $RUN                                   # wizard, fixture project, first message
```

`launch.sh` also builds, inside RUN: `bin/cursor-agent` (a fake that answers `about` and
runs the repo's own `apps/server/scripts/acp-mock-agent.ts` for `acp`, so turns work with
no live provider and no spend), `fixture/demo-app` (a one-commit git repo), and
`home/userdata/settings.json` enabling that Cursor provider. The instance is usable when
the dev log has `pairingUrl:`, `/.well-known/t3/environment` returns a `serverVersion`,
and the browser reaches `/welcome`. First load compiles hundreds of modules: on a busy
host it takes 1 to 3 minutes, so wait for UI instead of retrying.

## Doctor

```bash
$S/doctor.sh $RUN
```

Read-only. Fails unless: the recorded dev runner pid is alive and its command line has
`--home-dir $RUN/home`; each of the two ports is listened to by a descendant of that
runner; `/.well-known/t3/environment` answers with `serverVersion`; the web port serves
the app shell; and the dev log never printed `Tailscale Serve configured`. It also prints
the head SHA, dirty-file count, `tailscale serve status` and host load.

## Drive

Order of preference: API/CLI, then the accessibility tree through the DevTools port, then
screenshots.

- CLI/API: `node apps/server/src/bin.ts pair --base-dir $RUN/home` mints a pairing token
  for the instance; `/.well-known/t3/environment` is the readiness route; auth state is in
  `$RUN/home/userdata` (read it with `apps/server/scripts/t3-sqlite-state.ts query`, never
  write while the server runs).
- Browser: `scripts/browser.mjs` exports `connect(RUN)`, which attaches playwright-core
  (already in the repo's pnpm store) to the headless Chromium it started, with a
  throwaway profile in `$RUN/profile`. Never drive a person's browser profile or desktop.
  A script gets `{ page, shot(name), note(line), detach() }`.
- Drive scripts: `seed.mjs`, `drive-threads.mjs`, `drive-surfaces.mjs` each append
  `<sub-feature id>: <action> -> <observed end state>` to `$RUN/evidence/observed.log` and
  screenshot every step. A step that throws is logged as `FAIL` and the next step runs.

Stable handles (verified against this head):

| What | Handle |
| --- | --- |
| Thread row | `[data-testid="sidebar-row-card"]` (slim: `sidebar-row-slim`); right-click opens its menu |
| Row menu items | text: `Pin thread`, `Settle thread`, `Snooze` > `In 1 hour`…, `Rename thread`, `Regenerate title`, `Mark unread`, `Filter by <project>`, `Copy`, `Project settings`, `Archive thread`, `Delete` |
| Pinned / unpin | `button[aria-label="Unpin thread"]` (or `[aria-label="Pinned"]` while dragging) |
| Settled / snoozed shelves | `[data-testid="sidebar-settled-shelf-toggle"]`, `[data-testid="sidebar-snoozed-shelf-toggle"]` |
| Wake | `[aria-label="Wake thread now"]` |
| Thread title in header | `button[aria-label^="Thread actions for"]` |
| New thread / new project | `[data-testid="new-thread-button"]` / `button[aria-label="New project"]` |
| Command palette | `Control+K`; `[data-testid="command-palette"]`, results are `[role="option"]` |
| Composer | `[data-testid="composer-editor"]`, button `Send message` |
| Settings | footer gear, then a button per section: General, Appearance, Keybindings, SnapShots, Providers, Integrations, Source Control, Storage, Connections, Archive, and Back |
| Terminal | `button[aria-label="Toggle terminal drawer"]` |

`getByRole(..., { name })` with a regex can stall for a minute on a saturated host; prefer
the CSS handles above and give clicks 45 s.

## Evidence

Everything lands in `$RUN/evidence/`: `observed.log` (one line per claim), one PNG per
step, and `dev.log` / `browser.log` in `$RUN`. Each claim needs the head SHA
(`git rev-parse HEAD`), the sub-feature ID, the action and the observed end state, as in
[features/README.md](features/README.md). Copy the evidence folder out before Cleanup if
it must outlive `$RUN`: Cleanup keeps `evidence/` but deletes the rest.

## Cleanup

```bash
$S/cleanup.sh $RUN
```

Stops only what this run started: the browser by the PID in `$RUN/browser.env` (only while
its command line still has `--user-data-dir=$RUN/profile`) and the dev runner with its
descendants by the PID in `instance.env` (only while its command line is still our dev
runner). It never matches by process name. It then deletes `home/`, `profile/` and the env
files and keeps `evidence/`. Afterwards confirm `tailscale serve status` still shows the
live mapping and that no process mentions `$RUN`.

## Features

The map is in [features/README.md](features/README.md). Run the matching feature file
before calling a user-facing change done, and update that feature file in the same PR.
