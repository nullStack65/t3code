# Pull Requests

A page that lists pull requests across connected environments so a person can open
one in the right panel.

## Sub-features

- `pullrequests.page`: the page lists open pull requests with number, title, author,
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
  "#100 feat(server): … nullStack65 nullstack65/t3code 5m ago" (`pullrequests.page`).

## Gotchas

- This is a live read of GitHub through the host's `gh` credentials, not the fixture.
  It is read-only; do not drive linking or any write from a verify run.
- Observed once: the first visit after the Usage page showed "Could not load pull
  requests: All fibers interrupted without error" with a Retry button; Retry listed
  the PRs, and three later visits listed them at once. It is an internal error string
  in the UI. If the first visit shows it again, record it as a failure, do not retry
  past it, and report it.

## Proves it works

The page shows a list of real open PRs (number, title, author, repository, age).
