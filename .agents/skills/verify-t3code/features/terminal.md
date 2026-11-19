# Terminal drawer

A person opens a shell inside the thread's working directory without leaving the app.

## Sub-features

- `terminal.drawer`: the drawer opens with a shell prompt in the project directory, and
  commands typed into it run on the host.

## How to get to it (user POV)

- Header button "Toggle terminal drawer" (`button[aria-label="Toggle terminal drawer"]`).
- Keybinding `terminal.toggle`; split and new-terminal bindings are `terminal.split`,
  `terminal.splitVertical`, `terminal.new` (Settings > Keybindings).
- Not driven: split and new terminals, closing, per-thread terminal persistence.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); a draft or thread for `demo-app`
open.

- Click the toggle → the drawer shows a prompt like
  `primary@primary-asus:~/.cache/verify-t3code/<run>/fixture/demo-app$` (visible in the
  screenshot; the terminal is a canvas, so there is no text in the DOM).
- Type `echo verify-t3code-terminal > $RUN/fixture/terminal-proof-<ts>.txt` and press
  Enter → that file exists on disk with the text (`terminal.drawer`; the script polls
  the file for 30 s).

## Gotchas

- The side effect on disk is the proof; do not rely on `.xterm` selectors (the drawer
  matched none on this build).
- The server needs node-pty's native build (SKILL.md Launch). If the drawer is blank,
  look for `NodePtyModuleLoadError` in `$RUN/dev.log`.
- Focus must be in the drawer for the typed text to reach the shell; opening it focuses
  it.

## Proves it works

The prompt is in the project directory and a command typed there creates a file with the
expected bytes.
