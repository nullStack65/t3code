# T3 Code verification map

Each feature file lists sub-features by stable ID. The ID is also the step name the
drive scripts write to `$RUN/evidence/observed.log`, so an evidence line maps straight
to a sub-feature.

| ID | Feature | Primary proof |
| --- | --- | --- |
| onboarding | First-run setup wizard | `scripts/seed.mjs` |
| projects | Add and filter projects | `scripts/seed.mjs`, `scripts/drive-surfaces.mjs` (`projects.filter`) |
| composer | Model picker, send, agent reply | `scripts/seed.mjs` |
| threads | New, rename, mark unread, list | `scripts/drive-threads.mjs`, `scripts/drive-surfaces.mjs` (`threads.new`) |
| sidebar-lifecycle | Pin, settle, snooze, wake | `scripts/drive-threads.mjs` |
| archive | Archive, Archive page, unarchive | `scripts/drive-threads.mjs` (`archive.thread`), `scripts/drive-surfaces.mjs` |
| search | Command palette thread search | `scripts/drive-threads.mjs` (`search.snoozed`), `scripts/drive-surfaces.mjs` (`search.palette`) |
| terminal | Terminal drawer | `scripts/drive-surfaces.mjs` (`terminal.drawer`) |
| settings | Settings sections | `scripts/drive-surfaces.mjs` (`settings.<section>`) |
| connections | Environments and network access | `scripts/drive-surfaces.mjs` (`connections.page`) |
| usage | Usage page | `scripts/drive-surfaces.mjs` (`usage.page`) |
| pull-requests | Pull Requests page | `scripts/drive-surfaces.mjs` (`pull-requests.page`) |

## Baseline preconditions

- A clean checkout at the exact head under test, installed per SKILL.md Launch.
- ASUS, one instance at a time, `launch.sh` (never a bare `vp run dev`: see SKILL.md).
- Fixture project `demo-app` and the mock Cursor provider, both built by `launch.sh`.
  Send turns only with Cursor > Auto. The default model for new threads is a real Codex
  model, and the auto-bootstrapped `server` project points at this checkout's `apps/server`.
- The headless browser must report hover capability (`browser.mjs` sets it); hover-only
  controls such as Wake and Un-settle do not exist without it.
- Order matters for the shipped drive: `seed.mjs`, then `drive-threads.mjs`, then
  `drive-surfaces.mjs`. `drive-surfaces.mjs` expects the thread archived by the previous
  script. Each script exits 1 if any step logged FAIL; `run-all.sh` runs all of them and
  exits non-zero.
- Isolation is partial: only `T3CODE_*` is scrubbed and `HOME` is the real one. The instance
  probes the host's real Claude and Codex CLIs for status, and the Pull Requests page reads
  GitHub through the host's `gh` (PR titles land in the screenshots). Do not put the
  evidence folder anywhere public.

## Proof and skip reporting

- Record the head SHA, the sub-feature ID, the action and the observed end state.
- An entry point you did not drive is unverified for that entry point. Every feature file
  lists its undriven entry points under Gotchas.
- Never weaken an assertion to make a run pass; record the reason in Gotchas.

## On the map elsewhere, not on this head

These exist in the fork's open pull requests, not on `main`, so they have no feature
file yet. The PR that lands one adds its file:

- Founder inbox lanes and filters: open PRs for founder inbox tags, the scoped founder
  inbox, and inbox action threads staying in the active list while they work.
- Parent and child threads: `main` has only the Agents panel for subagents a thread spawns.

## Not driven by the shipped scripts

Desktop (Electron) shell, mobile app, linked remote machines (Connections > Add
environment), Pull Request linking to a thread, previews and the in-app Browser panel,
SnapShots, Integrations browser import, Agents panel, composer attachments and queued
follow-ups, diff panel, git actions. Each needs a feature file when someone drives it.

The last-seen marker ([seen-marker.md](seen-marker.md)) is also not on this drive.
Nothing in the window shows it: a focused 2 second dwell only updates device memory,
and the catch-up line is added to the provider prompt on the next send. The unit
tests are the proof.
