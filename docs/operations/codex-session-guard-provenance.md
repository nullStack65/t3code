# Codex session guard — provenance ledger

This file records how the Codex session-guard change was commissioned and
revised. The texts below were delivered to the implementation sub-agent by the
parent coordinator over the agent harness, or written by the independent
reviewer it instructed. **They are agent handoff, steering and review, not a
statement of human authorship or human approval**, and the root human did not
write them. Nothing here authorizes installing or activating a guarded provider
root: the approved scope is source only.

- Parent coordinator (collection, integration, publication): `mcp:422cda58-81be-4b86-ab34-0278ecd555c6`
- Implementation sub-agent: one isolated Mac-local writer, route
  `omp-local-acp` / `magpie-asus/magpie-go/deepseek-v4.1-flash` (mode `default`,
  thinking `high`), no nested delegation
- Independent reviewer: `omp-local-acp` / `magpie-asus/magpie-go/glm-5.3-flash`,
  read-only, findings recorded as a request for changes
- Isolated worktree: `~/.t3/worktrees/t3code/t3-0e507df5`, branch
  `feat/codex-session-guard-binding`, base
  `e97641abf69fb88538b53279ded28704b6ccb2b3` (default branch `main`); first
  candidate `c888400b7ee064ae5656a08e3e5d1640d2c05eb0`
- Reviewed upstream change this binds to: `closura-agent-config` PR #453, merged
  as `ad1c4c04`; it is not an object in this repository and was read from the
  delivery worktree

## Digest procedure

Each block is delimited by BEGIN/END markers and holds the text verbatim inside a
`text` fence. Its SHA-256 covers the exact bytes between the fence lines, as
recorded in this file. Recompute with:

````sh
python3 - <<'PY'
import hashlib, pathlib, re
text = pathlib.Path("docs/operations/codex-session-guard-provenance.md").read_text()
for name in (
    "execution-handoff",
    "original-assignment",
    "coordinator-correction",
    "repair-brief",
    "review-request-changes",
    "coordinator-instruction-round3",
    "parent-brief-round3",
    "coordinator-continuation-round4",
):
    body = re.search(
        "<!-- BEGIN:" + re.escape(name) + " -->.*?```text\n(.*?)\n```",
        text,
        re.S,
    ).group(1)
    print(name, hashlib.sha256(body.encode()).hexdigest())
PY
````

The digests pin the text as recorded here. They do not authenticate the original
transport, and they are not evidence of who approved anything.

| Block                           | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| execution-handoff               | `3a901f96de74ad60cab13f2805e5729dfc003ddfe6bed0a3027ed6a111d2a589` |
| original-assignment             | `b2eb034413fd84caeda306b0656b447a38ce8ade26dbc8719801d20242ead38a` |
| coordinator-correction          | `3b8a51ebd856d74fd732219eeb2a7eb09d7637662ac2922f229aabdda24c8c3b` |
| repair-brief                    | `d96f6dabbb682b6ebfb4d0e7e233d29bab499c8458314b259b99239ac22bf19d` |
| review-request-changes          | `19e4225bdbf06f66d06fb416a4ebc5ed3f9a1688267bb7ca6a2da9d5a3c4242f` |
| coordinator-instruction-round3  | `b2b2e6542bf166e84836d6eedc31df4c636def1198bac2f5af1480ff737c8dfe` |
| parent-brief-round3             | `8ea266e4606bd1a2af6de2eae454d796e2e8da56fe65baa365148d6bb6a41f72` |
| coordinator-continuation-round4 | `6ee7171a5283f172c0d4679c6d1ef7c8fda923e16dac4ac3f27986a194b63149` |

## Execution handoff

<!-- BEGIN:execution-handoff -->

