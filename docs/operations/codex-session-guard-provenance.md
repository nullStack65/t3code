# Codex session guard — provenance ledger

This file records how the Codex session-guard change was commissioned. The texts
below were delivered to the implementation sub-agent by the parent coordinator
over the agent harness. **They are agent handoff and steering, not a statement of
human authorship or human approval**, and the root human did not write them.
Nothing here authorizes installing or activating a guarded provider root: the
approved scope is source only.

- Parent coordinator (collection, integration, publication): `mcp:422cda58-81be-4b86-ab34-0278ecd555c6`
- Implementation sub-agent: one isolated Mac-local writer, route
  `omp-local-acp` / `magpie-asus/magpie-go/deepseek-v4.1-flash` (mode `default`,
  thinking `high`), no nested delegation
- Isolated worktree: `~/.t3/worktrees/t3code/t3-0e507df5`, branch
  `feat/codex-session-guard-binding`, base
  `e97641abf69fb88538b53279ded28704b6ccb2b3` (default branch `main`)
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
for name in ("execution-handoff", "original-assignment", "coordinator-correction"):
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
| original-assignment    | `afbb2579f16bf7bbeda84e8ad294cc2ae65ec9002a1943eae88ebabc18585e46` |
| coordinator-correction | `3b8a51ebd856d74fd732219eeb2a7eb09d7637662ac2922f229aabdda24c8c3b` |

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

<!-- BEGIN:original-assignment -->

```text
CFG-T3-BIND-1 — source-only T3 Code implementation of an opt-in, fail-closed Codex session-guard integration for first Mac Crown-Rain-Gutters.local. Repo default is main, NOT master. Source PR #453 merged to closura-agent-config as ad1c4c04, supplies launch_provider.py/session_guard. Existing Mac T3 Code Beta0.1.2 directly launches /usr/local/bin/codex with CODEX_HOME override; this means unqualified for safe GitOps apply. Mac disposable-home idle npm and native Codex retained-fd tests passed, but abrupt parent, descendants, installed T3 binding and full session lifecycle not qualified. Existing CFG-LIVE-1 in agent-config handles setup-owner transfer, separate source and files.

Inspect exact T3 Codex spawn/MCP/fork/child chain and current repo rules. Implement narrow disabled-by-default opt-in for reviewed fenced launcher with explicit validated absolute device/state/source references; NO shell interpolation, silent environment stripping or broad Codex feature changes. All Codex processes consuming same managed Skill roots must obtain shared fence, holding full native session/process lifetime and fail-closed on unsafe child/descriptor behavior. Tests: no-model subprocess and fixtures for errors, path aliases, partial journal, abort/recovery, cleanup, restart, credential/env isolation; do not run provider model, change installed T3 settings, Skill roots, credentials or live sessions. If platform cannot support this with current architecture, deliver exact blocker and smallest safe PR, don't fake qualification.

User instruction verbatim: 'Status? Move work forward. Get this merged and green and deployed and healthy and monitored and such'. Work only Mac local. No R720/VM103/ARC runner unless qualified. One source PR with exact prompt ledger, focused offline tests and independent review; coordinate no duplicate writer. Source-only approval, NOT permission to install/activate live guarded root. Report back to issue Closura #1189 + CFG-LIVE-1 and OPS.
END exact original assignment.
```

<!-- END:original-assignment -->

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

## Sanitization

Credential values, tokens, pairing URLs, session identifiers and personal
account details are excluded. Repository and pull-request locations are retained
because they are the provenance themselves.
