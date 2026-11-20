# Fork sync policy

The fleet builds and deploys from `release/native-0.1.10` on
`nullStack65/t3code`. Upstream is `pingdotgg/t3code` `main`, fetched as
`upstream/main`. This says how the two stay close. It does not perform a sync.

## Cadence

Once a week, Builder opens a pull request that merges `upstream/main` into a
branch cut from `release/native-0.1.10`, named `sync/upstream-<YYYY-MM-DD>`.
The pull request runs the fork's ARC CI. It merges only when that CI is green
and the one bot review round is done, like any other change.

## Conflict budget

A sync that conflicts in 25 files or fewer is resolved inside that pull
request. Fork files win where the fork deliberately diverges (the native
release line, the ARC workflow, the inbox and placement changes); upstream wins
everywhere else. A sync that conflicts in more than 25 files stops, and the
pull request says which files conflict and asks for a decision instead of
forcing the merge.

## Drift receipt

`scripts/fork-drift-receipt.mjs` reads the release line against `upstream/main`
and prints one JSON object: commits ahead, commits behind, the merge base and
how many files differ. It fetches nothing and writes nothing. It exits 1 when
the line is more than 300 commits behind, which is the point at which a weekly
sync has clearly lapsed. Run it by hand:

```sh
git fetch upstream
node scripts/fork-drift-receipt.mjs --base origin/release/native-0.1.10
```

The receipt measures drift. It does not count merge conflicts, because counting
those means running the merge. The 25-file conflict budget applies when the
weekly sync pull request is opened.

## Who resolves

Builder owns the sync pull request and resolves conflicts inside the budget.
A sync past the budget, or one whose CI fails for a reason other than
conflicts, goes back to the delegating thread with the receipt.
