# Search (command palette)

`Ctrl+K` (`Cmd+K` on macOS) opens a palette that finds threads across connected
environments and runs commands. A person types part of a title and picks the thread.

## Sub-features

- `search.palette`: typing a thread title lists that thread, with project, environment,
  branch and age, and a status prefix such as "Completed".
- `search.snoozed`: a snoozed thread is still found.

## How to get to it (user POV)

- `Ctrl+K` / `Cmd+K` (`commandPalette.toggle`); the sidebar "Search" row.
- `[data-testid="command-palette-trigger"]` opens it from the sidebar.
- Palette modes for files (`mod+P`) and project content (`mod+shift+F`) share the
  overlay; the "New project" button opens the same palette with project sources.
- Not driven: message-content search (starts after two characters), file and content
  modes, running commands, opening a result with Enter.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); a thread titled
`verify-t3code: renamed`.

- Click the page body (focus off the terminal), press Control+K, type `renamed` into
  `input[placeholder^="Search commands"]`, wait for `[role="option"]` → one option
  "verify-t3code: renamed DA demo-app · Local · t3code/ <id> · just now" for an active
  thread (`search.active`).
- Archive the thread, Unarchive it from Settings > Archive, then repeat the search
  (`search.palette`). Read the result as logged: an empty list with "No matching
  commands, projects, or threads" while the thread is in the sidebar is a failure.
- Snooze the thread first, then repeat → one option "verify-t3code: renamed DA demo-app
  · Local · t3code/ <id> · just now" (`search.snoozed`).

## Gotchas

- Open state is easy to get wrong: Control+K does nothing while focus is in the terminal
  drawer, and the palette can reopen in a project-picker mode that lists only projects
  and leaves a modal over the page. Press Escape, click the page body, then Control+K,
  and confirm the input placeholder starts "Search commands" before typing.
- Not understood yet: in two earlier instances the search after an archive and
  Unarchive returned nothing for a thread that was in the sidebar, and a reload was not
  tried before the run was lost. It may be a stale search index after Unarchive or a
  harness focus problem; repeat the archive, Unarchive, search sequence and reload before
  calling it a bug.
- Results arrive after the dialog opens: on a busy host an immediate read returns
  nothing. Poll for an option for up to 12 s before concluding the thread is missing;
  an early run recorded `[]` this way while the thread existed.
- Press Escape afterwards or the overlay captures the next click.

## Proves it works

Typing a title shows that thread as a result.
