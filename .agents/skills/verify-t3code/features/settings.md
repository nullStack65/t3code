# Settings

Settings has its own sidebar of sections. A person changes how new threads, the
interface, shortcuts, providers, storage and source control behave.

## Sub-features

- `settings.general`: new-thread defaults (model, effort, permissions, workspace),
  notifications, send shortcut, follow-up behavior, diff layout.
- `settings.appearance`: color scheme (System, Light, Dark), themes (T3 Code, T3 Chat,
  Grove, Ocean, Ember, Iris), contrast.
- `settings.keybindings`: "62 bindings" with their keys and `When` conditions, a
  warning that the browser may claim some shortcuts.
- `settings.providers`: provider list with version and state (Codex, Claude, and the
  mock Cursor).
- `settings.storage`: worktree cleanup rules.
- `settings.source-control`: automatic pull, default merge method, repositories.
- `settings.integrations`: agent browser access and browser profiles (desktop only).

Archive is in [archive.md](archive.md) and Connections in
[connections.md](connections.md). The nav also has SnapShots, not driven.

## How to get to it (user POV)

- Footer gear in the thread sidebar, then a button per section.
- The command palette finds settings and keybindings by name.
- URLs `/settings/general`, `/appearance`, `/keybindings`, `/providers`, `/storage`,
  `/source-control`, `/integrations`, `/connections`, `/archived`, `/snap-shot`,
  `/projects`, `/diagnostics`, `/open-source-licenses`.
- "Back" leaves Settings.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md).

- Click the gear, then each section button → the URL is `/settings/<slug>` and the main
  text starts with `Settings / <Section> / All environments / All projects` (General,
  Providers, Keybindings, Storage and Source Control) or `Settings / <Section>`
  (Appearance, Connections), followed by the section's content. The log line for each
  carries the first 220 characters (`settings.<slug>`).
- Providers must list `Codex v…` and `Claude v…` with a state (`Available`) and "Checked
  <n> ago".

## Gotchas

- Lazy routes: right after the click the header and URL already say Providers while the
  body is still the previous page (Keybindings). Wait for the body, not the URL. A 1.5 s
  read recorded exactly that once; 8 s later it was correct.
- Changing a setting was not driven (no Save flow was exercised); these steps only prove
  each page renders its section.
- Settings changes made here persist in `$RUN/home/userdata/settings.json`, not in the
  live install.
- Integrations says "Only available in the desktop app" for the browser features:
  verifying them needs the Electron app, which is unverified here.

## Proves it works

Each section opens at its URL and shows its own content, never another section's.