```text
CFG-T3-BIND-1 implementation, ONE isolated Mac-local writer. Parent/return: mcp:422cda58-81be-4b86-ab34-0278ecd555c6 owns collection/integration; native task callback plus return exact candidate commit/tests/limitations. You are spawned: NEVER human question/request-input tools; blocker to parent only; NO nested delegation. Source-only; no model/provider probes, installed settings, Skills, credentials, live sessions, browser or host effects. Work only local Mac; no R720/VM103/ARC. No source PR by child; parent publishes. Commit result locally with exact SHA. Start base e97641abf69fb88538b53279ded28704b6ccb2b3, main is default, branch parent feat/config-fleet-t3-guard-20261025; verify actual isolated worktree/base/status first.

Qualified worker route: omp-local-acp, exact magpie-asus/magpie-go/deepseek-v4.1-flash mode default/thinking high through existing /Users/businessaccount/.local/bin/omp and local13425->ASUS3425 included Go; no paid fallback/new allowance/account/config changes. Existing source-route evidence https://github.com/nullStack65/closura-agent-config/pull/350#issuecomment-6403564927 and https://github.com/nullStack65/closura-agent-config/pull/451#issuecomment-6403494591 plus explicit web coordinator correction. Successful nineteen correlated provider rows establish existing route; remaining quota/exact session correlation unknown, do not invent. Stop on actual exhaustion/fallback/policy denial; no other models, implicit planner, MiMo or subscription fallback. Bound one candidate implementation + focused tests; parent owns independent GLM review.
```

<!-- END:execution-handoff -->

## Exact original assignment

Retained with agent-handoff provenance. The assignment frames itself as the
parent coordinator's transcription, and its "User instruction verbatim" line is a
coordinator quotation of the root human's instruction, not a signature.

The block below is the brief itself. The line `END exact original assignment.`
that previously appeared inside it was the parent's execution delimiter around
this brief, not part of the brief, so it now sits outside the block and the
digest above covers the brief alone. This is a correction of the recording, not
of the delivered text.

<!-- BEGIN:original-assignment -->

```text
CFG-T3-BIND-1 — source-only T3 Code implementation of an opt-in, fail-closed Codex session-guard integration for first Mac Crown-Rain-Gutters.local. Repo default is main, NOT master. Source PR #453 merged to closura-agent-config as ad1c4c04, supplies launch_provider.py/session_guard. Existing Mac T3 Code Beta0.1.2 directly launches /usr/local/bin/codex with CODEX_HOME override; this means unqualified for safe GitOps apply. Mac disposable-home idle npm and native Codex retained-fd tests passed, but abrupt parent, descendants, installed T3 binding and full session lifecycle not qualified. Existing CFG-LIVE-1 in agent-config handles setup-owner transfer, separate source and files.

Inspect exact T3 Codex spawn/MCP/fork/child chain and current repo rules. Implement narrow disabled-by-default opt-in for reviewed fenced launcher with explicit validated absolute device/state/source references; NO shell interpolation, silent environment stripping or broad Codex feature changes. All Codex processes consuming same managed Skill roots must obtain shared fence, holding full native session/process lifetime and fail-closed on unsafe child/descriptor behavior. Tests: no-model subprocess and fixtures for errors, path aliases, partial journal, abort/recovery, cleanup, restart, credential/env isolation; do not run provider model, change installed T3 settings, Skill roots, credentials or live sessions. If platform cannot support this with current architecture, deliver exact blocker and smallest safe PR, don't fake qualification.

User instruction verbatim: 'Status? Move work forward. Get this merged and green and deployed and healthy and monitored and such'. Work only Mac local. No R720/VM103/ARC runner unless qualified. One source PR with exact prompt ledger, focused offline tests and independent review; coordinate no duplicate writer. Source-only approval, NOT permission to install/activate live guarded root. Report back to issue Closura #1189 + CFG-LIVE-1 and OPS.
```

<!-- END:original-assignment -->

The earlier recording of this block carried digest `afbb2579f16bf7bbeda84e8ad294cc2ae65ec9002a1943eae88ebabc18585e46`; it covered the brief plus the delimiter line and is superseded by the digest above.

END exact original assignment.

## Coordinator corrections

The controlling-route correction, delivered after launch. The run retained the
existing Go route; no subscription, paid API or new writer was used, and no quota
claim is made. The described race is recorded as delivered: the root's
prospective allowance arrived after launch and was withdrawn and superseded
before it was relied on. The former position65 body digest
`b0770a2baa015bda9571a527370740c5fdc12ad451d6926ffabaeae83b96c7bb` is quoted from
that steering; this sub-agent did not read the parent's native user messages and
asserts nothing about their original wording beyond it.

