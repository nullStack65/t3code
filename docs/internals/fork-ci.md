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
| `UNTRUSTED_FORK` | 3 | The pull request head is not this repository. |
| `RUNNER_NOT_AUTHORIZED` | 4 | A declared label is absent from `T3CODE_AUTHORIZED_RUNNERS`. |

`.github/scripts/fork-ci-routing.test.py` exercises all four outcomes with
bounded fixtures and runs in the `Test` job.

### When capacity is not configured

The current fork state is `CAPACITY_NOT_CONFIGURED`: the repository has **no**
registered self-hosted runners and **no** Actions variables, while
`T3CODE_AUTHORIZED_RUNNERS` and the runner variables are how admission is
expressed. Until the owner supplies them, CI cannot execute here; do not read a
queued job as a result, and do not add an unmatched label to make the queue look
intentional.

To admit capacity, the repository owner must:

1. Register at least one self-hosted runner **to `nullStack65/t3code`**. A
   user-owned account has no organization runner groups, so self-hosted runners
   registered to another repository (for example the `Closura` runners) cannot
   run `t3code` jobs. The runner must be a disposable, isolated validation host,
   never the active desktop.
2. Set `T3CODE_LINUX_RUNNER` to that runner's label and list the same label in
   `T3CODE_AUTHORIZED_RUNNERS`.
3. Only for repositories that run the mobile native lint, register an Intel
   macOS runner, set `T3CODE_MACOS_X64_RUNNER`, and add its label to
   `T3CODE_AUTHORIZED_RUNNERS` too.

Release admission (`fork-release.yml`) does not authorize arbitrary PR
execution; it is a separate workload with separate suitability. The fork CI
route above is distinct even though it reuses the same variable names.

### Runner image prerequisites

The admitted image must already provide what CI assumes: `bash`, `git`, `gh`
(the change detector calls the GitHub API), `python3`, a Rust toolchain (the
pinned `dtolnay/rust-toolchain` action supplies it), and — for the macOS lint —
`brew`. Node comes from the pinned `setup-vp` action. The browser-secret build
libraries are installed only when missing (see below). If the image lacks a
prerequisite the job fails visibly; nothing falls back to hosted capacity.

## Trust boundary

CI keeps the fork's self-hosted capacity off untrusted code:

- Only `pull_request` and `push` to `main` trigger the workflow. There is no
  `pull_request_target`, and no workflow runs PR code with a write token.
- The `authorize` job skips when a `pull_request` head repository is not this
  repository, before a runner is allocated. External PRs are therefore never
  scheduled on self-hosted capacity; the routing script enforces the same rule
  as defense in depth.
- Workflow permissions stay `contents: read` (plus `pull-requests: read` for the
  API-only change detector). Actions stay pinned to their existing major
  versions, and the guard checkout uses `persist-credentials: false`.
- No secret, publish, deploy, or model call runs in CI.

## Host portability

Upstream's `Check`/`Test` jobs rewrite `/etc/apt/blacksmith-ubuntu-mirrors.txt`
through `.github/actions/setup-apt-mirrors` and an inline `sed`. Those edits only
make sense on a Blacksmith image and would mutate a shared agent host's apt
configuration. The fork's jobs instead install `libsecret-1-dev` and
`pkg-config` only when they are missing, and never touch apt sources. The
admitted image is expected to carry them; if it does not, the install is bounded
and idempotent. Caches remain the standard Actions cache used by `setup-vp`.

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