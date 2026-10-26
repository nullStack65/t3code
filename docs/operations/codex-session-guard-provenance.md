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

| Block                  | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| execution-handoff      | `3a901f96de74ad60cab13f2805e5729dfc003ddfe6bed0a3027ed6a111d2a589` |
| original-assignment    | `b2eb034413fd84caeda306b0656b447a38ce8ade26dbc8719801d20242ead38a` |
| coordinator-correction | `3b8a51ebd856d74fd732219eeb2a7eb09d7637662ac2922f229aabdda24c8c3b` |
| repair-brief           | `d96f6dabbb682b6ebfb4d0e7e233d29bab499c8458314b259b99239ac22bf19d` |
| review-request-changes | `19e4225bdbf06f66d06fb416a4ebc5ed3f9a1688267bb7ca6a2da9d5a3c4242f` |

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

## Sanitization

Credential values, tokens, pairing URLs, session identifiers and personal
account details are excluded. Repository and pull-request locations are retained
because they are the provenance themselves.
