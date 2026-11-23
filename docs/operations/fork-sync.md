# Fork sync policy

The fleet builds and deploys from `release/native-0.1.10` on
`nullStack65/t3code`. Upstream is `pingdotgg/t3code` `main`, fetched as
`upstream/main`. This says how the two stay close. The daily workflow performs
the fetch and opens the pull request. Merging that pull request is still a
separate step.

## Cadence

`.github/workflows/upstream-sync.yml` runs once a day. It fetches
`upstream/main` and, when the merge into a branch cut from
`release/native-0.1.10` is clean, opens or updates
`sync/upstream-<YYYY-MM-DD>`. The pull request runs the fork's ARC CI. It
merges only when that CI is green and the one bot review round is done, like
any other change. The workflow does not merge it.

A clean update of an existing sync branch is a merge, never a force-push. If
the push is not a fast-forward, the workflow stops and says so.

The workflow opens the pull request with `T3_FORK_SYNC_TOKEN` when that
repository secret is set, so the pull request checks start. Without the
secret, the default token can open the pull request and cannot start the
other workflows. The body says that, and the pull request stays unmerged
until a `nullStack65` push starts CI.

## Conflict budget

The daily job does not resolve conflicts. Any conflict updates one open issue,
titled `Upstream sync blocked`, naming Platform / CTO and listing the files.
It does not push a resolution.

A person may resolve a sync of 25 files or fewer in that pull request. Fork
files win where the fork deliberately diverges (the native release line, the
ARC workflow, the inbox and placement changes); upstream wins everywhere else.
A sync that conflicts in more than 25 files still waits for a decision. Nobody
force-pushes it.

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
those means running the merge. `scripts/upstream-sync.sh` runs that merge.
`scripts/fork-sync-plan.mjs` decides whether the result may be pushed. A
conflict, a failed merge, or a rejected push is never pushed, and the decision
sets `allowForcePush` to false.

## Who resolves

The daily job files the conflict issue. Platform / CTO owns a sync past the
25-file budget. A person may resolve 25 files or fewer. A sync whose CI fails
for a reason other than conflicts goes back to the delegating thread with the
receipt.