<!-- BEGIN:coordinator-correction -->

```text
Material provenance correction for requested prompt ledger; no scope/model/work restart. ROOT sent a prospective task-local native subscription allowance after your launch, then withdrew/superseded it upon reading actual web coordinator correction and existing Go launch. Do not rely on that historical allowance. Current controlling route remains YOUR existing omp-local-acp/magpie-asus/magpie-go/deepseek-v4.1-flash mode default/thinking high; Go child sole implementation writer; parent coordination only. Existing independent review remains GLM on admitted Go route. Exact original root allowance + withdrawal are parent native user messages (ROOT identifies former position65 body digest b0770a2baa015bda9571a527370740c5fdc12ad451d6926ffabaeae83b96c7bb). Preserve race honestly in ledger/provenance, avoid invented native launcher identity; current external web coordinator is explicit. No subscription fallback, paid API, quota claim or new writer. Continue useful bounded work, no ACK needed.
```

<!-- END:coordinator-correction -->

## Repair round

The reviewer requested changes on `c888400b`, the parent accepted the P1
finding, and the same writer was asked to repair it. This block is the repair
brief as delivered, including its capacity note and the review instructions; the
same message also contained the full review, whose P1, P2 and verdict sections
are carried in the next block rather than duplicated here.

<!-- BEGIN:repair-brief -->

```text
ONE bounded capacity retry; previous repair task terminated with exact provider response 'magpie-go: 2 requests at once is its limit ... waited 15.0s ... try again shortly'. Parent reconciled terminal/no pending child and BOTH worktrees clean unchanged c888400b. No accepted source work replay, no fallback or new allowance. Same original admitted Go route/model/options only. If same capacity limit recurs return blocked; no internal retry loop or provider switch.

CFG-T3-BIND-1 repair follow-up to SAME sole Go implementation writer. Parent mcp:422cda58-81be-4b86-ab34-0278ecd555c6; original scope/route/no-human-questions/no-nested/no-model/no-live/no-remote/no-paid constraints remain. Continue in YOUR isolated /Users/businessaccount/.t3/worktrees/t3code/t3-0e507df5 branch feat/codex-session-guard-binding at c888400b7ee064ae5656a08e3e5d1640d2c05eb0. Parent fast-forward integrated same c888; parent no edits. Commit focused fix locally, return exact SHA/tests/limitations via native callback; no PR by child.

Independent GLM review REQUEST_CHANGES below. Parent accepts P1; preserve actual existing machinery, no generic new policy framework. Fix live settings transitions so enforcement changes retire existing driver-backed readers BEFORE declaring guarded policy effective/unavailable, and no subsequent sessions/probes/exec use stale closures. Reviewer recommends guard fingerprint in reconciliation identity via ProviderInstanceRegistryHydration, but verify actual schema/equality/lifecycle and async timing. A fingerprint-only identity may be inadequate for already retained references or concurrent startup; challenge it yourself, don't implement mechanically. Need a meaningful focused regression covering disabled-live -> enforce -> unavailable/refusal plus clean re-disable/restart and unrelated-provider stability; test at registry/hydration boundary with synthetic mocked spawns/drains, no real provider/session. Include relevant partial-journal/unhealthy fixture refusal if straightforward; never claim actual lifetime tests.

Correct internals claims accordingly, make scope driver-backed only and limitations exact, no host universal guarantee. Keep explicit reference validation because original user specifically requested validated absolute references; explain it supplies refusal diagnostics, NOT source authentication/qualification. Fix exact launcher middle-path check (must path.join(sourceRoot,company,agent-environment,config-delivery,launch_provider.py) equal launcher), a small correctness issue in current claimed validation. No source/hash qualification claim from basename/depth/JSON only. Docs currently say future change 'stop injecting CODEX_HOME': replace with narrowly qualified exact-root support upstream; must NOT imply clearing/stripping user's existing home override is acceptable. Original guard remains refusal and no launcher spawn admitted.

Provenance ledger says exact original assignment but includes 'END exact original assignment.' INSIDE original source text; that marker was a parent execution delimiter, not part of initial brief. Move delimiter outside original block/remove it, recompute digest honestly and append repair/review prompt provenance (agent-authored). Do not rewrite preserved prior route-race facts or label agent text human authored. Full parent transcript available if needed via native tools, no fabricated exact source. Keep plans/scratch out of repo, only requested ledger.

Test only changed focused files + relevant targeted server/contracts typecheck/lint/fmt; three already established baseline driver alias failures need not repeatedly rerun unchanged broad suite or fix unrelated maintenance.
```

