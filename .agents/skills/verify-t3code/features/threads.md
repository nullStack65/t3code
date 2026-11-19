# Threads

A thread is one conversation and its work history. A person starts one, renames it,
marks it unread and finds it in the sidebar.

## Sub-features

- `threads.list`: the sidebar lists each thread as a row with project, age, title and
  branch.
- `threads.new`: "New thread" opens a draft for the current project.
- `threads.rename`: "Rename thread" changes the title in the row and the header.
- `threads.mark-unread`: "Mark unread" makes the row show the "Done" status chip.

Sending is in [composer.md](composer.md); pin, settle, snooze and archive are in
[sidebar-lifecycle.md](sidebar-lifecycle.md) and [archive.md](archive.md).

## How to get to it (user POV)

- Sidebar: right-click a row for the menu: New thread on `<branch>`, Pin thread, Settle
  thread, Snooze, Rename thread, Regenerate title, Mark unread, Filter by `<project>`,
  Copy, Project settings, Archive thread, Delete.
- Thread header: the title is a button (`button[aria-label^="Thread actions for"]`)
  that opens the same actions.
- "New thread" sidebar button (`[data-testid="new-thread-button"]`), `Ctrl+N`
  (`chat.new`), `Ctrl+Shift+O`.
- Not driven: Regenerate title (calls a text-generation provider), Copy, Delete, the
  header actions menu, `Ctrl+N`.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); one thread titled
`verify-t3code: first message` (from `seed.mjs`).

- Read the rows → one row, text "demo-app now Settle verify-t3code: first message
  t3code/ <id>" (`threads.list`).
- Row menu > Rename thread, Ctrl+A, type `verify-t3code: renamed`, Enter → the header
  button's label is "Thread actions for verify-t3code: renamed" and the row text has the
  new title (`threads.rename`).
- Row menu > Mark unread → the row shows the "Done" chip in place of the age
  (`threads.mark-unread`).
- Click "New thread" → URL `/draft/<id>` and the heading "What should we build in
  demo-app?" (`threads.new`).

## Gotchas

- Right-click a row through `[data-testid="sidebar-row-card"]`; `thread-row-*` test ids
  exist in the source but not on this sidebar. Wait for the menu item before clicking:
  on a busy host the previous menu can still be closing and swallow the first
  right-click. `drive-threads.mjs` retries once.
- Row text order is: project, age or status, action, title, branch.

## Proves it works

The renamed title shows in both the sidebar row and the thread header, and a thread
marked unread shows the "Done" chip.
