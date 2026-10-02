# T3 fork CI portability result

- Base: `419f7574010c066a56974fc9e3ac0709a08efb33`
- Head: `a435c0242a6afc9f129d296dfc75deba0091279d`
- Branch: `envfix/fork-ci-hosted-runners-20261002`
- Pull request: [nullStack65/t3code#17](https://github.com/nullStack65/t3code/pull/17)

## Change

The existing CI and mobile fingerprint jobs now select supported GitHub-hosted
runners: `ubuntu-24.04` for Linux jobs and `macos-14` for mobile native static
analysis. Job names, timeouts, concurrency, permissions, sharding, checks,
and native-change gating are unchanged. The shared APT mirror action uses
`/etc/apt/t3-ubuntu-mirrors.txt`, removing the Blacksmith-only path name while
retaining mirror failover behavior.

No PR16 edits, check bypasses, cancellations, host/runtime/settings changes,
or Blacksmith configuration changes were made. This PR is intentionally
separate and is not merged by this lane.

## Validation

- `actionlint .github/workflows/ci.yml .github/workflows/mobile-fingerprint-check.yml` — passed
- Ruby YAML parse of both workflows and `.github/actions/setup-apt-mirrors/action.yml` — passed
- `git diff --check` — passed

## GitHub checks observed

At `2026-10-02T02:48:07Z`, PR #17 had been accepted and all required workflow
jobs had concrete check-run IDs but were still `QUEUED` before any step ran.
The CI run is `36957297722`; the mobile fingerprint run is `36957297643`.

| Check | Run / job | Check-run URL |
| --- | --- | --- |
| Check | `36957297722 / 110683005365` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005365 |
| Test | `36957297722 / 110683005327` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005327 |
| Test Server 1 | `36957297722 / 110683005224` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005224 |
| Test Server 2 | `36957297722 / 110683005294` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005294 |
| Test Server 3 | `36957297722 / 110683005340` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005340 |
| Rust | `36957297722 / 110683005276` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005276 |
| Mobile Native Changes | `36957297722 / 110683005131` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005131 |
| Release Smoke | `36957297722 / 110683005313` | https://github.com/nullStack65/t3code/actions/runs/36957297722/job/110683005313 |
| Native fingerprint diff | `36957297643 / 110683004416` | https://github.com/nullStack65/t3code/actions/runs/36957297643/job/110683004416 |

The parent lane owns review, landing, and subsequent live acceptance. These
queued statuses are evidence of dispatch, not completion.
