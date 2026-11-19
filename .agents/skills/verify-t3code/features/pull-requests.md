# Pull Requests

A page that lists pull requests across connected environments so a person can open
one in the right panel.

## Sub-features

- `pull-requests.page`: the page lists open pull requests with number, title, author,
  repository and age, under Sort and Filters.

## How to get to it (user POV)

- Sidebar footer "Pull Requests" button, or
  `/pull-requests?involvement=all&state=open`.
- Not driven: opening a PR in the right panel, linking a PR to a thread
  ("Link to thread" on a PR link), filters and sort, copy shortcuts
  (`mod+shift+c`, `mod+shift+k`), file review.

## Driving it with `browser.mjs`

Preconditions: baseline from [README.md](README.md); the host's `gh` is logged in.

- Click "Pull Requests" → the URL is `/pull-requests?involvement=all&state=open` and the
  main text starts "Pull Requests Sort Filters All Authored" followed by rows such as
  "#100 feat(server): … nullStack65 nullstack65/t3code 5m ago" (`pull-requests.page`).
  Observed on three fresh instances: the first visit fails (see Gotchas); after Retry
  the same list appears.

## Gotchas

- This is a live read of GitHub through the host's `gh` credentials, not the fixture.
  It is read-only; do not drive linking or any write from a verify run.
- BUG, intermittent: on six fresh instances the first visit showed the error four times,
  listed the PRs at once once, and once ran a check that only read the loading skeleton: the first visit to the page (after opening
  Usage) shows "Could not load pull requests" with the internal text "All fibers
  interrupted without error" and a Retry button. Retry lists the PRs, and later visits in
  the same instance list them at once. `drive-surfaces.mjs` records this as `FAIL
  pull-requests.page`. Do not click Retry to make the step pass or wait it out. The
  nullStack65/t3code repo has issues disabled, so the report lives here and in the PR that
  added this file.

## Proves it works

The page shows a list of real open PRs (number, title, author, repository, age).