<!-- END:repair-brief -->

## Independent review findings (request for changes)

The reviewer's P1, P2 and verdict sections, verbatim from the review delivered
with the repair brief. The rest of that review (identity verification, test
verification, further findings and limitations) is summarized where it affects
this change and is not reproduced here.

<!-- BEGIN:review-request-changes -->

```text
## P1 — `enforce` does not apply to already-created instances (suspected hole confirmed)

**Trace (deterministic, statically verified):**

1. The only admission point is inside `CodexDriver.create` (`apps/server/src/provider/Drivers/CodexDriver.ts:145-169`), which runs once per instance materialization. Session app-servers, status/Skills probes, text generation, and maintenance spawn later from closures on the built instance (`makeCodexAdapter`, `checkProvider`, `resolveMaintenance` in the same file) with no re-admission.
2. On any settings change, `ProviderInstanceRegistryHydration.ts:118-131` calls `mutator.reconcile(deriveProviderInstanceConfigMap(next))`. `deriveProviderInstanceConfigMap` (`ProviderInstanceRegistryHydration.ts:69-100`) derives envelopes **only** from `settings.providerInstances` and legacy `settings.providers` — `settings.codexSessionGuard` is not part of any envelope.
3. `reconcile` (`ProviderInstanceRegistryLive.ts:226-240`) treats an instance as replaced only when `entryEqual(live.entry, nextEntry)` fails. Flipping `codexSessionGuard.mode` from `disabled` to `enforce` leaves every envelope structurally unchanged → no-op → live Codex instances are never rebuilt.

**Reproduction flow:** server starts with guard disabled, Codex instance live → operator patches `codexSessionGuard={mode:"enforce",…}` → reconcile no-ops → next session start/refresh/maintenance spawns `codex` unguarded. This is the realistic activation flow (enrolling a host whose server is already running) and it directly breaks the stated contract ("enrolled hosts must never fall back to an unguarded launch"). At-boot enrollment is safe (create refuses → unavailable, probes never run). Reverse direction is fine: failed creates are retried on every reconcile, so reverting to `disabled` recovers.

**Smallest safe fix (for the next delegated round):** make the guard part of reconcile identity so any mode change replaces instances — e.g. thread `codexSessionGuard.mode` (or a guard-policy fingerprint) into the Codex instance envelope in `deriveProviderInstanceConfigMap`. Rebuild under `enforce` then hits the create gate and the instance lands in `unavailable` with the refusal detail; rebuild under `disabled` recovers. Do not re-check at each spawn point — that is a larger change and the envelope fix reuses existing rebuild machinery.

**P2 — docs overclaim (must be corrected with the same round):** `docs/internals/codex-session-guard.md` §"Where the gate applies" states "Every T3-owned Codex process is constructed from that instance, so one check covers all of them." False for post-create spawns after mid-flight enrollment (the P1). §"Operating it" ("Reverting to `disabled` restores the legacy path on the next instance rebuild") is accurate.

## Verdict: REQUEST_CHANGES

Scope: the P1 reconcile-identity fix and the internals-doc correction in one small follow-up commit on the same branch. Everything else — contracts schema, fail-closed semantics, refusal-before-write ordering, tests, provenance ledger — is sound and verified. No human approval claimed or sought; no comments, PRs, or watchers touched. Parent owns revision round: a fresh delegated review is required for the fix per the standing protocol.
```

<!-- END:review-request-changes -->

## Repair outcome

