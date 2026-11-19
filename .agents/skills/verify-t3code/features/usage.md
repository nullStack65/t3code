# Usage

The Usage page shows cost, tokens and provider limits over a chosen window.

## Sub-features

- `usage.page`: the page opens with Cost, Tokens and Limits and the windows Past 24h,
  7 days, 30 days, 90 days.

## How to get to it (user POV)

- Sidebar footer "Usage" button, or `/usage`.
- Not driven: changing the window, adding a usage-limit source, per-provider settings.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md).

- Click "Usage" → URL `/usage` and text "Usage / All environments Cost Tokens Limits
  Past 24h 7 days 30 days 90 days" (`usage.page`).

## Gotchas

- On this host the page also says "Codex: Codex could not read usage (JSON-RPC -32600)".
  It reads the real Codex CLI's account, which an isolated home cannot reach, so the
  Limits panel is not verifiable here and counts and cost are empty for the fixture.
  Do not "fix" this by pointing the instance at a real provider home.
- Usage figures for the mock Cursor provider were not checked.

## Proves it works

The page opens at `/usage` with its Cost, Tokens and Limits sections and the window
selector. The limit data itself is unverified.
