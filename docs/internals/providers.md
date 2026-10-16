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

## Governed Skills use a separate route

`codex-typed-skills` keeps selected-model policy separate from legacy Codex.
Configure its `launch` with ordinary `codex` settings and a `source` containing an
absolute canonical checkout `directory`, clean immutable `sourceCommit`, `pythonPath`,
selected `provider` namespace, `principal: { id, emailSha256 }`, and `generations`
map from exact selected model IDs to explicitly qualified generation IDs. The
operator must authorize that exact source and principal mapping. This is server
configuration, not model-provided input; a hash alone does not authenticate source.
Existing offline `candidate` references without `launch` still refuse before
reading files or starting a provider. Older builds reject this driver kind rather
than silently dropping a policy flag. Never translate it to legacy `codex`.

The [consumer](../../apps/server/src/provider/CodexSkillConsumer.ts) runs the pinned
canonical `scripts/build_skill_session.py --context/--output` and `--verify` for
discovery, startup and the current request. It checks the source head/clean tree,
returned context, admission and content digests, then supplies only positive load
paths as supported native Skill inputs alongside generated AGENTS instructions.
Compatibility patches stay outside the candidate's ordinary discovery root.
Discovery metadata can match a current natural-language request; it does not grant
permission. Quoted or historical mentions and bound agent callbacks do not select
request-only Skills. Matching is conservative and source-description based, not a
universal natural-language classifier.

The runtime uses its owned PID/stdio/thread observation, current selected model
acknowledgment, actual executable version and supported `account/read` response.
A configured email digest maps that account to a policy principal without logging
account data. A mismatched or unknown account excludes user-scoped apps. Unknown
selected generation or mismatched model acknowledgment excludes patches while
model-neutral apps can remain eligible. These facts do not attest the actual
served model, served effort, billing or fallback, and do not grant tool effects.
The PR33 observer's portable-admission result remains denied; this consumer does
not turn its unknown fields into positive PR371 evidence.

Every governed request opens a new provider thread and never resumes old provider
context, including after source/model changes. It reprojects prior visible user
and assistant text as attributed conversation data, preserving task corrections
and reported status. It omits hidden system/developer frames and old Skill inputs.
Missing current-message identity or oversized visible history refuses rather than
silently dropping the conversation. Earlier attachments are not replayed. A source
or observed lifecycle change during resolution refuses; already consumed request
IDs cannot be retried in that runtime. Accepted T3 history is preserved.

This route governs the inputs T3 constructs, not arbitrary filesystem reads or all
provider discovery. Codex 0.162.1's `skills/extraRoots/set` is additive; shared homes,
plugins, repository instructions and full-access tools remain unmanaged. Keep
compatibility patches out of those roots. Config CLI receipts remain
`runtime-admission-candidate`, with installed and behavior-verified false; building
or verifying a candidate is not installed/model behavior acceptance. Legacy Codex,
other providers, delegated children and maintenance text generation are outside
this governed turn path. No live provider configuration or installation is changed
by adding the source implementation.

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
