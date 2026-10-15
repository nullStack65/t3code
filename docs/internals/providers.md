# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Governed Skill admission is a separate route

The reserved `codex-typed-skills` driver is a **refusal-only** input contract. It
accepts an offline candidate reference under `providerInstances.<id>.config`:

```json
{
  "driver": "codex-typed-skills",
  "config": {
    "candidate": {
      "directory": "/disposable/candidate",
      "sourceRepository": "nullStack65/closura-agent-config",
      "sourceCommit": "<40 lowercase hex characters>",
      "admissionSha256": "<64 lowercase hex characters>"
    }
  }
}
```

These fields identify a request; they authenticate neither source nor route. The
[driver](../../apps/server/src/provider/Drivers/CodexTypedSkillsDriver.ts) refuses
before reading the candidate, materializing a home or returning any runtime,
discovery, authentication or text-generation capability. The registry publishes
an unavailable snapshot with empty models/skills. Its typed failure carries
`admissionAuthorized: false` and `reason: native-boundary-unqualified`; this is a
denied request, **not** an observed process/session/turn, signed attestation or a
receipt suitable for positive route admission. Process identity, principal,
served model, generation, effort, billing, availability, pin and fallback facts
are unobserved on this refused route. Candidate, task, owner, attempt, freshness
and effect claims cannot supply them. No candidate content enters model context.

A distinct driver kind matters across versions: builds without it retain the
existing unknown-driver refusal. An optional field added to legacy Codex settings
could instead be discarded by an older schema. Never translate this driver to
`codex` as a compatibility fallback. Legacy Codex and other providers remain
ungoverned by this contract; selecting them is not governed activation.

The legacy Codex adapter exposes a server-local `nativeObservation(threadId)`
reader as an admission prerequisite. The runtime binds its spawned PID and fresh
process generation to the owned stdio transport, initialization, opened provider
thread and correlated turn response. Requested model/tier and provider-reported
session model remain distinct from the unknown actual served model, generation,
principal, harness build, billing, effort and fallback. It records no home,
credentials or prompt content and changes no provider configuration.

`capture(candidate)` binds an immutable request reference to the current
observation; `resolve(capture, candidate)` consumes the original in-memory handle
once, within five seconds, and refuses candidate or lifecycle drift. Serialized
copies and handles from another runtime cannot establish provenance. New turns,
route/model events, session/process closure, compaction and rollback revoke prior
captures; compaction/rollback never attest that old instructions were erased.
This is not a portable signed receipt or an exposed model/client RPC. Even current
known-fact evidence returns `admissionAuthorized: false`: source/assignment
authority, context containment and exclusive Skill discovery/read/invocation
remain unqualified. An absent observer on an older runtime stays absent. No
agent-config positive consumer or installation may infer eligibility from it.

Positive support requires an independently trusted bridge to the canonical typed
policy/source admission, actual per-process/turn route observation, exclusive
discovery and every body/read/expansion path, and invalidation of retained context
on request/model/generation/principal/harness/freshness changes. Offline session
JSON, hashes, login metadata and the agent-config PR371 consistency predicate do
not establish those capabilities or grant permissions. The agent-config runtime
activation refusal must remain until those boundaries are implemented and
independently qualified; the candidate reference above is not a consumer-enabling
contract.

Codex 0.162.1's supported `app-server generate-json-schema --out <fresh-directory>`
exports `skills/list` with `cwds`/`forceReload` and `skills/extraRoots/set` with
`extraRoots`. The latter is additive. Neither schema offers exclusive discovery
or complete interception of native Skill expansion and arbitrary tool reads.
Shadow homes share `skills` and `plugins`; ordinary full-access tools can read
other source locations. Root enumeration/filtering cannot establish containment.
The focused registry tests prove refusal and absence of capabilities, including
reconciliation and old-build refusal. They do not prove positive Amnesia
discovery/invocation, model-patch generation expiry, semantic request recognition,
or installed/runtime behavior on Mac, Windows or Linux.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