Agent-authored, not approval: the reconciliation identity now carries a per
instance Codex guard fingerprint derived in `ProviderInstanceRegistryHydration`,
reconcile retires a replaced instance's readers before building its replacement
and publishes only afterwards, the launcher check pins the exact reviewed path
inside `sourceRoot`, and the internals page now scopes the guarantee to
driver-backed processes with the remaining in-flight limitation stated. The
independent review of this repair is a separate round owned by the parent.

## Enrollment-contract round (startup latch)

The next bounded source round replaced the hot-transition repair from
`e25859e396` after source evidence showed a detached Codex session cannot be
retired by closing a registry entry. The coordinator instruction is reproduced
verbatim; the parent's operative brief for this round follows it.

Agent-authored outcome, not approval: the guard policy is now boot-latched in
the settings service, hot API patches fail with `restart-required` before
secrets, file writes or emission, a file edit is kept pending on disk and only
read at the next start, and the per-instance reconcile identity added in `e258`
was removed because it could not make a running session safe.

<!-- BEGIN:coordinator-instruction-round3 -->

```text
Latest literal user request: "Status? Move work forward. Get this merged and green and deployed and healthy and monitored and such". I read your completed #47 e25859e3 source-only checkpoint and exact limitations. Do not wait idle for CI settings if necessary source work toward actual first-device qualification can proceed locally. Continue the SAME ownership lane with the next bounded SOURCE-ONLY repair: determine and implement the smallest safe lifetime/admission contract for (a) no new/in-flight spawn crossing an enforcement transition and (b) existing detached sessions not silently escaping the configuration fence. Keep guard disabled by default, preserve explicit CODEX_HOME incompatibility until a reviewed supported binding exists; do not strip env or pretend construction refusal is full fencing. Prefer an explicit quiescent-start/enrollment prerequisite if architecture cannot safely guard already-active sessions; don't kill/interrupt live user sessions or install anything. Implement only when source evidence supports a bounded repair and validate real local process lifecycle/fixtures without model inference. Use existing canonical admitted coding/reviewer workflow and current owner; no duplicate competing writer, no new paid route or native-subscription fallback if local instructions prohibit it. Existing reviews/test receipts remain preserved; review only actual changed scope once. Preserve exact user prompt in any changed PR. Repo Actions intentionally disabled: no policy/settings/grants change, no R720/VM103/ARC dispatch, no merge bypass and no claim CI green. Local check equivalence may be recorded honestly but isn't remote CI. Distinguish a technical prerequisite in another source owner from policy/access blockers; coordinate only specific missing contract with CFG-LIVE owner if needed. Return actual next source result or precise bounded architecture requirement if implementation isn't viable; not another unchanged #47 status recap. OPS owns deployment separately. This instruction authorizes source work toward the existing goal, not live installation/enrollment or a broad T3 redesign.
```

<!-- END:coordinator-instruction-round3 -->

<!-- BEGIN:parent-brief-round3 -->

