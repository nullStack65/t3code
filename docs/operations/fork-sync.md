# Fork sync policy

The fleet builds and deploys from `release/native-0.1.10` on
`nullStack65/t3code`. The existing daily workflow fetches `pingdotgg/t3code`
`main`. Platform / CTO owns the sync proposal and its merge decision.

## Cadence

`.github/workflows/upstream-sync.yml` opens or updates one automated proposal
against `release/native-0.1.10`. It leaves a manually owned upstream proposal
with its existing owner. Branch updates use normal fast-forward pushes, and
multiple open sync proposals stop the job for Platform / CTO triage.

The job authenticates with a short-lived GitHub App installation token, minted
each run from the `T3_SYNC_APP_ID` and `T3_SYNC_APP_PRIVATE_KEY` repository
Actions secrets (contents, pull requests and workflows write). An installation
token cannot read `/user`, so the job checks the App's bot login instead. If
the App cannot mint a token, the job falls back to the `T3_FORK_SYNC_TOKEN`
repository Actions secret, a repository-scoped credential for `nullStack65`
that can push the sync branch and open and update PRs; the job verifies that
login before writing. The default workflow token can suppress the protected
pull-request checks, so the job requires one of these credentials.

A clean candidate can reach same-repository Actions secrets and private CI.
Platform / CTO admits the exact SHA via the
`T3_FORK_SYNC_ADMITTED_UPSTREAM_SHA` repository Actions variable after reviewing
that candidate's source and workflows. The job opens the clean, admitted
proposal for CI or marks its existing triage draft ready. The body records the
proposal head, upstream SHA, merge base, ancestry result and divergence counts.
The workflow leaves the merge to Platform / CTO after the required CI and review.

## Conflict budget

For conflicts or a clean SHA awaiting admission, the daily job uses the same
draft proposal. The conflict title and body identify the triage state and list
conflicted files. The draft's head contains a triage marker or the last
published candidate. Its description identifies whether the current upstream
SHA is an ancestor of that head.

A person may resolve a sync of 25 files or fewer in the pull request. Fork
files win where the fork deliberately diverges, including the native release
line, the ARC workflow, inbox and placement. Upstream wins elsewhere. Platform /
CTO owns any sync beyond the 25-file budget.

## Drift receipt

`scripts/fork-drift-receipt.mjs` reads the release line against `upstream/main`
and reports commits ahead, commits behind, the merge base and how many files
differ. It exits 1 when the line is over 300 commits behind. Run it by hand:

```sh
git fetch upstream
node scripts/fork-drift-receipt.mjs --base origin/release/native-0.1.10
```

Run `DRY_RUN=1 UPSTREAM_URL=https://github.com/pingdotgg/t3code.git bash
scripts/upstream-sync.sh` to probe merge conflicts without committing, pushing
or contacting the GitHub API.
