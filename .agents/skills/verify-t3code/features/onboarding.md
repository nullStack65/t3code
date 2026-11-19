# First-run setup wizard

A person opening T3 Code for the first time lands on a three-step dialog, "Set up T3
Code": Connect, Agents, Projects. When they finish it they are in a new-thread draft
and the sidebar is usable.

## Sub-features

- `onboarding.connect`: step 1 lists the local computer as connected and checked.
- `onboarding.agents`: step 2 lists the agents found on that computer with their state.
- `onboarding.projects-skip`: "Do not import projects" ends the wizard without importing.

## How to get to it (user POV)

- Pair a fresh browser with a new instance: the app redirects to `/welcome`.
- No other entry point was found; once finished it does not come back on its own.

## Driving it with `browser.mjs` (headless Chromium over CDP)

Preconditions: baseline from [README.md](README.md); a fresh `$RUN` (state is per
`--home-dir`).

- Wait for the dialog heading "Set up T3 Code" → URL is `/welcome`, the Connect
  checkbox reads "primary-asus Connected http://localhost:<web port>/".
- Click "Continue" → heading "Your agents" with Claude Code "Authenticated Ready" and
  Codex "Available Ready" (the host's real CLIs; only a status probe runs).
- Click "Continue" → heading "Your projects", text "Looking for projects from Claude
  Code and Codex…" and a "Do not import projects" button.
- Click "Do not import projects" → URL becomes `/draft/<id>` and the sidebar shows
  "New project" and "New thread". `seed.mjs` does all of this and logs
  `onboarding.connect`, `onboarding.agents` and `onboarding.projects-skip`, each asserting
  its end state.

## Gotchas

- The Projects step offers to import projects from the host's Claude Code and Codex
  session history and shows "Looking for projects…" the moment it opens. Click "Do not
  import projects" at once: a verify run must not read a person's transcripts. Whether a
  scan has already started by then is unverified.
- The dev runner auto-bootstraps a project from its working directory, so the wizard
  ends in a draft for a project named `server` (this checkout's `apps/server`). Do not
  send a turn there.
- First load is slow in dev mode (compiling hundreds of modules); wait for the dialog,
  do not reload. `page.goto` uses `waitUntil: "commit"` for this reason.

## Proves it works

After the third click the URL is `/draft/<id>`, the sidebar has "New project" and a
draft for `server`, and no wizard dialog is on screen.
