# Callback admission review — exact head 178bd96

Result: **NON-VOTING TECHNICAL PASS**

PR #21: https://github.com/nullStack65/t3code/pull/21  
Reviewed commit: `178bd967ffde4d9ba7db660e88cecf38b5e0a361`  
Tree: `d38ffb07362c879a03363fc7f0cdebb44aef69dd`  
Base: `23467c599a401b7a5baf3c7052f0d45a181bc278`

I checked out only the exact commit in the detached review worktree. Tracked files remain unchanged; only untracked `execution/` review artifacts are present. This is an independent technical result, not a formal GitHub review or human approval. No merge or deployment was performed.

## Repair delta and legacy identity qualification

At `apps/server/src/serverRuntimeStartup.ts:503-539`, startup now retains the result of its existing `ProviderService.listSessions()` enumeration keyed by thread ID. It removes duplicate thread IDs from the candidate map and records them as ambiguous, so it repairs only a unique live session. For a projected session whose `providerInstanceId` is absent, it writes the exact `providerInstanceId` returned by that live provider session before command readiness. It preserves the other projected lifecycle fields. It adds no enumeration per command and does not mutate provider sessions or unrelated projected sessions.

This is a valid production repair, not an assumption that absent projected IDs are malformed. The contract makes `providerInstanceId` optional (`packages/contracts/src/orchestration.ts:623`); migration 028 adds a nullable column without a historical account backfill, and migration 027 explains why a driver name alone cannot safely identify an account. Projection storage/query omit SQL NULL. By contrast, production `ProviderService.listSessions()` tags each runtime session with the actual registered adapter instance. Startup consumes that already-authoritative source once. An unresolved or duplicate live identity is left unresolved; it is not filled from provider name, default account, or thread model selection.

The focused startup tests in `apps/server/src/serverRuntimeStartup.reconcile.test.ts:~510-650` cover a unique live identity repairing a legacy running projection while preserving status/active turn and allowing normal orphan processing; a live session with no instance ID leaves the projection untouched. Ambiguous duplicate entries are also excluded from the repair candidate by the implementation. In `OrchestrationEngine.ts:237-275`, unresolved active `starting`/`running` sessions still fail closed; known route changes are accepted only for matching driver and continuation key, otherwise they reject before events. Existing admission tests cover incompatible ready/running/stopped continuations and deliberate user model/option changes (`OrchestrationEngine.test.ts:591-~1035`). The repair makes the known active identity available to that existing compatibility decision; no account identity is guessed.

The four prior ProviderRuntimeIngestion failures are addressed at the test boundary: the fake runtime now supplies the emitting provider instance ID and the OpenCode fixture uses OpenCode selection consistently. Production event sources already attach registered-instance identity. The engine regression for a still-unresolved active session is retained (`OrchestrationEngine.test.ts:~855`). I find no production change that weakens that guard.

## Previous adversarial findings

The earlier findings remain closed on this exact head:

- Admission resolves the effective destination from explicit selection, captured callback binding, then current thread route. Bound and legacy incompatible continuations reject before message/turn/session events and produce a durable rejected receipt. Duplicate accepted command IDs and duplicate logical messages under a fresh command ID do not replay inference.
- Route policy includes model/options, runtime mode, and interaction mode. Stale route is checked after admission and immediately before provider effect. Bound sends no longer await an intervening `starting` lifecycle projection. A deterministic interleave at preparation verifies no provider start/send and preserved ready/running lifecycle. As always, a route mutation after the final in-process check or after a provider subprocess begins cannot be made atomic by this code; no cross-process atomicity is claimed.
- Bound callback bootstrap is refused before setup, Git worktree preparation, or message dispatch. Ordinary bootstrap remains covered.
- Late persisted incompatibility remains a clean typed rejection before provider start/stop side effects and does not poison retained ready/stopped lifecycle state.
- Cross-driver and cross-account continuation checks use authoritative registered instance metadata and continuation identity. No global lock, queue, framework, repeated polling, or unrelated-session mutation was introduced. The one startup list is an existing reconciliation input.
- Event attribution uses correlated message/event/turn identity or remains unknown; global latest-turn/completion timestamp is not used as sole attribution.

## Verification on exact 178bd96

- `vp test run apps/server/src/serverRuntimeStartup.reconcile.test.ts apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` — **3 files, 153 tests passed**.
- GitHub Actions run [36977328026](https://github.com/nullStack65/t3code/actions/runs/36977328026) reports completed success for exact head `178bd967ffde4d9ba7db660e88cecf38b5e0a361`; Check, Test, Test Server 1/2/3, Rust, Release Smoke, Mobile Native Changes, and native fingerprint checks succeeded. Preview/deploy and some platform analysis jobs were skipped.
- No separate typecheck or lint was run for this delta; full CI is green. No model, provider subprocess, live credentials, shared database, or browser was used.

The focused delta suite does not add a single end-to-end test that starts from startup repair and then resumes on two distinct instance IDs with a deliberately shared continuation key. The implementation composes the tested exact identity repair with the existing compatibility check; the test fixtures’ default continuation keys are instance-specific. I did not find a production correctness gap, but this is the remaining direct regression opportunity if maintainers want to pin that cross-instance-compatible case.

No installed Mac/Windows native-client runtime proof was available here. Native/platform protection remains pending actual installed-client verification by the owning workflow; CI checks are not that proof.

## Escalation and reviewer-routing readback

Parent/caller: `991c7c57-1fd8-4d23-bf96-9a60eaf8d3fa`; role `REVIEW`; assignment `ROUTEFIX:REVIEW`. The corrected policy is applied: Jeffrey’s prior approvals were genuine human actions and must be preserved; the user is the sole human reviewer for managed work; no other people are to be requested, assigned, notified, or made necessary approvers; authorized automated technical review remains allowed with honest attribution; required checks and human gates remain. No impersonation or account switch occurred.

This spawned session did not invoke human-facing question tools, create descendants, or own pending question cards. `collaboration.list_agents` returned only `/root`, with no descendants to steer. There is no worker-owned card to dismiss. The Networking Infisical card was dismissed by the sponsor; that does not mean login completed. ENVFIX owns auth coordination, and this review made no auth attempt. No tracked reviewer-routing/policy files were edited. A prior rejected formal review attempt belongs to the earlier 41c review record; this exact-head delta made no formal vote or reviewer request. The active CLI identity is `nullStack65`, so I did not publish a comment that would appear to be a human-authored result; this artifact is the attributed technical deliverable.
