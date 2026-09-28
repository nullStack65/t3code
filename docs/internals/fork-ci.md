# Fork CI routing and validation capacity

> For the `nullStack65/t3code` fork. Upstream CI docs do not apply here. Release
> runner admission lives in [fork-release.md](../operations/fork-release.md).

The fork inherits upstream's `.github/workflows/ci.yml`, which schedules
Blacksmith runner labels (`blacksmith-8vcpu-ubuntu-2404`, …). The fork has no
Blacksmith installation, so those jobs never acquire a runner: every completed
CI run on this fork has been `cancelled`, never `success` or `failure`, and the
queued runs sit on unmatched labels indefinitely. Which label upstream uses is
also upstream billing policy, not a fork decision.

## Admitted capacity, not guessed labels

Substantive jobs run on **owner-admitted self-hosted capacity** declared through
the same repository variables the landed fork-release pipeline uses:

| Variable | Meaning |
| --- | --- |
| `T3CODE_AUTHORIZED_RUNNERS` | Comma-separated labels this fork may execute on. |
| `T3CODE_LINUX_RUNNER` | The admitted Linux validation label. |
| `T3CODE_MACOS_X64_RUNNER` | The admitted Intel macOS validation label (mobile native lint only). |

No label is guessed or defaulted, and there is no GitHub-hosted fallback: a
missing declaration fails closed rather than silently running elsewhere. The
`authorize` jobs run before any job that checks out or installs source, and
every substantive job needs them.

`.github/scripts/fork-ci-routing.sh` is the single source of truth for the
policy. It prints a machine-readable reason and exits non-zero:

| Token | Exit | Condition |
| --- | --- | --- |
| `ADMITTED` | 0 | Every required role is declared and authorized. |
| `CAPACITY_NOT_CONFIGURED` | 2 | `T3CODE_AUTHORIZED_RUNNERS`, or a required runner variable, is unset or empty. |
| `UNTRUSTED_FORK` | 3 | A pull request head is external **or unidentified** (empty `HEAD_REPO`). |
| `RUNNER_NOT_AUTHORIZED` | 4 | A declared label is absent from `T3CODE_AUTHORIZED_RUNNERS`. |
| `UNTRUSTED_CONTEXT` | 5 | An unknown event or an empty repository identity. |

`.github/scripts/fork-ci-routing.test.py` exercises every outcome with bounded
fixtures and runs in the `Test` job. It also extracts the workflow's inline
first-introduction bootstrap (below) from `ci.yml` and asserts the guard and the
bootstrap return byte-identical results on the whole fixture table.

### First introduction: the bootstrap that cannot load a missing file

The `authorize` jobs used to check out `github.event.pull_request.base.sha` and
execute `.github/scripts/fork-ci-routing.sh`. That file is introduced by the same
change that adds the workflow, so on the pull request that first introduces it
the base tree predates the file and the job failed with "No such file" — before a
runner could even report the real reason. Even provisioned capacity would not
have fixed that.

The admission step is now a **small explicit bootstrap in the reviewed
workflow**. It runs the checked-out trusted guard when the guard exists at the
selected ref, and otherwise enforces the identical policy inline (same env
contract, same tokens, same exit codes) instead of executing unmerged guard
source or requiring a preliminary push to the default branch. The unit test
drives the real base/candidate trees: base without the guard (first
introduction) and base with it (later pull requests). Trust in the bootstrap
rests on the reviewed workflow plus the job-level and repository boundaries
below — not on executing arbitrary pull-request code as a trusted guard.

### When capacity is not configured

The current fork state is `CAPACITY_NOT_CONFIGURED`: the repository has **no**
registered self-hosted runners and **no** Actions variables, while
`T3CODE_AUTHORIZED_RUNNERS` and the runner variables are how admission is
expressed. Until the owner supplies them, CI cannot execute here; do not read a
queued job as a result, and do not add an unmatched label to make the queue look
intentional.

The failure is fail-closed, not a queue. Four states must be read differently:

