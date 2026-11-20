# Last seen by a human

A founder who leaves a thread and comes back should be caught up only on what they
did not see. The app remembers the newest message that stayed on screen for about
2 seconds in a focused, visible window. The next message they send tells the agent
where they left off. Scrolling never starts a turn, and a bot reading the thread
never counts as a view.

## Sub-features

- `seen-marker.dwell`: the newest on-screen message is remembered after 2 seconds,
  and a shorter look is not.
- `seen-marker.focus`: a hidden, blurred, or backgrounded window does not count.
- `seen-marker.send`: the next send on that thread carries the marker, and the
  provider prompt says who was last seen and how many assistant messages since
  are unseen. A slash command stays first so it still runs; other text keeps
  the catch-up in front.
- `seen-marker.quiet`: scrolling and dwelling dispatch no command and open no socket.
- `seen-marker.bots`: a thread read, and a send that did not come from the app,
  carry no marker.

## How to get to it (user POV)

- Web and desktop: open a server thread and leave the window focused. Mobile: open
  the thread with the app in the foreground.
- There is no control, badge, or settings path. The timeline does not change.

## Driving it with `browser.mjs`

Not driven. The marker is not rendered, so a browser pass cannot see it. A send
through the mock provider would only show it if the mock echoed its prompt, and
this drive does not do that.

## Gotchas

- The memory is per device and per app launch. A reload, or reading on one device
  and sending from another, can repeat a catch-up or skip one. It never hides a
  message.
- Bot and MCP reads do not run this client code. MCP sends do not attach a marker.
- Compact on the open thread is a send, so it carries the marker. A brand-new
  thread does not. The catch-up follows `/compact` instead of leading it.
- A reply that is still streaming does not count. The previous finished message
  on screen can.

## Proves it works

`packages/client-runtime/src/seenMarker.test.ts`,
`apps/web/src/hooks/useSeenMarkerTracking.test.ts`,
`apps/mobile/src/features/threads/useThreadSeenMarker.test.ts`,
`packages/shared/src/seenMarker.test.ts`, and
`apps/server/src/orchestration/decider.seenMarker.test.ts`.