```text
Prior context: source PR47 c888 guard always refused construction, r1 GLM found hot-mode bypass. e258 adds guard-policy identity to registry replacements; r2 GLM PASS_WITH_LIMITATIONS only construction boundary. Both full reviews public PR47#6406733666 and #6406734228, no acceptance of live enrollment. Real Codex session scopes detached in CodexAdapter.ts Scope.make transfer. Thus active process survives registry close; start past lookup can spawn after enforce; registry tests with fake finalizer don't prove actual reader teardown. These are exact supported technical gaps, not billing/access blocks. Source cannot activate upstream guard anyway (CODEX_HOME refusal/descriptor qualification).

New task: determine smallest safe admission/lifetime contract closing unsafe hot-transition claim. Prefer an explicitly startup/quiescent-enrollment-only policy if active-session safe transition cannot be implemented narrowly; NO kills/interruption of live users, broad adapter redesign or fake health boolean. A startup policy may be immutable per server lifetime, reject hot policy changes before writes/secrets/emit, and consistently handle external file reload/cache/read paths so callers never observe 'enforce accepted' while stale sessions are allowed. You must trace actual startup/cache/settings/watcher lifecycle and all instance reconstruction callers; do not mechanically implement this suggestion without evidence. If safe startup latch/readback requires broader redesign, return exact bounded architecture requirement with no invented quiescence proof. Rejecting hot API patch alone is NOT sufficient if file watcher/cache/driver reads change effective policy. Never confuse settings file value with effective runtime enforcement. Startup enforced mode still refuses all provider construction; startup disabled does not become safely enrolled by changing files. Existing external/native process quiescence cannot be proven by ordinary restart; retain explicit operator/upstream qualification prerequisite, no fake installed safety.
Alternative smallest source-supported per-spawn admission and lifetime leases may be viable if existing owner can serialize with settings; weigh realistically, no framework expansion. Need no in-flight spawn crossing an EFFECTIVE enforce transition, existing detached sessions never silently labeled guarded. Could safe refuse transition until quiescence instead of forced stopping. Parent does not prescribe implementation architecture.

Inspect .repos/effect-smol/LLMS.md before Effect changes. Focused regression should exercise actual settings update/reload vs pending/in-flight synthetic subprocess and active reader, observing spawn/no-spawn/refusal and normal cleanup/restart. Use owned PIDs and event/receipt waits, no sleeps/pattern kills, no real userdata copied. If cannot qualify actual lifecycle use exact test/coverage limitation; do not mirror code mocks and call lifetime proven. Proportionate targeted test/typecheck/lint/fmt only, no repo-wide checks or repeat baseline alias reruns. Update exact docs/ledger only affected scope, maintain prior findings/history. Do not post/edit PR: parent owns publication plus ONE fresh independent GLM review of actual delta before push. Return exact committed head, changed scope, meaningful commands/results, current blockers and upstream contract need. No duplicate writer, restart or provider route changes.
```

<!-- END:parent-brief-round3 -->

## Startup-decode correction round

The parent rejected the previous review's characterization of the boot fallback
as fail-safe: a whole-document decode failure discarded a valid explicit
`codexSessionGuard.mode = enforce` and latched disabled, which is fail-open for
an opted-in host. The coordinator continuation is reproduced verbatim; the
quoted `END` delimiter was the parent's execution delimiter, not part of the
text.

Agent-authored outcome, not approval: the loader now reads the guard block
independently when the whole document is rejected (valid block honored, invalid
block becomes the fail-closed refusal policy, absent block keeps the disabled
default, non-JSON stays unverified), and the pending-file preservation caveat is
documented.

<!-- BEGIN:coordinator-continuation-round4 -->

```text
Continuation from explicit current user: 'Status? Move work forward. Get this merged and green and deployed and healthy and monitored and such'. Cloudflare central config-fleet staging release0bfc is deployed at 100%, source stack merged #1191 etc, PR1354 parser correction merged a1f2e2ac. First actual Mac device NOT enrolled; your existing T3 source candidate bc8773b2 (held locally) is still required to qualify safe startup policy. This is NOT a new implementation owner.

Resume existing CFG-T3-BIND-1 sole source lane WITHOUT duplicate Go workers. Confirm serialized Go slot return with MAGPIE-1:LEAD mcp:b8a01b14-287c-4bd3-9b5e-e1f52173dbb9 and SETAUD. If slot available and original qualified included-only OpenCode Go source route still admitted, ask SAME prior writer to repair *only* validated remaining bug: full settings decode failure at startup discards valid explicit enforce and latches disabled; preserve fail-closed; add no-model regression + docs pending-file caveat. Single independent proportional review on corrected head, normal PR47 nonforce update, no live install. If capacity/route unavailable do not use subscription/purchase/fallback, report exact blocker and return slot. Preserve source boot/quiescence caveat; never claim full Codex lifetime guard with detached sessions. No R720/VM103 or unqualified CI; t3code Actions intentionally disabled, don't enable policy. Deliver exact source PR delta/result to issue1189; no repeat settled old review.
```

<!-- END:coordinator-continuation-round4 -->

## Sanitization

Credential values, tokens, pairing URLs, session identifiers and personal
account details are excluded. Repository and pull-request locations are retained
because they are the provenance themselves.
