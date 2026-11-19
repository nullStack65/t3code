# Pin, settle, snooze and wake

The sidebar is the inbox of live work: pinned threads on top, active threads below,
a Snoozed shelf for threads waiting on a wake time, and a Settled shelf for finished
work. A person moves a thread between these with its menu or by dragging.

## Sub-features

- `threads.pin`: Pin thread puts a pin on the row; `threads.unpin` removes it.
- `threads.settle`: Settle thread moves the row to the Settled shelf and the count
  goes up; `threads.unsettle` brings it back to the active list.
- `threads.snooze`: Snooze > In 1 hour moves the row to the Snoozed shelf.
- `threads.wake`: Wake thread now returns a snoozed row to the active list.

## How to get to it (user POV)

- Right-click a row: Pin thread (Unpin thread when pinned), Settle thread (Un-settle on
  a settled row), Snooze > In 1 hour, In 3 hours, This evening, Tomorrow, Next week,
  Custom….
- Hover a row: Settle and Snooze buttons; on a snoozed row a Wake button, on a settled
  row an Un-settle button.
- Click the pin icon on a pinned row to unpin.
- Drag a row between sections (pinned, active, Settled header), described in
  [docs/user/thread-sidebar.md](../../../../docs/user/thread-sidebar.md).
- Not driven: dragging, Custom snooze, selecting several threads to snooze, the Undo
  toast and `mod+z`, automatic settlement rules in Settings > General.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); one active thread.

- Row menu > Pin thread → one `button[aria-label="Unpin thread"]` in the row
  (`pinnedMarkers: 1` in the log). Row menu > Unpin thread → `pinnedMarkers: 0`.
- Row menu > Settle thread → shelf toggle text "Settled (1)" and no active rows. Expand
  the shelf, row menu > Un-settle thread → the row is back in the active list and the
  toggle reads "Settled" with no count.
- Row menu > Snooze > "In 1 hour" → shelf toggle "Snoozed (1)" and no active rows.
- Expand the Snoozed shelf if it is closed (`aria-expanded` on
  `[data-testid="sidebar-snoozed-shelf-toggle"]`), hover the `sidebar-row-slim` row,
  click `[aria-label="Wake thread now"]` → the snoozed toggle disappears and the row is
  in the active list.

## Gotchas

- Wake and Un-settle are `opacity-0 pointer-events-none` until the row is hovered. A
  browser without hover capability (stock headless Chromium reports `hover: none`) can
  never reveal them, and a click then times out. `browser.mjs` launches Chromium with
  hover and fine-pointer settings and Doctor-level checks should read
  `matchMedia("(hover: hover)")`. Do not "fix" this by force-clicking the hidden
  button: that proves nothing about what a user sees.
- Snoozing or settling can leave a shelf open already; only click its toggle when
  `aria-expanded` is `false`, or you close it.
- A snooze is 1 hour from the click, so a verify run must wake the thread itself.

## Proves it works

Settled (1) and Snoozed (1) appear with the row gone from the active list, and each
reverse action returns the row to the active list with the count removed.
