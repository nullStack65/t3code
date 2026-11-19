# Archive and unarchive

Archiving hides a thread from the sidebar without deleting it. Settings > Archive
lists archived threads and brings them back.

## Sub-features

- `threads.archive`: Archive thread removes the row and leaves the thread page.
- `settings.archived`: the Archive page lists the thread with when it was archived.
- `threads.archived.restore`: Unarchive empties the Archive page.
- `threads.archived.returns`: after Unarchive the row is back in the sidebar.

## How to get to it (user POV)

- Right-click a row > Archive thread.
- Settings (footer gear) > Archive.
- Not driven: the Undo toast after archiving, auto-archive, Delete.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); one active thread.

- Row menu > Archive thread → no rows in the sidebar and the URL moves to `/draft/<id>`
  (`threads.archive`).
- Footer gear, then the "Archive" button → `/settings/archived`, text
  "demo-app verify-t3code: renamed Archived just now · Created 1m ago Unarchive"
  (`settings.archived`).
- Click "Unarchive" → "Archived threads No archived threads" on the page
  (`threads.archived.restore`).
- Click "Back" and read the rows → one row titled `verify-t3code: renamed`
  (`threads.archived.returns`).

## Gotchas

- Archiving does not ask for confirmation in this build; `drive-threads.mjs` still
  clicks a confirm button if one appears.
- Settings pages are lazy routes: the URL and header change before the body does. The
  script waits for the main text to differ from the previous page.

## Proves it works

An archived thread disappears from the sidebar and is listed on the Archive page; after
Unarchive the page is empty and the thread is back in the sidebar.