| State | What happened | Evidence |
| --- | --- | --- |
| Scheduling validation failure | `runs-on` is empty, so GitHub cannot create the job; the run concludes `failure` at startup, no runner is allocated, dependents skip. | PR #12 run `36425220326` (`5a1f0322d`) and `36424904599` (`81159961d`): `authorize` absent, all other jobs `skipped`, `runner_name` empty. |
| Queued on an unmatched label | No online runner matches the selected label; the job waits indefinitely. No diagnostic can print from a runner that does not exist. | Pre-repair run `36415749632` on Blacksmith labels; also the historical 48/48 `cancelled` runs. |
| Executed guard refusal | A runner was allocated and the guard ran, exiting `2`/`3`/`4`/`5` and printing the exact prerequisite. | Reaches only once a label schedules. |
| Actual job execution | A runner was allocated and a substantive job ran. | Requires admitted capacity below. |

When a Linux label **is** declared but missing from `T3CODE_AUTHORIZED_RUNNERS`,
the job schedules and the guard exits with `RUNNER_NOT_AUTHORIZED` (or
`CAPACITY_NOT_CONFIGURED` when a required variable is empty) and prints the exact
prerequisite. Never manufacture a green no-op or an unmatched label to make the
queue look intentional.

### Smallest suitable existing capacity route and its owner

The existing supported self-hosted Linux CI platform for this account is the
repository-managed K3s + Actions Runner Controller (ARC) cluster on
`nullStack65/Closura`. Its operating contract is `Closura:llm/runners-and-ci.md`
(normative) with `infra/proxmox/README.md`; it is **owned and operated by the
Closura infrastructure lane**, and it is the only supported local ephemeral Linux
route (GitHub-hosted runners are explicitly not a fallback for this account).
There is already one scale set per repository (`closura-ci-arc`,
`closura-agent-config-ci-arc`), so the smallest suitable addition is a
`t3code`-scoped scale set on the same cluster.

Exact gap today: **no self-hosted runner and no scale set is registered to
`nullStack65/t3code`.** The existing runners are repository-scoped and cannot
serve a User-owned repository (`Closura`: `closura-ci-arc-*`,
`closura-staging-closura-01`, `runner-01-observability-r720`;
`closura-agent-config`: `runner-01-delivery-manager`). In particular the R720
observability/staging runners are recovery/deployment paths, not general CI
capacity, and adopting them would violate the no-R720-load direction. Queued
jobs will not fix this.

Owner packet (to be sequenced by ENV-1 with the ARC infrastructure owner; this
source repair does **not** perform it):

1. Add an ephemeral, non-root ARC scale set `t3code-ci-arc` to the existing
   cluster, registered to `nullStack65/t3code` with its own short-lived,
   repository-scoped GitHub App registration token (Infisical `/ci/arc`). Reuse
   the `closura-ci-arc`/`closura-agent-config-ci-arc` image and NetworkPolicy
   contract; standard workers only, no DinD, no host socket, no host paths.
2. Set on `nullStack65/t3code`: `T3CODE_LINUX_RUNNER=t3code-ci-arc` and
   `T3CODE_AUTHORIZED_RUNNERS=t3code-ci-arc`.
3. For the mobile native lint only, register an Intel macOS runner, set
   `T3CODE_MACOS_X64_RUNNER`, and append its label to
   `T3CODE_AUTHORIZED_RUNNERS`.
4. Bounded concurrency: keep the standard scale set's configured `min/max`
   runners and the cluster's health/queue-drain gates; do not raise `maxRunners`
   to silence a queue. Conditional macOS capability stays opt-in via the change
   detector.
5. Public-repo trust: set fork-PR approval to `all_external_contributors` before
   admission, keep `default_workflow_permissions: read`, and consider enabling
   `sha_pinning_required`.
6. Rollback: set the scale set's desired runners to zero or remove it, and unset
   `T3CODE_AUTHORIZED_RUNNERS` / `T3CODE_*_RUNNER`; the guard then fails closed
   and no source executes on self-hosted capacity. The recovery/staging runners
   are never touched.

Release admission (`fork-release.yml`) does not authorize arbitrary PR
execution; it is a separate workload with separate suitability. The fork CI
route above is distinct even though it reuses the same variable names.

### Runner image prerequisites

The admitted image must already provide what CI assumes: `bash`, `git`, `gh`
(the change detector calls the GitHub API), `python3`, a Rust toolchain (the
pinned `dtolnay/rust-toolchain` action supplies it), and — for the macOS lint —
`brew`. Node comes from the pinned `setup-vp` action.

The browser-secret build libraries (`libsecret-1-dev`, `pkg-config`) must also be
baked into the image. CI **verifies** them and fails with the exact missing
package names; it never runs `sudo apt-get` on whatever host was selected. If the
image lacks a prerequisite the job fails visibly; nothing falls back to hosted
capacity and no host package is silently mutated.

## Trust boundary

CI keeps the fork's self-hosted capacity off untrusted code:

- Only `pull_request` and `push` to `main` trigger the workflow. There is no
  `pull_request_target`, and no workflow runs PR code with a write token.
- Every `actions/checkout` step uses `persist-credentials: false`, including the
  substantive jobs; no job leaves a usable token in a checkout's git config for
  later steps. Workflow permissions stay `contents: read` (plus
  `pull-requests: read` for the API-only change detector), and
  `default_workflow_permissions` on the repository is `read`.
- Actions are pinned to immutable commit SHAs (`actions/checkout`,
  `voidzero-dev/setup-vp`, `dtolnay/rust-toolchain`, `actions/upload-artifact`)
  with the major version in a trailing comment. No mutable tag selects code that
  runs on self-hosted capacity.
- The `authorize` job skips when a `pull_request` head repository is not this
  repository, before a runner is allocated, and the routing script rejects
  external and unidentified heads as defense in depth.
- No secret, publish, deploy, or model call runs in CI. No release credential,
  active-user home mount, or privileged host socket is made available to a job.

### The real external-PR boundary is a repository setting, not the YAML

A job-level `if` lives in YAML that a pull request can edit, so it is defense in
depth — not an immutable security boundary. The boundary that actually holds is
the repository's Actions approval policy plus the read-only token:

- As of this review `nullStack65/t3code` reports
  `approval_policy: first_time_contributors`, `default_workflow_permissions:
  read`, `can_approve_pull_request_reviews: false`, and
  `sha_pinning_required: false`.
- Before any self-hosted runner is registered **to this public repository**, the
  owner should set fork-PR approval to `all_external_contributors` (and consider
  enabling `sha_pinning_required`). A returning external contributor otherwise
  needs no approval, and the only thing stopping an edited workflow would be the
  non-immutable `if`. This is an owner action; it is not performed by the source
  repair in this PR.

## Host portability

Upstream's `Check`/`Test` jobs rewrite `/etc/apt/blacksmith-ubuntu-mirrors.txt`
through `.github/actions/setup-apt-mirrors` and an inline `sed`. Those edits only
make sense on a Blacksmith image and would mutate a shared agent host's apt
configuration. The fork's jobs instead **verify** that `libsecret-1-dev` and
`pkg-config` are already present and fail with the exact missing package names;
they never touch apt sources or install host packages. Caches remain the standard
Actions cache used by `setup-vp`.

## Lifecycle interface (#10 `windows-service-host`)

`t3code#10` adds `native/windows-service-host`, a Rust crate that is not yet on
`main`. The `Rust` job used to hardcode its crate list, so a newly landed crate
would have been silently skipped until someone edited the workflow. It now
discovers every `native/*/Cargo.toml` and runs the same
`cargo fmt -- --check` / `cargo test --locked` per crate, failing if none are
found. When `windows-service-host` lands it is covered automatically; no crate
is imported or tested here before it exists. The fork CI owner does not depend on
the lifecycle writer, and the lifecycle writer does not need to edit this
workflow.