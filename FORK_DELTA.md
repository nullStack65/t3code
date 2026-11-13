# Fork delta and retention inventory

This is the bounded source inventory for the fork decision in [CLO-805](https://linear.app/closura/issue/CLO-805/agent-practices-adoption-remainder-t3air-connectivity-check-shared-air). It implements the November 13, 2026 5:52 PM ET request, preserved as a **reported transcription** by the assignment owner: “do we want our pre-existing fork? We need to maintain a list of every change/feature/fix/etc ours has that vanilla doesnt.” The acceptance criteria are complete source-lineage accounting, a failing check for unlisted effects, synthetic Git negatives, and an event-driven weekly upstream report. None of these is merge, installation or activation authorization.

## Recommendation and current need

**Retain a thin reviewed fork, using official v0.1.2 as the requested candidate base, rather than dropping the fork or replaying its entire history.** The current fork contains useful safeguards without exact patch matches in upstream, but fork main is not the installed Crown version. Preserve AssemblyAI and qualify native eventwait, owned-worktree and review-routing safeguards individually. Reuse upstream implementations when behavior is already covered; stable patch identity establishes patch equivalence, not behavior correctness. The preservation reasons below are source-grounded retention candidates, not a claim every historical implementation must be replayed.

Air already uses a newer upstream-based v0.1.9 lineage. A v0.1.2 build must pass explicit schema/feature compatibility before any host change, or the owner must choose a newer common base for all hosts. Do not downgrade Air blindly. The intended delivery is one reviewed source revision/logical build with platform-specific artifacts, never an assertion that different architectures have identical binaries. This inventory changes no application runtime.

The strongest current retention reasons are lossless resume/callback behavior, owner-only human review, isolated coding worktrees, typed Skill launch binding, and Air's required speech provider. Usage attribution is a separate measured-data capability (its own docs explicitly leave live qualification false); release provenance is needed only if the fork continues shipping. Windows service code is an unqualified platform candidate, not a reason to install T3 on R720. A clean merge or historical fixture repair is history to preserve, not an independent feature to replay. Each candidate still needs parent review and feature-specific acceptance on the selected common base.

## Exact sources and comparison method

Captured November 13, 2026 at 22:58:53 UTC; the remote API and local fetch agreed on these refs:

| Source | Exact commit | Meaning |
| --- | --- | --- |
| Fork main | `05993d81acd2eec0081e2b396bc52bc993bb2bf3` | Starting source for this PR; after earlier `569116e95c647cc1bfbd9f3132ca39d0e68f3d3a` |
| Official v0.1.2 | `044f07257c9684ae4543bd1e1ebf9c394e9e3830` | Exact requested official tag; Crown build source reported by parent |
| Upstream main | `08b8689a856bb282350bbb30c94e5d8cd22fec7a` | Fresh `pingdotgg/t3code` main snapshot, not a floating acceptance baseline |
| ASUS runtime source suffix | `f014905ed1c73600310accc6d2bc378c9d5c7840` | One custom source commit over upstream ancestor `e6ae764f47d678b96f4a1b2c8c76eedf1a342e26` |
| Air custom branch | `083270eb523fd7742b5e1490de042089e1aa7ffc` | `feat/assemblyai-current`, parent `1a4a29998be205ad8fbb8dd6eefc2a730f025ca5` on `release/assemblyai-base` |
| Local CLO-802 candidate | `ec444939d7eb67eaeb632a6b7082e14ed5be433c` | Two commits on official v0.1.2; local source snapshot, unpublished |

The checker enumerates **every** commit in `reference..lineage`, compares stable patch IDs with rename detection disabled, and binds listed identities to exact commit, parents and tree. Merge commits have no ordinary single-parent patch ID: their exact trees/parents remain listed, and unknown conflict resolutions fail. An unlisted two-parent merge is allowed only when `git merge-tree --write-tree` succeeds without conflict and exactly reproduces its tree, and every parent effect is independently covered. This handles GitHub's synthetic PR merge candidate without accepting a new resolution patch. Imported commits already reachable from the other pinned official reference are identified as upstream ancestry, not custom code.

The machine section lists all custom source entries, full patch IDs and source evidence. The readable rows below cover each of the 69 fork-main commits, ASUS's one custom commit, Air's one custom commit, and both local eventwait commits. Later upstream-only imports in Air are reproducible with `git rev-list 044f07257c9684ae4543bd1e1ebf9c394e9e3830..1a4a29998be205ad8fbb8dd6eefc2a730f025ca5`; they are all reachable from the pinned upstream main and are not additional Closura features. Ancestry and patch counts are distinct. No title match is treated as upstream proof.

Stable identity misses semantic rewrites, partial backports, configuration and binary overlays. The per-row reasons derive from changed source and existing operation/provider documentation. A missing exact match is **unique-or-manual**, not proof upstream has no equivalent feature. Current upstream contains orchestration MCP tools, including `OrchestratorMcpService.ts`; fork main has no `orchestrator_capabilities` occurrence under `apps/server/src`. Neither official source snapshot exposes the candidate's next-event tool. Those observations support selective forward-porting; they do not establish general feature parity or fleet compatibility.

## Comparison counts at the pinned sources

| Lineage | Commits absent from official v0.1.2 ancestry | Commits absent from upstream-main ancestry | Exact patch matches in either | Accounting |
| --- | ---: | ---: | ---: | --- |
| Fork main | 69 | 69 | 1 in each | 62 non-merge commits (61 unmatched + 1 upstream match), 7 merges |
| ASUS f014 | 1 | 1 | 0 | Single custom patch; partial source coverage in main, as explained below |
| Air AssemblyAI head | 3,679 | 1 | 0 custom matches | 3,678 later-upstream ancestors plus 1 custom AssemblyAI patch |
| Local eventwait candidate | 2 | 2 | 0 | Unpublished implementation + parser-dependency test correction |

There are **71 distinct enforced source identities** across fork main/ASUS/Air, plus **2 distinct local-candidate snapshot identities**. Counts describe source refs before this inventory PR's maintenance commit. The maintenance commit is covered by exact content hashes; candidate/merged-head counts will therefore be higher. This is not a count of 71 unique product features.

## Source inventory

In the following rows, `U` means absent by ancestry and without an exact stable-patch match against **both** pinned official references; semantic coverage still needs assessment. `M` means merge tree/parents retained, not a separate feature. `P` means unpublished local proposal. Reasons are the retention argument, not approval. `retain-candidate` means preserve for qualification, `retire-candidate` means no standalone replay, and `proposal` means not accepted for rollout.

| Commit / source | Change and reason / current disposition | Coverage |
| --- | --- | --- |
| [`bcc1a58b19`](https://github.com/nullStack65/t3code/commit/bcc1a58b19a9d610a4f08fed191a364767bc65b3) (fork main) | **feat: allow disabling AI-generated thread titles (#3)**. Allow the user to disable AI title generation; reactor and settings respect the preference rather than starting unwanted text generation. Disposition: `retain-candidate`. | U |
| [`95a3db45c6`](https://github.com/nullStack65/t3code/commit/95a3db45c6b8795976811c98019f7732601220f2) (fork main) | **feat(usage): prove prompt, request, session, and PR usage attribution**. Project measured transcript metadata onto prompt/request/session/PR levels; mark unsupported granularity instead of inventing requests. Disposition: `retain-candidate`. | U |
| [`ee732edd0e`](https://github.com/nullStack65/t3code/commit/ee732edd0edc771c60ce3629569c9fe16ff9ae05) (fork main) | **fix(usage): report absent request counts as null, not zero**. Keep missing request counts null; zero would falsely imply a measured absence. Disposition: `retain-candidate`. | U |
| [`db1a3db830`](https://github.com/nullStack65/t3code/commit/db1a3db830ff903e5cf298f5f8c5f56c82c904fb) (fork main) | **test(usage): assert the allocation reconciliation invariant**. Assert allocation reconciliation so attributed totals cannot silently exceed or lose the measured input. Disposition: `retain-candidate`. | U |
| [`f36f413518`](https://github.com/nullStack65/t3code/commit/f36f413518025df386ef58944b7cdaffa4121117) (fork main) | **feat(release): add fork release pipeline with fork update isolation**. Separate fork update/release identity from upstream publication and package provenance per target. Disposition: `retain-candidate`. | U |
| [`8936942087`](https://github.com/nullStack65/t3code/commit/89369420870a3086051fb01462193c805ecc2aaa) (fork main) | **docs(release): document blocking WinGet pin for retained package identity**. Document the retained package identity WinGet pin that must be cleared before promotion. Disposition: `retain-candidate`. | U |
| [`df8aceb5f8`](https://github.com/nullStack65/t3code/commit/df8aceb5f8441305d61f8de17c6a0763b37b096c) (fork main) | **fix(release): bind source/provenance, freeze-and-promote candidates, gate runners**. Freeze source-bound candidates and verify manifest/WSL payload provenance before promotion; runner admission remains explicit. Disposition: `retain-candidate`. | U |
| [`d1dd682198`](https://github.com/nullStack65/t3code/commit/d1dd6821987dab544577d01826b2a4a1a81b9c04) (fork main) | **fix(usage): retain legacy cache history and record measurement presence**. Retain legacy scan history and distinguish unavailable measurements from explicit zero values. Disposition: `retain-candidate`. | U |
| [`e4f36af5ef`](https://github.com/nullStack65/t3code/commit/e4f36af5ef279246bcb0f8463adeee8a09b7bde1) (fork main) | **fix(usage): reconcile attribution and prove persisted bindings**. Extract persisted session and PR bindings into the pure attribution projection rather than guessing links. Disposition: `retain-candidate`. | U |
| [`d1e09ad152`](https://github.com/nullStack65/t3code/commit/d1e09ad1524913fa46264ad41d3a6c9a13e8c61a) (fork main) | **fix(release): executable per-target candidate route, bound receipts, gated promotion**. Make each platform candidate executable independently, bind receipts and gate aggregate promotion. Disposition: `retain-candidate`. | U |
| [`948bbb3497`](https://github.com/nullStack65/t3code/commit/948bbb3497302bf5a9c4a94a11dcd440e1cddca7) (fork main) | **fix(release): per-target verification must not require the aggregate manifest**. Allow per-target verification before an aggregate manifest exists without skipping target checks. Disposition: `retain-candidate`. | U |
| [`ef22053422`](https://github.com/nullStack65/t3code/commit/ef2205342298ee7ff602abccca9b0cbadc7f8607) (fork main) | **fix(release): reach the real NSIS app payload for embedded-WSL verification**. Inspect the actual nested NSIS application payload, not a convenient outer executable. Disposition: `retain-candidate`. | U |
| [`f652cc2710`](https://github.com/nullStack65/t3code/commit/f652cc271012556a02f25763f98d9c3467d77833) (fork main) | **fix(release): installer provenance is the embedded WSL runtime**. Identify the embedded WSL runtime as Windows installer provenance rather than the installer wrapper. Disposition: `retain-candidate`. | U |
| [`daa55eb889`](https://github.com/nullStack65/t3code/commit/daa55eb88966665faa8c1770c35fc3c53a68f6fa) (fork main) | **fix(usage): finish measurement and cache correctness**. Complete measurement/cache quality handling at parser, projection and service seams. Disposition: `retain-candidate`. | U |
| [`1be979bb3a`](https://github.com/nullStack65/t3code/commit/1be979bb3af8ffbe1a40517678f928ab9795707c) (fork main) | **fix(release): inspect real desktop/DMG provenance and fail closed**. Inspect desktop bundles and DMG content and fail closed when package provenance is missing. Disposition: `retain-candidate`. | U |
| [`23e52963cf`](https://github.com/nullStack65/t3code/commit/23e52963cfc9799fba70e458b39507d130e0e334) (fork main) | **fix(release): carry digest-bound inspection evidence through the local route**. Carry digest-bound inspection evidence through local build/stage/verify handoffs. Disposition: `retain-candidate`. | U |
| [`929b63795e`](https://github.com/nullStack65/t3code/commit/929b63795e7696855ada61de5fd359dc2f51da78) (fork main) | **fix(release): do not stage the optional arm64 DMG unless requested**. Do not stage an arm64 DMG unless explicitly requested; absent optional targets are not required assets. Disposition: `retain-candidate`. | U |
| [`af70495442`](https://github.com/nullStack65/t3code/commit/af70495442678a06e007d13bba477f123170c0f5) (fork main) | **fix(usage): preserve zero-total quality and refresh stale cache rows**. Preserve measured zero/invalid quality and refresh stale scan-cache rows; zero is data, not an empty record. Disposition: `retain-candidate`. | U |
| [`f863939bcd`](https://github.com/nullStack65/t3code/commit/f863939bcd52b49f238982f593ea34c146f80e28) (fork main) | **fix(usage): persist scan-cache predecessor freshness across restart**. Persist predecessor freshness across restart so a restarted scan does not accept stale cached attribution. Disposition: `retain-candidate`. | U |
| [`30241b1fc6`](https://github.com/nullStack65/t3code/commit/30241b1fc654b3359d4d94b58751f4e0a8040749) (fork main) | **feat(usage): retain durable model-canary attribution across resumes**. Persist provider session history and route events so model-canary attribution survives resumes and route changes. Disposition: `retain-candidate`. | U |
| [`3a1047a164`](https://github.com/nullStack65/t3code/commit/3a1047a16497f975aba46617f894ce49455ab8b0) (fork main) | **test(usage): prove the route view preserves M3D zero/invalid/cache quality**. Test route-view preservation of zero, invalid and cached measurement quality. Disposition: `retain-candidate`. | U |
| [`93a74a5b91`](https://github.com/nullStack65/t3code/commit/93a74a5b9126766a1b4dcf9aaf0afe0e98270984) (fork main) | **fix(release): stage the Windows resource monitor before the CLI archive**. Stage the Windows resource-monitor payload before building the CLI archive that consumes it. Disposition: `retain-candidate`. | U |
| [`f625293d26`](https://github.com/nullStack65/t3code/commit/f625293d26486521ed66c972bcf80848992fa511) (fork main) | **fix(release): promotion cannot skip required packaged provenance**. Prevent promotion from bypassing required packaged provenance evidence. Disposition: `retain-candidate`. | U |
| [`0183c68f12`](https://github.com/nullStack65/t3code/commit/0183c68f12edcdc92989f2d409dccb6d58f723cd) (fork main) | **feat(release): executable local/draft promotion handoff without a CI run**. Offer a read-only planned local/draft promotion route when no CI candidate run is available; execution still gated. Disposition: `retain-candidate`. | U |
| [`e0e6318a84`](https://github.com/nullStack65/t3code/commit/e0e6318a84c6efb6afb46c14cf0e48f4906a1a4e) (fork main) | **fix(usage): make durable attribution atomic, instance-aware, and conflict-safe**. Make durable attribution atomic and instance scoped; reject conflicting bindings rather than attributing across environments. Disposition: `retain-candidate`. | U |
| [`4fe9830575`](https://github.com/nullStack65/t3code/commit/4fe983057558a3c4938da8e6619634dee846abcc) (fork main) | **fix(release): require checksum/manifest metadata and distinguish failed reads**. Require checksum/manifest metadata and treat failed release reads as unresolved, not as absence. Disposition: `retain-candidate`. | U |
| [`5cb9bc2b95`](https://github.com/nullStack65/t3code/commit/5cb9bc2b958b3e214365518a464a0fbf7f3552ef) (fork main) | **fix(release): verify the uploaded payload before finalizing a draft**. Read uploaded assets back and verify bytes before finalizing a draft release. Disposition: `retain-candidate`. | U |
| [`6f27eb941f`](https://github.com/nullStack65/t3code/commit/6f27eb941f9edf138e7360e57db33499761c3c5e) (fork main) | **fix(release): confirm final release identity/inventory and publish acceptance evidence**. Verify final release identity/asset inventory and carry acceptance evidence through publication. Disposition: `retain-candidate`. | U |
| [`b423938fd6`](https://github.com/nullStack65/t3code/commit/b423938fd6063c3593407a7af9af416ebbcacb2c) (fork main) | **Merge pull request #4 from nullStack65/feat/usage-attribution-proof-20260923**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`f5d3fc6601`](https://github.com/nullStack65/t3code/commit/f5d3fc66016d54a16fd8872321d7722d4457526e) (fork main) | **Merge pull request #6 from nullStack65/feat/durable-model-canary-attribution-20260923**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`419f757401`](https://github.com/nullStack65/t3code/commit/419f7574010c066a56974fc9e3ac0709a08efb33) (fork main) | **Merge pull request #5 from nullStack65/feat/fork-release-pipeline**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`0975683e98`](https://github.com/nullStack65/t3code/commit/0975683e984a65612f5ab18a67c413b899219098) (fork main) | **ci: use hosted runners for fork checks (#17)**. Route fork checks to hosted runners and adapt package/tooling expectations; source does not enable Actions. Disposition: `retain-candidate`. | U |
| [`58de9088f4`](https://github.com/nullStack65/t3code/commit/58de9088f487205fe168336d55e42aef16a794db) (fork main) | **feat(contracts): add managed launch identity envelope (#18)**. Carry managed provider launch identity with environment/instance binding; identity is not itself launch authorization. Disposition: `retain-candidate`. | U |
| [`0399d919cf`](https://github.com/nullStack65/t3code/commit/0399d919cfa4ae3e03b2c061cafd8d9ae727f978) (fork main) | **fix(auth): expose stable session subject (#16)**. Expose stable authenticated session subject for identity checks without returning credential material. Disposition: `retain-candidate`. | U |
| [`b23234a628`](https://github.com/nullStack65/t3code/commit/b23234a628b13e63c30edb20758397523114bf62) (fork main) | **fix(codex): scope proxy model catalogs**. Scope proxy model catalogs to configured custom catalogs rather than mixing incompatible provider entries. Disposition: `retain-candidate`. | U |
| [`6c6f2d853e`](https://github.com/nullStack65/t3code/commit/6c6f2d853e8f77f8fe86aa9455f9b4a4c3351262) (fork main) | **fix(ci): use hosted runners for fork releases**. Use fixed hosted labels for fork release jobs rather than assuming the upstream runner fleet. Disposition: `retain-candidate`. | U |
| [`131538a84c`](https://github.com/nullStack65/t3code/commit/131538a84c07680e48b156bf6c31b042a4092b0c) (fork main) | **Merge pull request #15 from nullStack65/envfix/codex-custom-only-catalog-20261001**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`23467c599a`](https://github.com/nullStack65/t3code/commit/23467c599a401b7a5baf3c7052f0d45a181bc278) (fork main) | **Merge pull request #19 from nullStack65/envfix/fork-release-hosted-runners-20261002**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`cfee77e013`](https://github.com/nullStack65/t3code/commit/cfee77e013f8fc14cfceaf59cffafcccc79fd43b) (fork main) | **Use synthetic disposable test data instead of real userdata snapshots**. Require synthetic disposable fixtures; remove real-userdata copy/snapshot guidance. Disposition: `retain-candidate`. | U |
| [`1f8ba54063`](https://github.com/nullStack65/t3code/commit/1f8ba54063ea1f9ef2f1be8f5e50e2a7371c3eda) (fork main) | **Remove conflicting real-userdata fixture permission**. Remove the remaining contradictory permission to use real userdata fixtures. Disposition: `retain-candidate`. | U |
| [`47a4f58a8b`](https://github.com/nullStack65/t3code/commit/47a4f58a8b2ab1f235118fd686a31a713a4ebedf) (fork main) | **Link approved canonical human guide from T3 instructions**. Link the canonical human assignment/recovery guide rather than duplicate it. Disposition: `retain-candidate`. | U |
| [`fdfab8dc19`](https://github.com/nullStack65/t3code/commit/fdfab8dc193386aa476e56c50240dc432bb3479a) (fork main) | **fix(server): reject incompatible callback routes before admission (#21)**. Reject incompatible or stale callback route bindings before admission while preserving deliberate user selection. Disposition: `retain-candidate`. | U |
| [`170c0fab99`](https://github.com/nullStack65/t3code/commit/170c0fab996b00750e835c5a9d7ac50fbf167f87) (fork main) | **Merge pull request #23 from nullStack65/docs/no-backup-synthetic-test-fixtures-20261002**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`eb5d08c314`](https://github.com/nullStack65/t3code/commit/eb5d08c3143d94d9b672f75ab2b9f336581cc07f) (fork main) | **fix(release): run SEA build through vp exec (#20)**. Run SEA packaging through vp exec so the expected build executable is resolved. Disposition: `retain-candidate`. | U |
| [`eca73bdf0e`](https://github.com/nullStack65/t3code/commit/eca73bdf0edf9265eea299c7513a5ab08a7411b7) (fork main) | **fix(server): restrict human reviewer routing to the owner (#22)**. Restrict human reviewer requests to the verified owner, preserve authorized removal and technical review; no other-human fallback. Disposition: `retain-candidate`. | U |
| [`7a2b41e74f`](https://github.com/nullStack65/t3code/commit/7a2b41e74f8c28115ef72375d2f6c63332a006b9) (fork main) | **fix(web): qualify silence during a running turn (#7)**. Expose sustained silence during an active turn using server observations and stable receipts; not proof the provider is hung. Disposition: `retain-candidate`. | U |
| [`5581412258`](https://github.com/nullStack65/t3code/commit/55814122587a4cadfa1a9df1536c2c2c4dad3cb5) (fork main) | **feat(service): Windows lifecycle integration candidate (SCM host + graceful stop)**. Add a Windows SCM host/graceful-stop/service protocol candidate; Windows placement remains separately qualified. Disposition: `proposal`. | U |
| [`08dbb72de3`](https://github.com/nullStack65/t3code/commit/08dbb72de3b9adabb8f4d796accea4f1db6ec139) (fork main) | **fix(server): fail opencode continuation when the resumed session is gone (#13)**. Fail a missing OpenCode resumed session instead of silently reporting continuation; retain Linux pilot handoff checks. Disposition: `retain-candidate`. | U |
| [`404501a06b`](https://github.com/nullStack65/t3code/commit/404501a06b52fe7cc06d93ec5879ee72e3bf3bfc) (fork main) | **feat(server): bounded environment preflight for provider launches (#11)**. Run bounded environment and account preflight before provider startup and surface structured warning/refusal evidence. Disposition: `retain-candidate`. | U |
| [`cb9636bfed`](https://github.com/nullStack65/t3code/commit/cb9636bfede88938f4b2358ba439884c52760b4e) (fork main) | **fix(release): carry native Intel DMG inspection evidence (#24)**. Carry native Intel DMG inspection receipts through release candidate verification. Disposition: `retain-candidate`. | U |
| [`e3ff44102c`](https://github.com/nullStack65/t3code/commit/e3ff44102cbd6e93581d96b316d452218fcc9729) (fork main) | **fix(release): bundle jsonc parser through its ESM entry (#26)**. Bundle the jsonc parser via its ESM entry to prevent a packaged runtime import failure. Disposition: `retain-candidate`. | U |
| [`59152d9d9d`](https://github.com/nullStack65/t3code/commit/59152d9d9d8fa363f03794ac2ed608ffa36779de) (fork main) | **fix(release): import receipts for the frozen candidate (#25)**. Import receipts for the exact frozen candidate rather than changing the candidate being promoted. Disposition: `retain-candidate`. | U |
| [`47947cb57d`](https://github.com/nullStack65/t3code/commit/47947cb57d166f136af1a58f6033109f7325a6f5) (fork main) | **feat(server): refuse unqualified typed Skill sessions (#31)**. Refuse unqualified typed Skill driver sessions; a discoverable Skill is not activation proof. Disposition: `retain-candidate`. | U |
| [`9d83956644`](https://github.com/nullStack65/t3code/commit/9d83956644051d28c030b46cc6afea3fbe5f53e7) (fork main) | **fix(ci): require explicit owner admission for relay deployment (#32)**. Require explicit owner admission before relay deployment; source-only work must not deploy automatically. Disposition: `retain-candidate`. | U |
| [`d740e35e43`](https://github.com/nullStack65/t3code/commit/d740e35e43ae0d411ddce5bd743887f72c495555) (fork main) | **feat(server): bind Codex observations to process and turn lifecycle (#33)**. Bind Codex observations to process and turn lifecycle so stale observations cannot qualify a different launch. Disposition: `retain-candidate`. | U |
| [`9ebc81ada5`](https://github.com/nullStack65/t3code/commit/9ebc81ada5298460dbb323c26e0e0f0e829c1107) (fork main) | **feat(server): resolve typed Skills for fresh Codex turns (#35)**. Resolve typed Skills for fresh Codex turns with exact context/source binding; refresh on new launch facts. Disposition: `retain-candidate`. | U |
| [`e97641abf6`](https://github.com/nullStack65/t3code/commit/e97641abf69fb88538b53279ded28704b6ccb2b3) (fork main) | **fix(server): observe account readiness before governed startup (#37)**. Observe account readiness before governed startup rather than accepting an unobserved account state. Disposition: `retain-candidate`. | U |
| [`405f47c189`](https://github.com/nullStack65/t3code/commit/405f47c189187aa401821763c69c5e273de32831) (fork main) | **test(provider): exit Claude fixture on EOF and prevent leaked processes (#48)**. Make the synthetic Claude peer exit on EOF and prevent fixture subprocess leakage. Disposition: `retain-candidate`. | U |
| [`b62bf79223`](https://github.com/nullStack65/t3code/commit/b62bf7922341d43d89d27ea5a5f7ce4fbe911e2b) (fork main) | **Default T3 project threads to owned worktrees (#30)**. Set the project preference for owned worktrees; runtime enforcement is separately implemented. Disposition: `retain-candidate`. | U |
| [`e655ca7c44`](https://github.com/nullStack65/t3code/commit/e655ca7c445e74fe8b690fef39984d7a71e00e52) (fork main) | **feat(server): add opt-in Codex guard refusal preflight (#47)**. Add opt-in Codex guard refusal preflight; enforce deliberately refuses the unqualified lock-lifetime shape. Disposition: `retain-candidate`. | U |
| [`aa1e770179`](https://github.com/nullStack65/t3code/commit/aa1e770179d9f0066d15771ce540679755436d53) (fork main) | **docs(agents): reuse task authority for routine browser verification (#41)**. Reuse authorized routine browser verification authority rather than demanding repeated human permission. Disposition: `retain-candidate`. | U |
| [`96c7bf6475`](https://github.com/nullStack65/t3code/commit/96c7bf6475ca96ea02c8b09f938c693ae7cb3266) (fork main) | **fix(desktop): isolate packaged macOS maintenance profiles (#29)**. Isolate packaged macOS maintenance profiles across home paths, auth storage, exposure and discovery; no host installed proof. Disposition: `retain-candidate`. | U |
| [`e3e4e54ac0`](https://github.com/nullStack65/t3code/commit/e3e4e54ac0d8a9d80b5dc648d973554f0c24ed8f) (fork main) | **docs: adopt Closura provenance trailer convention in the fork**. Add honest model/task/agent provenance in PR and commit conventions. Disposition: `retain-candidate`. | U |
| [`bdd2b4abd5`](https://github.com/nullStack65/t3code/commit/bdd2b4abd58e54047e11c3d0aa9b862f60bc57a8) (fork main) | **docs: point fork agents at the provenance commit-msg hook**. Point agents at the canonical provenance hook rather than a second hand-maintained hook. Disposition: `retain-candidate`. | U |
| [`7c146a2c34`](https://github.com/nullStack65/t3code/commit/7c146a2c344496f51a93f4cce90763b16cc62437) (fork main) | **Merge pull request #50 from nullStack65/docs/provenance-trailers-p1**. Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title. Disposition: `retire-candidate`. | M |
| [`8e5610de2b`](https://github.com/nullStack65/t3code/commit/8e5610de2b3cf8ae557d405794c0bb233795b9fe) (fork main) | **fix(server): opt-in fail-closed policy for codex thread resume (#2)**. Opt in to fail-closed Codex resume: propagate resume failures instead of silently starting a replacement; adds contracts tests beyond ASUS f014. Disposition: `retain-candidate`. | U |
| [`80b6cad46b`](https://github.com/nullStack65/t3code/commit/80b6cad46b93a1f72f4d07d75ffb26bed1dfc410) (fork main) | **fix(server): enforce owned worktrees for coding launches (#28)**. Enforce owned worktrees for coding launches in server and clients, including execution-scope persistence. Disposition: `retain-candidate`. | U |
| [`569116e95c`](https://github.com/nullStack65/t3code/commit/569116e95c647cc1bfbd9f3132ca39d0e68f3d3a) (fork main) | **fix(ci): preserve both owner identities across transfer (#51)**. Retain both historical/current owner identities in relay deployment admission across account transfer. Disposition: `retain-candidate`. | U |
| [`05993d81ac`](https://github.com/nullStack65/t3code/commit/05993d81acd2eec0081e2b396bc52bc993bb2bf3) (fork main) | **fix(server): generate PR diffs from branch changes (#53)**. Generate PR diffs from branch changes rather than mixing worktree changes into the review diff. Exact stable patch of upstream [`f22331240e`](https://github.com/pingdotgg/t3code/commit/f22331240ed1a97fae560e314bffb75fe39db8ca) in both pinned references; retire standalone replay. Disposition: `upstream-covered`. | Exact upstream patch |
| [`f014905ed1`](https://github.com/nullStack65/t3code/commit/f014905ed1c73600310accc6d2bc378c9d5c7840) (ASUS) | **fix(server): opt-in fail-closed policy for codex thread resume**. ASUS ships opt-in fail-closed Codex resume source; main 8e5610d carries the same six-file runtime patch plus contracts tests. Disposition: `retain-candidate`. | U; partially covered by fork main 8e5610d |
| [`083270eb52`](https://github.com/nullStack65/t3code/commit/083270eb523fd7742b5e1490de042089e1aa7ffc) (Air) | **feat(voice): add AssemblyAI cloud transcription**. Preserve Air AssemblyAI transcription: multipart config/audio, provider-specific authorization/model header, duration bounds and settings/UI/secret contracts. Disposition: `retain-candidate`. | U |
| [`40e7b0f2da`](https://github.com/nullStack65/t3code/commit/40e7b0f2daf32e7a23fb9c0e4b89c31b92f3489c) (local CLO-802) | **feat(mcp): wait for the next persisted thread event**. Candidate cursor-bound next persisted thread event over existing replay/livestream; interruptible MCP fetch and read-only CLI authentication. Disposition: `proposal`. | P |
| [`ec444939d7`](https://github.com/nullStack65/t3code/commit/ec444939d7eb67eaeb632a6b7082e14ed5be433c) (local CLO-802) | **test(cli): provide next-event parser dependencies together**. Provision next-event CLI parser dependencies together; test-only follow-up after the independent candidate review. Disposition: `proposal`. | P |

## Shipped sources, artifact overlays and separately owned candidates

- **ASUS:** every non-upstream commit reachable at `f014905ed1c73600310accc6d2bc378c9d5c7840` is accounted for above: exactly **one**, not merely the last commit of an undisclosed patch stack. Its added/removed lines match on all six paths in main's `8e5610de2b`; main additionally adds 26 contracts-test lines, so whole-commit stable patch IDs differ. Context also differs; even restricting to those six paths yields different stable IDs (`ad29a358435933d3b86dbdbe8575897b921628b9` versus `06b918802c5501de454defb3db140ceb6645ae8f`). Coverage here is explicit source comparison of added/removed lines, not an exact patch-ID assertion. Compare `git show f014905ed1c73600310accc6d2bc378c9d5c7840` and `git show 8e5610de2b` on those six paths to establish partial coverage. Parent's verified runtime was `/home/primary/.local/share/closura/t3-node/runtime/t3-0.0.42-f014905/t3`, CLI `0.0.42-f014905`, executable SHA-256 `f36569e1fe2c5da7475336b1b5a07c5e23ecb368bbe463b0045864fb7c9952b2`, active service PID 1539, loopback port 3773. Source package version at that commit is `0.0.40`. The suffix mapping does **not** prove reproducibility, source cleanliness or the absence of build overlays; exact uncommitted artifact changes remain unverified. This lane made no host inspection or change.
- **Crown:** parent verified official-looking v0.1.2 package build `044f07257c96`, CLI/MCP v0.1.2, ASAR SHA-256 `9bffa7f7e89709862edf5354bbd7de70d99354c3392be637fd1c3040b27a2736`. That source includes orchestration MCP tools; fork main does not. Installed Crown is not built from current fork main. No source-only inventory can prove binary equivalence.
- **Air:** parent verified custom `0.1.9-assemblyai.1`, committed clean source `083270eb523fd7742b5e1490de042089e1aa7ffc`, ASAR SHA-256 `72cfc0be0bee4c87646e2c9efae851616349ccaa088f74b9b5511e4eae48a00f`. [AssemblyAI PR #54](https://github.com/nullStack65/t3code/pull/54) merged as `65032d5a0282fb8b08837e19ceed01dda5ac1234`, while the installed artifact is from its original head `083270eb…`; they are not the same commit identity. Immediate parent is `1a4a29998be205ad8fbb8dd6eefc2a730f025ca5`, not the previous official Air build `24e77473ecf41bc1f7142529c7911c1c1aae1d76`. This lane freshly read the branch and provider source; the historical 12 speech/HTTP, 75 settings, 6 secret checks and synthetic live transcription are parent evidence, not fresh tests here.
- **R720:** parent found it reachable, with no T3 process, managed binary, port 3773 listener or installed service. Both user/system service probes were not-found/inactive. It has OpenCode 2.2.6 and t3-tots tools; T3 source/build is N/A, not offline or the ASUS build.
- **CLO-802 native eventwait:** exact local head `ec444939d7eb67eaeb632a6b7082e14ed5be433c`, clean when read at `/Users/businessaccount/.t3/worktrees/t3code/clo802-native-event-wait`. The implementation `40e7b0f2daf32e7a23fb9c0e4b89c31b92f3489c` was independently reviewed before the parser-dependency-only follow-up. Parent reported 57 focused, 6 CLI/server and 28 package checks; these are local historical evidence, not CI or installation proof. Native owner remains Crown `mcp:dc7efab7-9f23-44d7-a02b-5910db7a01ba`. Publication was blocked by OAuth workflow scope on an official-base branch; dependent feature push was not run. The snapshot entries below do not require CI to fetch an unpublished object and never exempt incoming fork code: promotion into the enforced entries requires explicit inventory of the incoming commits. This PR does not duplicate eventwait.
- **Other proposals:** [Builder's V2 convergence draft #49](https://github.com/nullStack65/t3code/pull/49), `0464d4ee5911e0f8db7d2cf8521a56ee10c43ceb`, is a separately owned backlog/preservation planning carrier, not merged behavior. [Billing-source quota draft #52](https://github.com/nullStack65/t3code/pull/52), `181ea98b7034bc598973a1c8dad5bc6455957f3a`, is a separately owned implementation candidate, uninstalled. Its native Codex quota gating is adapted from upstream `c9dfc404ccde9a4c8be901b287026dd19e4ed19a`; its exact billing/account selection, Magpie read-only quota reader and pooled-account errors still require separate qualification. These two proposals are not silently admitted as fork-main features or taken over here.

Config [PR #715](https://github.com/nullStack65/closura-agent-config/pull/715) merged as `6759f161c829a94c72e5cf735f9baa5cd9f82bcd`; agent-scripts [PR #14](https://github.com/nullStack65/agent-scripts/pull/14) merged as `6275be35047e8f205434d59d2dd0f926b9ce5931`. Parent reported tools installed on Crown/ASUS/R720, but listeners/destinations inactive and receiver transaction idempotency unqualified. Source, installed tool and effective live wake are separate facts.

## Enforcement and maintenance

Run `python3 scripts/fork_delta/guard.py` on a committed checkout with full history and the pinned reference objects. It reads the inventory from the exact checked head, never from an unrelated worktree file. `python3 scripts/fork_delta/guard.py --head <full-sha> --upstream <full-sha>` emits candidate identities for human classification; it never writes accepted rows. Run synthetic tests with `python3 -m unittest discover -s scripts/fork_delta -p 'test_*.py' -v`.

For new application code, commit the code first, then list that exact commit/tree/parents/patch ID, source evidence, semantic reason and a deliberate disposition in a follow-up inventory commit before review. `needs-classification` is rejected. A listed candidate is **not approved**. Branch protection and human/technical review remain independent. The guard evaluates commits even when later reverted, preventing unknown intermediate effects from disappearing into a clean final diff. Unknown refs, incomplete history, identity tampering and unlisted conflict-resolution trees fail closed. A later official baseline must be explicitly updated and reviewed; the arrival report only proposes new coverage.

The self-reference exception is bounded to seven exact maintenance paths and exact SHA-256 content. The `FORK_DELTA.md` digest canonicalizes only its own `maintenance` object to `{}` before hashing; all other prose and inventory are covered. No directory or arbitrary documentation exemption exists. A maintenance change requires refreshed hashes and review; its previous version must first have been listed by immutable commit when it ceases to match. This is cooperative CI, not tamper-proof enforcement against someone changing the workflow or guard. Repository settings and direct unguarded paths remain outside this source change.

The workflow checks the GitHub synthetic merge tree on PRs and actual main on pushes, while preserving existing workflows. Source check availability requires fetching the exact ASUS/Air lineage objects; unavailable historical objects fail with an explicit Git error, never fabricated success. Local candidate snapshot entries are intentionally not accepted runtime source.

## Weekly report on upstream release arrivals

`.github/workflows/fork-upstream-drift.yml` accepts only `repository_dispatch` type `upstream-release-published`; `workflow_dispatch` is manual recovery/testing. There is **no timer**, no fork-local `release` subscription and no model job. “Weekly” means reports grouped by the release publication's UTC ISO week, with the published release cohort recomputed on arrivals. No upstream release event means no run. Each run produces a job summary and artifact, including exact release/main/fork refs, ancestry counts, stable-patch matches and full candidate identities; it never merges, deploys or auto-approves a patch.

The receiver requires this data contract (untrusted data, not instructions):

```json
{"event_type":"upstream-release-published","client_payload":{"repository":"pingdotgg/t3code","action":"published","release_id":441607705,"tag_name":"v0.1.9","commit":"<canonical full tag commit>"}}
```

The script re-reads the canonical GitHub release by ID, rejects drafts/unpublished releases, checks repository/action/tag/URL and resolves the canonical tag commit through GitHub, rejecting a claimed-commit mismatch. It fetches only immutable verified SHAs from fixed repository URLs, checks exact identities, and executes only the trusted checkout. No untrusted ref, code, URL, title or release body is executed. Permissions are `contents: read` and `actions: read`; the artifact action uses its supported upload path, not a new write grant.

Duplicate arrivals reconcile all retained artifact pages by release ID **and** canonical commit, serializing the job before upload. Artifact retention is 90 days; expiry or manual deletion permits a fresh report. GitHub concurrency may coalesce pending arrivals; a later arrival rebuilds that week's cohort but this is not a durable all-events delivery guarantee. A duplicate job may still start and post a no-op summary. There is no external message or automatic patch retirement.

### Actual ingress and activation gap

Fresh read-only checks found fork Actions `enabled=false`, registered runner count `0`, and fork repository hooks `[]`. The [canonical signed webhook proxy](https://github.com/nullStack65/closura-agent-config/tree/master/infra/webhook-proxy) documents config-repository push/PR and Linear sources only. Its routes spool other events but contain no upstream-release-to-fork-dispatch adapter. No real source delivering `pingdotgg/t3code` release arrivals was established. The latest canonical published release observed was ID `441607705`, tag `v0.1.9`, published November 11, 2026 11:33:49 UTC; reading it is not delivery proof.

GitHub's [event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) says a repository release trigger is scoped to its repository; dispatch requires an external API caller and the workflow on the default branch. The [release API](https://docs.github.com/en/rest/releases/releases) supplies canonical publication metadata. Therefore this source receiver is **inactive and automatic upstream reporting is unverified**. Activation requires the existing CLO-802 webhook owner to identify an authorized upstream release source and implement/qualify forwarding through the existing proxy, then explicit repository/default-branch/workflow activation and a real event/readback. No new daemon, polling service, cron, upstream-maintainer contact, secret/grant or setting change is authorized here. Do not enable all existing fork deployment workflows to activate this reporting lane.

## Evidence limits and recovery

This PR supplies source and focused synthetic tests, not full application CI, deployed enforcement, artifact qualification, runtime health or fleet acceptance. The parent owns one independent exact-head review. No reviewer was assigned by this lane. No source baseline rebase, host/auth/service/database/deployment change, merge, reset or paid route occurred. An inventory rollback is an ordinary revert of this source change; it rolls back no application data and creates no backups. Unverified overlays and unavailable lineages remain explicit rather than guessed.

## Machine-readable source identities

This manifest is the accepted **listing** surface, not an approval record. Local snapshots under `external_candidates` grant no guard exemption or installation authority.

<!-- fork-delta-manifest:start -->
```json
{
  "schema": 1,
  "captured_at": "2026-11-13T22:58:53Z",
  "references": {
    "official_v0_1_2": "044f07257c9684ae4543bd1e1ebf9c394e9e3830",
    "upstream_main": "08b8689a856bb282350bbb30c94e5d8cd22fec7a"
  },
  "lineages": {
    "forkmain": "05993d81acd2eec0081e2b396bc52bc993bb2bf3",
    "asus": "f014905ed1c73600310accc6d2bc378c9d5c7840",
    "air": "083270eb523fd7742b5e1490de042089e1aa7ffc"
  },
  "entries": [
    {
      "commit": "bcc1a58b19a9d610a4f08fed191a364767bc65b3",
      "parents": [
        "d7819c18813fa03b033cc1c9472c9acc0ffc0618"
      ],
      "tree": "96396900a12faf657af3296f50a7570d8097d21a",
      "patch_id": "625b9d168b8226f369461b0b1bb6c622f3aa0223",
      "decision": "retain-candidate",
      "why": "Allow the user to disable AI title generation; reactor and settings respect the preference rather than starting unwanted text generation.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/bcc1a58b19a9d610a4f08fed191a364767bc65b3",
        "apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts",
        "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
        "apps/web/src/components/settings/SettingsPanels.restore.test.tsx"
      ]
    },
    {
      "commit": "95a3db45c6b8795976811c98019f7732601220f2",
      "parents": [
        "bcc1a58b19a9d610a4f08fed191a364767bc65b3"
      ],
      "tree": "398dcf43a2082f410751a0fabe675c74a57ce6e9",
      "patch_id": "daa7d131fcf9a58ba269595f3a8685e2917cf9e5",
      "decision": "retain-candidate",
      "why": "Project measured transcript metadata onto prompt/request/session/PR levels; mark unsupported granularity instead of inventing requests.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/95a3db45c6b8795976811c98019f7732601220f2",
        "apps/server/src/usage/usageAttribution.test.ts",
        "apps/server/src/usage/usageAttribution.ts",
        "apps/server/src/usage/usageScanCache.test.ts"
      ]
    },
    {
      "commit": "ee732edd0edc771c60ce3629569c9fe16ff9ae05",
      "parents": [
        "95a3db45c6b8795976811c98019f7732601220f2"
      ],
      "tree": "2b05ade2782ec3975a035c01ae58fe547c738dd8",
      "patch_id": "4c77ac36fe7a26f360c9aaf10e84a38ed04708a3",
      "decision": "retain-candidate",
      "why": "Keep missing request counts null; zero would falsely imply a measured absence.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/ee732edd0edc771c60ce3629569c9fe16ff9ae05",
        "apps/server/src/usage/usageAttribution.test.ts",
        "apps/server/src/usage/usageAttribution.ts"
      ]
    },
    {
      "commit": "db1a3db830ff903e5cf298f5f8c5f56c82c904fb",
      "parents": [
        "ee732edd0edc771c60ce3629569c9fe16ff9ae05"
      ],
      "tree": "8508743e8a885b0af9ee758d8955feebb3e83703",
      "patch_id": "4a8d4b8acf3e5040730109488087cf721d02f964",
      "decision": "retain-candidate",
      "why": "Assert allocation reconciliation so attributed totals cannot silently exceed or lose the measured input.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/db1a3db830ff903e5cf298f5f8c5f56c82c904fb",
        "apps/server/src/usage/usageAttribution.test.ts",
        "docs/internals/usage-attribution.md"
      ]
    },
    {
      "commit": "f36f413518025df386ef58944b7cdaffa4121117",
      "parents": [
        "bcc1a58b19a9d610a4f08fed191a364767bc65b3"
      ],
      "tree": "2693dd694a326e9e53ca0a5ab4ebfe2e55d949d5",
      "patch_id": "c3f3a543bcb14d6d252e1a4a73b2dc845839947a",
      "decision": "retain-candidate",
      "why": "Separate fork update/release identity from upstream publication and package provenance per target.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/f36f413518025df386ef58944b7cdaffa4121117",
        ".github/workflows/fork-release.yml",
        "docs/operations/fork-release.md",
        "docs/user/fork-install.md"
      ]
    },
    {
      "commit": "89369420870a3086051fb01462193c805ecc2aaa",
      "parents": [
        "f36f413518025df386ef58944b7cdaffa4121117"
      ],
      "tree": "4586801ee61e74e1e01abbfd8aabdff8637100e6",
      "patch_id": "913b0ece1b403ba99775a808018747292e45c192",
      "decision": "retain-candidate",
      "why": "Document the retained package identity WinGet pin that must be cleared before promotion.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/89369420870a3086051fb01462193c805ecc2aaa",
        "docs/operations/fork-release.md"
      ]
    },
    {
      "commit": "df8aceb5f8441305d61f8de17c6a0763b37b096c",
      "parents": [
        "89369420870a3086051fb01462193c805ecc2aaa"
      ],
      "tree": "e8d0b715df3263014fb82c66f63eb162c7d610b8",
      "patch_id": "0e8eaa54f27235d909b8049bead7d155e41100ee",
      "decision": "retain-candidate",
      "why": "Freeze source-bound candidates and verify manifest/WSL payload provenance before promotion; runner admission remains explicit.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/df8aceb5f8441305d61f8de17c6a0763b37b096c",
        ".github/workflows/fork-release.yml",
        ".github/workflows/release-desktop.yml",
        "docs/operations/fork-release.md"
      ]
    },
    {
      "commit": "d1dd6821987dab544577d01826b2a4a1a81b9c04",
      "parents": [
        "db1a3db830ff903e5cf298f5f8c5f56c82c904fb"
      ],
      "tree": "448ea4bb4480d17472350854b2d6334cd89f556f",
      "patch_id": "13aae9d8f57608f256c4e542440c8c1fd9669c39",
      "decision": "retain-candidate",
      "why": "Retain legacy scan history and distinguish unavailable measurements from explicit zero values.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/d1dd6821987dab544577d01826b2a4a1a81b9c04",
        "apps/server/src/usage/UsageService.ts",
        "apps/server/src/usage/usageScanCache.test.ts",
        "apps/server/src/usage/usageScanCache.ts"
      ]
    },
    {
      "commit": "e4f36af5ef279246bcb0f8463adeee8a09b7bde1",
      "parents": [
        "d1dd6821987dab544577d01826b2a4a1a81b9c04"
      ],
      "tree": "2c9b489083fd8e744994a4624fcc25a73fca381a",
      "patch_id": "c934a6e57374dae99e7de7732ba109cc98f41d4d",
      "decision": "retain-candidate",
      "why": "Extract persisted session and PR bindings into the pure attribution projection rather than guessing links.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/e4f36af5ef279246bcb0f8463adeee8a09b7bde1",
        "apps/server/src/usage/usageAttribution.test.ts",
        "apps/server/src/usage/usageAttribution.ts",
        "apps/server/src/usage/usageAttributionSources.test.ts"
      ]
    },
    {
      "commit": "d1e09ad1524913fa46264ad41d3a6c9a13e8c61a",
      "parents": [
        "df8aceb5f8441305d61f8de17c6a0763b37b096c"
      ],
      "tree": "fc1a8e94fff882a9af2a7044fa505890d126125f",
      "patch_id": "cb6ddb955260dd6ba8e01f71954c66141384c31b",
      "decision": "retain-candidate",
      "why": "Make each platform candidate executable independently, bind receipts and gate aggregate promotion.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/d1e09ad1524913fa46264ad41d3a6c9a13e8c61a",
        ".github/workflows/fork-release.yml",
        "docs/operations/fork-release.md",
        "scripts/build-fork-candidate.ts"
      ]
    },
    {
      "commit": "948bbb3497302bf5a9c4a94a11dcd440e1cddca7",
      "parents": [
        "d1e09ad1524913fa46264ad41d3a6c9a13e8c61a"
      ],
      "tree": "4141d577cc0f51c5d45cf083bb7437c5c30cae42",
      "patch_id": "6146a2153ee597ebb2c115843a02312e5d4eec18",
      "decision": "retain-candidate",
      "why": "Allow per-target verification before an aggregate manifest exists without skipping target checks.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/948bbb3497302bf5a9c4a94a11dcd440e1cddca7",
        "scripts/fork-release-entrypoints.test.ts",
        "scripts/verify-fork-candidate.ts"
      ]
    },
    {
      "commit": "ef2205342298ee7ff602abccca9b0cbadc7f8607",
      "parents": [
        "948bbb3497302bf5a9c4a94a11dcd440e1cddca7"
      ],
      "tree": "c0a90149304620715421d366c0df9e754d7d5461",
      "patch_id": "f8d8eb80df8092d6157fab9852a004fc9615ab56",
      "decision": "retain-candidate",
      "why": "Inspect the actual nested NSIS application payload, not a convenient outer executable.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/ef2205342298ee7ff602abccca9b0cbadc7f8607",
        "scripts/lib/candidate-build-plan.ts",
        "scripts/lib/candidate-provenance-inspect.ts",
        "scripts/verify-windows-installer.ts"
      ]
    },
    {
      "commit": "f652cc271012556a02f25763f98d9c3467d77833",
      "parents": [
        "ef2205342298ee7ff602abccca9b0cbadc7f8607"
      ],
      "tree": "0709d5a285f40b5431501c1167476bedf174bf9e",
      "patch_id": "3a283cc8df7f7ff7a9a5443fed848a1711ce8588",
      "decision": "retain-candidate",
      "why": "Identify the embedded WSL runtime as Windows installer provenance rather than the installer wrapper.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/f652cc271012556a02f25763f98d9c3467d77833",
        "scripts/lib/candidate-provenance-inspect.ts",
        "scripts/lib/fork-release-manifest.test.ts",
        "scripts/lib/fork-release-manifest.ts"
      ]
    },
    {
      "commit": "daa55eb88966665faa8c1770c35fc3c53a68f6fa",
      "parents": [
        "e4f36af5ef279246bcb0f8463adeee8a09b7bde1"
      ],
      "tree": "03f833e9df2325f36d0176be8cb992958cc5d968",
      "patch_id": "5b92132c1b1876d5db1d7afe2f0ef6ad851d9ef5",
      "decision": "retain-candidate",
      "why": "Complete measurement/cache quality handling at parser, projection and service seams.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/daa55eb88966665faa8c1770c35fc3c53a68f6fa",
        "apps/server/src/usage/UsageService.test.ts",
        "apps/server/src/usage/UsageService.ts",
        "apps/server/src/usage/usageAttribution.test.ts"
      ]
    },
    {
      "commit": "1be979bb3af8ffbe1a40517678f928ab9795707c",
      "parents": [
        "f652cc271012556a02f25763f98d9c3467d77833"
      ],
      "tree": "0a9cee888a38a5d44d8f9408a70797c196d71e6b",
      "patch_id": "2d96bb23e4ace83a92b3210fb448510b80cb204d",
      "decision": "retain-candidate",
      "why": "Inspect desktop bundles and DMG content and fail closed when package provenance is missing.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/1be979bb3af8ffbe1a40517678f928ab9795707c",
        ".github/workflows/fork-release.yml",
        "scripts/fork-release-entrypoints.test.ts",
        "scripts/lib/candidate-provenance-inspect.ts"
      ]
    },
    {
      "commit": "23e52963cfc9799fba70e458b39507d130e0e334",
      "parents": [
        "1be979bb3af8ffbe1a40517678f928ab9795707c"
      ],
      "tree": "959f9e1a9c66fc8e16c9843651880519f8672af5",
      "patch_id": "5e519c129d7bf413e163aae5b99c35d6f5f82423",
      "decision": "retain-candidate",
      "why": "Carry digest-bound inspection evidence through local build/stage/verify handoffs.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/23e52963cfc9799fba70e458b39507d130e0e334",
        "scripts/build-fork-candidate.ts",
        "scripts/lib/candidate-build-plan.test.ts",
        "scripts/lib/candidate-build-plan.ts"
      ]
    },
    {
      "commit": "929b63795e7696855ada61de5fd359dc2f51da78",
      "parents": [
        "23e52963cfc9799fba70e458b39507d130e0e334"
      ],
      "tree": "bc75be1eb2839ad542faa4ea01610050a191d140",
      "patch_id": "fb6bd7555223f79de544c69171870bf961c9e92c",
      "decision": "retain-candidate",
      "why": "Do not stage an arm64 DMG unless explicitly requested; absent optional targets are not required assets.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/929b63795e7696855ada61de5fd359dc2f51da78",
        "scripts/build-fork-candidate.ts",
        "scripts/lib/candidate-build-plan.test.ts",
        "scripts/lib/candidate-build-plan.ts"
      ]
    },
    {
      "commit": "af70495442678a06e007d13bba477f123170c0f5",
      "parents": [
        "daa55eb88966665faa8c1770c35fc3c53a68f6fa"
      ],
      "tree": "9378c154fb7bee8d37f5bd662088a65b9f65def2",
      "patch_id": "5ee4da575432e1ff0c0c798f272ef9ad98778357",
      "decision": "retain-candidate",
      "why": "Preserve measured zero/invalid quality and refresh stale scan-cache rows; zero is data, not an empty record.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/af70495442678a06e007d13bba477f123170c0f5",
        "apps/server/src/usage/UsageService.test.ts",
        "apps/server/src/usage/UsageService.ts",
        "apps/server/src/usage/usageAttribution.test.ts"
      ]
    },
    {
      "commit": "f863939bcd52b49f238982f593ea34c146f80e28",
      "parents": [
        "af70495442678a06e007d13bba477f123170c0f5"
      ],
      "tree": "c7a7c3ebdbb631816e755f6b5e89342315acf832",
      "patch_id": "0e1ef3a351e8db4834c3a04b825a05da2a20f2b5",
      "decision": "retain-candidate",
      "why": "Persist predecessor freshness across restart so a restarted scan does not accept stale cached attribution.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/f863939bcd52b49f238982f593ea34c146f80e28",
        "apps/server/src/usage/UsageService.test.ts",
        "apps/server/src/usage/usageScanCache.test.ts",
        "apps/server/src/usage/usageScanCache.ts"
      ]
    },
    {
      "commit": "30241b1fc654b3359d4d94b58751f4e0a8040749",
      "parents": [
        "f863939bcd52b49f238982f593ea34c146f80e28"
      ],
      "tree": "6037429a7153184347a2ce9340ef4ac506dbb857",
      "patch_id": "2d6036dd22eec58d8066fafb6d02ea7953fbb2f3",
      "decision": "retain-candidate",
      "why": "Persist provider session history and route events so model-canary attribution survives resumes and route changes.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/30241b1fc654b3359d4d94b58751f4e0a8040749",
        "apps/server/src/persistence/Migrations.ts",
        "apps/server/src/persistence/Migrations/054_ProviderSessionHistory.test.ts",
        "apps/server/src/persistence/Migrations/054_ProviderSessionHistory.ts"
      ]
    },
    {
      "commit": "3a1047a16497f975aba46617f894ce49455ab8b0",
      "parents": [
        "30241b1fc654b3359d4d94b58751f4e0a8040749"
      ],
      "tree": "76b2111a869e17ea9f20a9ea1577f38c9fd67918",
      "patch_id": "6c0d7806467cce99c5971950ecc2408a05784521",
      "decision": "retain-candidate",
      "why": "Test route-view preservation of zero, invalid and cached measurement quality.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/3a1047a16497f975aba46617f894ce49455ab8b0",
        "apps/server/src/usage/usageRouteAttribution.test.ts"
      ]
    },
    {
      "commit": "93a74a5b9126766a1b4dcf9aaf0afe0e98270984",
      "parents": [
        "929b63795e7696855ada61de5fd359dc2f51da78"
      ],
      "tree": "dbb616985eb09a5e824dae28e0e79b133382a62c",
      "patch_id": "08ee801d8fd7ff869ec8e5e840f145e5c5177052",
      "decision": "retain-candidate",
      "why": "Stage the Windows resource-monitor payload before building the CLI archive that consumes it.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/93a74a5b9126766a1b4dcf9aaf0afe0e98270984",
        "scripts/build-fork-candidate.ts",
        "scripts/lib/resource-monitor-staging.test.ts",
        "scripts/lib/resource-monitor-staging.ts"
      ]
    },
    {
      "commit": "f625293d26486521ed66c972bcf80848992fa511",
      "parents": [
        "93a74a5b9126766a1b4dcf9aaf0afe0e98270984"
      ],
      "tree": "f4376fdbba8713572a67829eca8c4db4dda459b4",
      "patch_id": "2bae7e54cf2d849e1c70d3fb35a6962c8a79e690",
      "decision": "retain-candidate",
      "why": "Prevent promotion from bypassing required packaged provenance evidence.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/f625293d26486521ed66c972bcf80848992fa511",
        "scripts/fork-release-entrypoints.test.ts",
        "scripts/verify-fork-candidate.ts"
      ]
    },
    {
      "commit": "0183c68f12edcdc92989f2d409dccb6d58f723cd",
      "parents": [
        "f625293d26486521ed66c972bcf80848992fa511"
      ],
      "tree": "4f1bd6d22669957ab03a7f0d5a91f3f2d730f899",
      "patch_id": "41e48652c039a06e1452e6b9488ea9e8736c5606",
      "decision": "retain-candidate",
      "why": "Offer a read-only planned local/draft promotion route when no CI candidate run is available; execution still gated.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/0183c68f12edcdc92989f2d409dccb6d58f723cd",
        "docs/operations/fork-release.md",
        "scripts/lib/fork-promotion.test.ts",
        "scripts/lib/fork-promotion.ts"
      ]
    },
    {
      "commit": "e0e6318a84c6efb6afb46c14cf0e48f4906a1a4e",
      "parents": [
        "3a1047a16497f975aba46617f894ce49455ab8b0"
      ],
      "tree": "1a5fee642ba294ea2541dedf3eec9ab54b6e449e",
      "patch_id": "59452131dc2a3345d6e06bf83913a22714b1e06d",
      "decision": "retain-candidate",
      "why": "Make durable attribution atomic and instance scoped; reject conflicting bindings rather than attributing across environments.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/e0e6318a84c6efb6afb46c14cf0e48f4906a1a4e",
        "apps/server/src/persistence/Migrations/054_ProviderSessionHistory.test.ts",
        "apps/server/src/persistence/Migrations/054_ProviderSessionHistory.ts",
        "apps/server/src/persistence/Migrations/055_ThreadRouteEvents.ts"
      ]
    },
    {
      "commit": "4fe983057558a3c4938da8e6619634dee846abcc",
      "parents": [
        "0183c68f12edcdc92989f2d409dccb6d58f723cd"
      ],
      "tree": "1f08f96aa29dcaef9438e1ba70ccce2313c24b14",
      "patch_id": "13589b05503a6737638d8e3c9e4c88795a23057a",
      "decision": "retain-candidate",
      "why": "Require checksum/manifest metadata and treat failed release reads as unresolved, not as absence.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/4fe983057558a3c4938da8e6619634dee846abcc",
        "scripts/lib/fork-promotion.test.ts",
        "scripts/lib/fork-promotion.ts",
        "scripts/verify-fork-candidate.ts"
      ]
    },
    {
      "commit": "5cb9bc2b958b3e214365518a464a0fbf7f3552ef",
      "parents": [
        "4fe983057558a3c4938da8e6619634dee846abcc"
      ],
      "tree": "f3a5c479f3e327baf5ffe170f118ecf8ac5f6e6a",
      "patch_id": "63d72e11374402cb4a5856c08e12545ba1e8e887",
      "decision": "retain-candidate",
      "why": "Read uploaded assets back and verify bytes before finalizing a draft release.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/5cb9bc2b958b3e214365518a464a0fbf7f3552ef",
        "docs/operations/fork-release.md",
        "scripts/promote-fork-candidate.test.ts",
        "scripts/promote-fork-candidate.ts"
      ]
    },
    {
      "commit": "6f27eb941f9edf138e7360e57db33499761c3c5e",
      "parents": [
        "5cb9bc2b958b3e214365518a464a0fbf7f3552ef"
      ],
      "tree": "61dee387d906c43d5560ef60458489b49cb29a06",
      "patch_id": "b14a61a0bcf14890aa8934eb5cbaefdc2bf9ecc3",
      "decision": "retain-candidate",
      "why": "Verify final release identity/asset inventory and carry acceptance evidence through publication.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/6f27eb941f9edf138e7360e57db33499761c3c5e",
        "docs/operations/fork-release.md",
        "scripts/lib/fork-promotion.test.ts",
        "scripts/lib/fork-promotion.ts"
      ]
    },
    {
      "commit": "b423938fd6063c3593407a7af9af416ebbcacb2c",
      "parents": [
        "bcc1a58b19a9d610a4f08fed191a364767bc65b3",
        "f863939bcd52b49f238982f593ea34c146f80e28"
      ],
      "tree": "c7a7c3ebdbb631816e755f6b5e89342315acf832",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/b423938fd6063c3593407a7af9af416ebbcacb2c"
      ]
    },
    {
      "commit": "f5d3fc66016d54a16fd8872321d7722d4457526e",
      "parents": [
        "b423938fd6063c3593407a7af9af416ebbcacb2c",
        "e0e6318a84c6efb6afb46c14cf0e48f4906a1a4e"
      ],
      "tree": "1a5fee642ba294ea2541dedf3eec9ab54b6e449e",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/f5d3fc66016d54a16fd8872321d7722d4457526e"
      ]
    },
    {
      "commit": "419f7574010c066a56974fc9e3ac0709a08efb33",
      "parents": [
        "f5d3fc66016d54a16fd8872321d7722d4457526e",
        "6f27eb941f9edf138e7360e57db33499761c3c5e"
      ],
      "tree": "bdff859037cb007d345838f801d5123deead2ae0",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/419f7574010c066a56974fc9e3ac0709a08efb33"
      ]
    },
    {
      "commit": "0975683e984a65612f5ab18a67c413b899219098",
      "parents": [
        "419f7574010c066a56974fc9e3ac0709a08efb33"
      ],
      "tree": "49485d21ac65becd8eb121b4ed9b95efb1592dcb",
      "patch_id": "bfabd72a2c97f72d205a4e3296d43d78eedef5a2",
      "decision": "retain-candidate",
      "why": "Route fork checks to hosted runners and adapt package/tooling expectations; source does not enable Actions.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/0975683e984a65612f5ab18a67c413b899219098",
        ".github/actions/setup-apt-mirrors/action.yml",
        ".github/workflows/ci.yml",
        ".github/workflows/mobile-fingerprint-check.yml"
      ]
    },
    {
      "commit": "58de9088f487205fe168336d55e42aef16a794db",
      "parents": [
        "0975683e984a65612f5ab18a67c413b899219098"
      ],
      "tree": "847ebc21c76cf78b900c57d34f70ef2ba5dc39c1",
      "patch_id": "0e9ded360e482856c12ffd846d6bd21eb90483e9",
      "decision": "retain-candidate",
      "why": "Carry managed provider launch identity with environment/instance binding; identity is not itself launch authorization.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/58de9088f487205fe168336d55e42aef16a794db",
        "apps/server/src/provider/Layers/ProviderRegistry.test.ts",
        "apps/server/src/provider/Layers/ProviderRegistry.ts",
        "apps/server/src/provider/Layers/ProviderRegistryIdentity.test.ts"
      ]
    },
    {
      "commit": "0399d919cfa4ae3e03b2c061cafd8d9ae727f978",
      "parents": [
        "58de9088f487205fe168336d55e42aef16a794db"
      ],
      "tree": "6abb3f59d76bd7421fceecc2e7047dbfa9341681",
      "patch_id": "46739ea2b017835e37e0ca4a94952844c54a7806",
      "decision": "retain-candidate",
      "why": "Expose stable authenticated session subject for identity checks without returning credential material.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/0399d919cfa4ae3e03b2c061cafd8d9ae727f978",
        "apps/server/src/auth/EnvironmentAuth.test.ts",
        "apps/server/src/auth/EnvironmentAuth.ts",
        "packages/contracts/src/auth.ts"
      ]
    },
    {
      "commit": "b23234a628b13e63c30edb20758397523114bf62",
      "parents": [
        "0399d919cfa4ae3e03b2c061cafd8d9ae727f978"
      ],
      "tree": "85403e7fbbb703d40c950457c7c75a82de6b2ea2",
      "patch_id": "d15b2c716b03c6e52552f40938992561aadee149",
      "decision": "retain-candidate",
      "why": "Scope proxy model catalogs to configured custom catalogs rather than mixing incompatible provider entries.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/b23234a628b13e63c30edb20758397523114bf62",
        "apps/server/src/provider/Layers/CodexProvider.test.ts",
        "apps/server/src/provider/Layers/CodexProvider.ts",
        "apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts"
      ]
    },
    {
      "commit": "6c6f2d853e8f77f8fe86aa9455f9b4a4c3351262",
      "parents": [
        "0399d919cfa4ae3e03b2c061cafd8d9ae727f978"
      ],
      "tree": "b9ad969382018985129aed430cc99a54c8d5e179",
      "patch_id": "ddf115d82a3f4b14f19c92a7b5c4078b55b7214b",
      "decision": "retain-candidate",
      "why": "Use fixed hosted labels for fork release jobs rather than assuming the upstream runner fleet.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/6c6f2d853e8f77f8fe86aa9455f9b4a4c3351262",
        ".github/workflows/fork-release.yml",
        "docs/operations/fork-release.md",
        "scripts/lib/fork-release-workflow.test.ts"
      ]
    },
    {
      "commit": "131538a84c07680e48b156bf6c31b042a4092b0c",
      "parents": [
        "0399d919cfa4ae3e03b2c061cafd8d9ae727f978",
        "b23234a628b13e63c30edb20758397523114bf62"
      ],
      "tree": "85403e7fbbb703d40c950457c7c75a82de6b2ea2",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/131538a84c07680e48b156bf6c31b042a4092b0c"
      ]
    },
    {
      "commit": "23467c599a401b7a5baf3c7052f0d45a181bc278",
      "parents": [
        "131538a84c07680e48b156bf6c31b042a4092b0c",
        "6c6f2d853e8f77f8fe86aa9455f9b4a4c3351262"
      ],
      "tree": "b495adc3397301165aaa6f89c289be34ab784099",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/23467c599a401b7a5baf3c7052f0d45a181bc278"
      ]
    },
    {
      "commit": "cfee77e013f8fc14cfceaf59cffafcccc79fd43b",
      "parents": [
        "23467c599a401b7a5baf3c7052f0d45a181bc278"
      ],
      "tree": "ccb1c3d13b22188a9e2750c2952024eafebe2231",
      "patch_id": "ae2c2cbdf476bb8d59afc6b4165de3827d688f13",
      "decision": "retain-candidate",
      "why": "Require synthetic disposable fixtures; remove real-userdata copy/snapshot guidance.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/cfee77e013f8fc14cfceaf59cffafcccc79fd43b",
        "AGENTS.md"
      ]
    },
    {
      "commit": "1f8ba54063ea1f9ef2f1be8f5e50e2a7371c3eda",
      "parents": [
        "cfee77e013f8fc14cfceaf59cffafcccc79fd43b"
      ],
      "tree": "896c0a0c95102610297bb9a3419b5e39532a77a8",
      "patch_id": "0e80e11b7621bea7cb3935b9f5f2ab86ad232b56",
      "decision": "retain-candidate",
      "why": "Remove the remaining contradictory permission to use real userdata fixtures.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/1f8ba54063ea1f9ef2f1be8f5e50e2a7371c3eda",
        "AGENTS.md"
      ]
    },
    {
      "commit": "47a4f58a8b2ab1f235118fd686a31a713a4ebedf",
      "parents": [
        "1f8ba54063ea1f9ef2f1be8f5e50e2a7371c3eda"
      ],
      "tree": "43dbe3810ee311c4798dbee205552dafa31dea30",
      "patch_id": "19a37fa622ed4357d5413b9c6a1d416e8856893c",
      "decision": "retain-candidate",
      "why": "Link the canonical human assignment/recovery guide rather than duplicate it.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/47a4f58a8b2ab1f235118fd686a31a713a4ebedf",
        "AGENTS.md"
      ]
    },
    {
      "commit": "fdfab8dc193386aa476e56c50240dc432bb3479a",
      "parents": [
        "23467c599a401b7a5baf3c7052f0d45a181bc278"
      ],
      "tree": "d38ffb07362c879a03363fc7f0cdebb44aef69dd",
      "patch_id": "75f6e468d35b89116d3c4be56a32696dc89e3a50",
      "decision": "retain-candidate",
      "why": "Reject incompatible or stale callback route bindings before admission while preserving deliberate user selection.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/fdfab8dc193386aa476e56c50240dc432bb3479a",
        "apps/server/integration/OrchestrationEngineHarness.integration.ts",
        "apps/server/integration/orchestrationEngine.integration.test.ts",
        "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts"
      ]
    },
    {
      "commit": "170c0fab996b00750e835c5a9d7ac50fbf167f87",
      "parents": [
        "fdfab8dc193386aa476e56c50240dc432bb3479a",
        "47a4f58a8b2ab1f235118fd686a31a713a4ebedf"
      ],
      "tree": "b79bf4404be267273c422fe3fe38ba65c1d5bfb3",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/170c0fab996b00750e835c5a9d7ac50fbf167f87"
      ]
    },
    {
      "commit": "eb5d08c3143d94d9b672f75ab2b9f336581cc07f",
      "parents": [
        "170c0fab996b00750e835c5a9d7ac50fbf167f87"
      ],
      "tree": "356e7c1e9afd3c354a4a02e2070c51709df0baf1",
      "patch_id": "5890867370a8e9f371649987aae658e583895248",
      "decision": "retain-candidate",
      "why": "Run SEA packaging through vp exec so the expected build executable is resolved.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/eb5d08c3143d94d9b672f75ab2b9f336581cc07f",
        ".github/workflows/fork-release.yml",
        "scripts/lib/fork-release-workflow.test.ts"
      ]
    },
    {
      "commit": "eca73bdf0edf9265eea299c7513a5ab08a7411b7",
      "parents": [
        "eb5d08c3143d94d9b672f75ab2b9f336581cc07f"
      ],
      "tree": "ad532d4555097b47655466e14161caa83be11790",
      "patch_id": "88c102064d1005f366d51f0aeb3d236ef9f3b8bb",
      "decision": "retain-candidate",
      "why": "Restrict human reviewer requests to the verified owner, preserve authorized removal and technical review; no other-human fallback.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/eca73bdf0edf9265eea299c7513a5ab08a7411b7",
        "apps/server/src/pullRequest/PullRequestService.test.ts",
        "apps/server/src/pullRequest/PullRequestService.ts"
      ]
    },
    {
      "commit": "7a2b41e74f8c28115ef72375d2f6c63332a006b9",
      "parents": [
        "eca73bdf0edf9265eea299c7513a5ab08a7411b7"
      ],
      "tree": "fc6833a6f9ae0c7f4e006e25d62dd13b765ff368",
      "patch_id": "27361ea5c37b81db343c6db440d8c4df0f5c726e",
      "decision": "retain-candidate",
      "why": "Expose sustained silence during an active turn using server observations and stable receipts; not proof the provider is hung.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/7a2b41e74f8c28115ef72375d2f6c63332a006b9",
        "apps/mobile/src/features/review/shikiReviewHighlighter.test.ts",
        "apps/mobile/src/lib/threadActivity.ts",
        "apps/server/integration/OrchestrationEngineHarness.integration.ts"
      ]
    },
    {
      "commit": "55814122587a4cadfa1a9df1536c2c2c4dad3cb5",
      "parents": [
        "7a2b41e74f8c28115ef72375d2f6c63332a006b9"
      ],
      "tree": "8412316618103a03b7c70e15c0067db1b23f0dc9",
      "patch_id": "3d40cca12e995d7e18d67064bd3f7f9c05e01e14",
      "decision": "proposal",
      "why": "Add a Windows SCM host/graceful-stop/service protocol candidate; Windows placement remains separately qualified.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/55814122587a4cadfa1a9df1536c2c2c4dad3cb5",
        ".github/workflows/ci.yml",
        "apps/server/src/cli/service.test.ts",
        "apps/server/src/cli/service.ts"
      ]
    },
    {
      "commit": "08dbb72de3b9adabb8f4d796accea4f1db6ec139",
      "parents": [
        "55814122587a4cadfa1a9df1536c2c2c4dad3cb5"
      ],
      "tree": "6cd103d17edc041aab147c480a846c55b47ed1cb",
      "patch_id": "0d5d93cb2206de0682a63cfef447a51036df787a",
      "decision": "retain-candidate",
      "why": "Fail a missing OpenCode resumed session instead of silently reporting continuation; retain Linux pilot handoff checks.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/08dbb72de3b9adabb8f4d796accea4f1db6ec139",
        "apps/server/src/provider/Layers/OpenCodeAdapter.test.ts",
        "apps/server/src/provider/Layers/OpenCodeAdapter.ts",
        "apps/server/src/provider/Layers/ProviderService.test.ts"
      ]
    },
    {
      "commit": "404501a06b52fe7cc06d93ec5879ee72e3bf3bfc",
      "parents": [
        "08dbb72de3b9adabb8f4d796accea4f1db6ec139"
      ],
      "tree": "05b1021435a52b3a7b25f6f1a365cf046b1a5995",
      "patch_id": "1721988571c6f10d31153572606b3b7cf4260f67",
      "decision": "retain-candidate",
      "why": "Run bounded environment and account preflight before provider startup and surface structured warning/refusal evidence.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/404501a06b52fe7cc06d93ec5879ee72e3bf3bfc",
        "apps/server/integration/envchkP1WireAcceptance.integration.test.ts",
        "apps/server/integration/launchPreflightDelivery.integration.test.ts",
        "apps/server/integration/orphanedProviderSessionStartup.integration.test.ts"
      ]
    },
    {
      "commit": "cb9636bfede88938f4b2358ba439884c52760b4e",
      "parents": [
        "404501a06b52fe7cc06d93ec5879ee72e3bf3bfc"
      ],
      "tree": "4b6973cd81a58ec85ec93938c072f31243377889",
      "patch_id": "bdacf67c683163e64d1ccf608e9efe1d3d99d696",
      "decision": "retain-candidate",
      "why": "Carry native Intel DMG inspection receipts through release candidate verification.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/cb9636bfede88938f4b2358ba439884c52760b4e",
        ".github/workflows/fork-release.yml",
        ".github/workflows/release-desktop.yml",
        "scripts/lib/candidate-provenance-inspect.test.ts"
      ]
    },
    {
      "commit": "e3ff44102cbd6e93581d96b316d452218fcc9729",
      "parents": [
        "cb9636bfede88938f4b2358ba439884c52760b4e"
      ],
      "tree": "1457243324c119e8a05c7b838623cd24de38d4bf",
      "patch_id": "3e63a7fd533cd53d1a8c3c54fef8556a09fc1d0f",
      "decision": "retain-candidate",
      "why": "Bundle the jsonc parser via its ESM entry to prevent a packaged runtime import failure.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/e3ff44102cbd6e93581d96b316d452218fcc9729",
        "apps/server/src/provider/jsoncParserPack.test.ts",
        "apps/server/vite.config.ts"
      ]
    },
    {
      "commit": "59152d9d9d8fa363f03794ac2ed608ffa36779de",
      "parents": [
        "e3ff44102cbd6e93581d96b316d452218fcc9729"
      ],
      "tree": "6641d176e620f2a95127acd8e68805c69121b40d",
      "patch_id": "652b5bc64ac967c0555938856b839729c8094f47",
      "decision": "retain-candidate",
      "why": "Import receipts for the exact frozen candidate rather than changing the candidate being promoted.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/59152d9d9d8fa363f03794ac2ed608ffa36779de",
        ".github/workflows/fork-release.yml",
        "docs/operations/fork-release.md",
        "scripts/lib/fork-release-workflow.test.ts"
      ]
    },
    {
      "commit": "47947cb57d166f136af1a58f6033109f7325a6f5",
      "parents": [
        "59152d9d9d8fa363f03794ac2ed608ffa36779de"
      ],
      "tree": "5eb08eb7ff312564f6d14af90ae55aed7c13e228",
      "patch_id": "1bbb1e941a93724b9b8dd86a72809b332f5a0b99",
      "decision": "retain-candidate",
      "why": "Refuse unqualified typed Skill driver sessions; a discoverable Skill is not activation proof.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/47947cb57d166f136af1a58f6033109f7325a6f5",
        "apps/server/src/provider/Drivers/CodexTypedSkillsDriver.test.ts",
        "apps/server/src/provider/Drivers/CodexTypedSkillsDriver.ts",
        "apps/server/src/provider/builtInDrivers.ts"
      ]
    },
    {
      "commit": "9d83956644051d28c030b46cc6afea3fbe5f53e7",
      "parents": [
        "47947cb57d166f136af1a58f6033109f7325a6f5"
      ],
      "tree": "3a9214b8b930e8b67d21d2633aa03c15a91432c5",
      "patch_id": "b400914b177135d74b16849126efa24f72557982",
      "decision": "retain-candidate",
      "why": "Require explicit owner admission before relay deployment; source-only work must not deploy automatically.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/9d83956644051d28c030b46cc6afea3fbe5f53e7",
        ".github/workflows/deploy-relay.yml",
        "apps/server/scripts/deploy-relay-workflow.test.ts",
        "docs/operations/relay-observability.md"
      ]
    },
    {
      "commit": "d740e35e43ae0d411ddce5bd743887f72c495555",
      "parents": [
        "9d83956644051d28c030b46cc6afea3fbe5f53e7"
      ],
      "tree": "983419d72dfbc92ba5e4bc03f3fe0eb16d527167",
      "patch_id": "4b7c2651e64403f4ee84667c162f92f34ae8fecb",
      "decision": "retain-candidate",
      "why": "Bind Codex observations to process and turn lifecycle so stale observations cannot qualify a different launch.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/d740e35e43ae0d411ddce5bd743887f72c495555",
        "apps/server/src/provider/CodexSessionObservation.test.ts",
        "apps/server/src/provider/CodexSessionObservation.ts",
        "apps/server/src/provider/Drivers/CodexTypedSkillsDriver.ts"
      ]
    },
    {
      "commit": "9ebc81ada5298460dbb323c26e0e0f0e829c1107",
      "parents": [
        "d740e35e43ae0d411ddce5bd743887f72c495555"
      ],
      "tree": "3d65c013ea794392ffc9b7f485d75187d5925332",
      "patch_id": "b58b654fce26a17b116c0bf3209346abed0465ae",
      "decision": "retain-candidate",
      "why": "Resolve typed Skills for fresh Codex turns with exact context/source binding; refresh on new launch facts.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/9ebc81ada5298460dbb323c26e0e0f0e829c1107",
        "apps/server/src/git/GitManager.ts",
        "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
        "apps/server/src/provider/CodexSkillConsumer.canonical.integration.test.ts"
      ]
    },
    {
      "commit": "e97641abf69fb88538b53279ded28704b6ccb2b3",
      "parents": [
        "9ebc81ada5298460dbb323c26e0e0f0e829c1107"
      ],
      "tree": "3808dc0038d8a6b00e22398068e925265a01615f",
      "patch_id": "c78d8f99099bdbba9fde2e2a4a2feccc3fae6813",
      "decision": "retain-candidate",
      "why": "Observe account readiness before governed startup rather than accepting an unobserved account state.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/e97641abf69fb88538b53279ded28704b6ccb2b3",
        "apps/server/src/provider/CodexSkillConsumer.test.ts",
        "apps/server/src/provider/Layers/CodexGovernedRuntime.integration.test.ts",
        "apps/server/src/provider/Layers/CodexSessionRuntime.ts"
      ]
    },
    {
      "commit": "405f47c189187aa401821763c69c5e273de32831",
      "parents": [
        "e97641abf69fb88538b53279ded28704b6ccb2b3"
      ],
      "tree": "12456a0f25c122faf9f91ba55c3a89a4af85a2d5",
      "patch_id": "f275c64e1a01b413e25cfd5501956711989122d6",
      "decision": "retain-candidate",
      "why": "Make the synthetic Claude peer exit on EOF and prevent fixture subprocess leakage.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/405f47c189187aa401821763c69c5e273de32831",
        "apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts",
        "apps/server/src/provider/testFixtures/claudeTildeMock.mjs"
      ]
    },
    {
      "commit": "b62bf7922341d43d89d27ea5a5f7ce4fbe911e2b",
      "parents": [
        "405f47c189187aa401821763c69c5e273de32831"
      ],
      "tree": "d002334c948684bb61495c15b9db5282dfac2fcd",
      "patch_id": "748361624cae16277a347350fea09d2f48fdb0f8",
      "decision": "retain-candidate",
      "why": "Set the project preference for owned worktrees; runtime enforcement is separately implemented.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/b62bf7922341d43d89d27ea5a5f7ce4fbe911e2b",
        "t3.json"
      ]
    },
    {
      "commit": "e655ca7c445e74fe8b690fef39984d7a71e00e52",
      "parents": [
        "b62bf7922341d43d89d27ea5a5f7ce4fbe911e2b"
      ],
      "tree": "fc1b1936e756a9bba60484586163ed1210897457",
      "patch_id": "fcf33dec457626f9f5c5f0f8d0e328863fff5287",
      "decision": "retain-candidate",
      "why": "Add opt-in Codex guard refusal preflight; enforce deliberately refuses the unqualified lock-lifetime shape.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/e655ca7c445e74fe8b690fef39984d7a71e00e52",
        "apps/server/src/provider/CodexSessionGuard.test.ts",
        "apps/server/src/provider/CodexSessionGuard.ts",
        "apps/server/src/provider/Drivers/CodexDriver.test.ts"
      ]
    },
    {
      "commit": "aa1e770179d9f0066d15771ce540679755436d53",
      "parents": [
        "e655ca7c445e74fe8b690fef39984d7a71e00e52"
      ],
      "tree": "2841bdf8254ee5f1ee7de32d0b7d7b22dbb73145",
      "patch_id": "74f1a050623ef67c45e9f6f1f52ddf2f46527903",
      "decision": "retain-candidate",
      "why": "Reuse authorized routine browser verification authority rather than demanding repeated human permission.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/aa1e770179d9f0066d15771ce540679755436d53",
        "AGENTS.md"
      ]
    },
    {
      "commit": "96c7bf6475ca96ea02c8b09f938c693ae7cb3266",
      "parents": [
        "aa1e770179d9f0066d15771ce540679755436d53"
      ],
      "tree": "db321925c67217461c6d06cd0d262eef2d6b7fa5",
      "patch_id": "a12bd67c945fc654e5bf68932922de73557d1676",
      "decision": "retain-candidate",
      "why": "Isolate packaged macOS maintenance profiles across home paths, auth storage, exposure and discovery; no host installed proof.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/96c7bf6475ca96ea02c8b09f938c693ae7cb3266",
        "apps/desktop/src/app/DesktopApp.ts",
        "apps/desktop/src/app/DesktopAppIdentity.test.ts",
        "apps/desktop/src/app/DesktopAppIdentity.ts"
      ]
    },
    {
      "commit": "e3e4e54ac0d8a9d80b5dc648d973554f0c24ed8f",
      "parents": [
        "96c7bf6475ca96ea02c8b09f938c693ae7cb3266"
      ],
      "tree": "0bb481845a067fbfb29384f1580467b7e35c9eae",
      "patch_id": "d1f670948f7bb508ee215d1bb095fb0656566af8",
      "decision": "retain-candidate",
      "why": "Add honest model/task/agent provenance in PR and commit conventions.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/e3e4e54ac0d8a9d80b5dc648d973554f0c24ed8f",
        ".github/pull_request_template.md",
        "AGENTS.md"
      ]
    },
    {
      "commit": "bdd2b4abd58e54047e11c3d0aa9b862f60bc57a8",
      "parents": [
        "e3e4e54ac0d8a9d80b5dc648d973554f0c24ed8f"
      ],
      "tree": "42353bf8482b2ca9cacdd11d04377aca5eb3fa49",
      "patch_id": "9d30b7758e6856d93e68210b926c04617326b9be",
      "decision": "retain-candidate",
      "why": "Point agents at the canonical provenance hook rather than a second hand-maintained hook.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/bdd2b4abd58e54047e11c3d0aa9b862f60bc57a8",
        "AGENTS.md"
      ]
    },
    {
      "commit": "7c146a2c344496f51a93f4cce90763b16cc62437",
      "parents": [
        "96c7bf6475ca96ea02c8b09f938c693ae7cb3266",
        "bdd2b4abd58e54047e11c3d0aa9b862f60bc57a8"
      ],
      "tree": "42353bf8482b2ca9cacdd11d04377aca5eb3fa49",
      "patch_id": null,
      "decision": "retire-candidate",
      "why": "Merge already listed branch patches; exact parents and tree retain any merge-resolution effect for inspection. No separate product feature inferred from the merge title.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/7c146a2c344496f51a93f4cce90763b16cc62437"
      ]
    },
    {
      "commit": "8e5610de2b3cf8ae557d405794c0bb233795b9fe",
      "parents": [
        "7c146a2c344496f51a93f4cce90763b16cc62437"
      ],
      "tree": "03311284be139eec6edce4e2aaef84c3542a5e50",
      "patch_id": "5f982673495b0fca1853b07d15f62440c90cb556",
      "decision": "retain-candidate",
      "why": "Opt in to fail-closed Codex resume: propagate resume failures instead of silently starting a replacement; adds contracts tests beyond ASUS f014.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/8e5610de2b3cf8ae557d405794c0bb233795b9fe",
        "apps/server/src/provider/Layers/CodexAdapter.ts",
        "apps/server/src/provider/Layers/CodexSessionRuntime.test.ts",
        "apps/server/src/provider/Layers/CodexSessionRuntime.ts"
      ]
    },
    {
      "commit": "80b6cad46b93a1f72f4d07d75ffb26bed1dfc410",
      "parents": [
        "8e5610de2b3cf8ae557d405794c0bb233795b9fe"
      ],
      "tree": "5fddf6a351dd7aebeac916f9ec1fe5d4fe496579",
      "patch_id": "255cf638f2d28eaa67c2a52902f03707bf7835c2",
      "decision": "retain-candidate",
      "why": "Enforce owned worktrees for coding launches in server and clients, including execution-scope persistence.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/80b6cad46b93a1f72f4d07d75ffb26bed1dfc410",
        "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
        "apps/mobile/src/features/threads/ThreadRouteScreen.tsx",
        "apps/mobile/src/features/threads/new-task-context-presentation.test.ts"
      ]
    },
    {
      "commit": "569116e95c647cc1bfbd9f3132ca39d0e68f3d3a",
      "parents": [
        "80b6cad46b93a1f72f4d07d75ffb26bed1dfc410"
      ],
      "tree": "b8f11cb0e880ee397035cce83727493152d61b3c",
      "patch_id": "3793f6d65222884deb45d426dd502835433aedb0",
      "decision": "retain-candidate",
      "why": "Retain both historical/current owner identities in relay deployment admission across account transfer.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/569116e95c647cc1bfbd9f3132ca39d0e68f3d3a",
        ".github/workflows/deploy-relay.yml",
        "apps/server/scripts/deploy-relay-workflow.test.ts"
      ]
    },
    {
      "commit": "05993d81acd2eec0081e2b396bc52bc993bb2bf3",
      "parents": [
        "569116e95c647cc1bfbd9f3132ca39d0e68f3d3a"
      ],
      "tree": "3b78f67ba5e50799962e6347c12aa4c17a69d0b7",
      "patch_id": "5367a9a76fd469c79a3f78af90c5cad28e60a91f",
      "decision": "upstream-covered",
      "why": "Branch-based PR diff fix is an exact stable-patch match of upstream f22331240ed1a97fae560e314bffb75fe39db8ca in both pinned references. Retire its standalone replay when rebasing on official source.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/05993d81acd2eec0081e2b396bc52bc993bb2bf3",
        "apps/server/src/git/GitManager.test.ts",
        "apps/server/src/vcs/GitVcsDriverCore.ts",
        "https://github.com/pingdotgg/t3code/commit/f22331240ed1a97fae560e314bffb75fe39db8ca"
      ],
      "upstream_matches": {
        "official_v0_1_2": [
          "f22331240ed1a97fae560e314bffb75fe39db8ca"
        ],
        "upstream_main": [
          "f22331240ed1a97fae560e314bffb75fe39db8ca"
        ]
      }
    },
    {
      "commit": "f014905ed1c73600310accc6d2bc378c9d5c7840",
      "parents": [
        "e6ae764f47d678b96f4a1b2c8c76eedf1a342e26"
      ],
      "tree": "a1604e5f4aa1c778b40d884b2a9ce99122feea73",
      "patch_id": "ad29a358435933d3b86dbdbe8575897b921628b9",
      "decision": "retain-candidate",
      "why": "ASUS ships opt-in fail-closed Codex resume source; main 8e5610d carries the same six-file runtime patch plus contracts tests.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/f014905ed1c73600310accc6d2bc378c9d5c7840",
        "apps/server/src/provider/Layers/CodexAdapter.ts",
        "apps/server/src/provider/Layers/CodexSessionRuntime.test.ts",
        "apps/server/src/provider/Layers/CodexSessionRuntime.ts"
      ]
    },
    {
      "commit": "083270eb523fd7742b5e1490de042089e1aa7ffc",
      "parents": [
        "1a4a29998be205ad8fbb8dd6eefc2a730f025ca5"
      ],
      "tree": "6f6a6d7ef1778b90c5cabbde6a4fbbf91dda5bda",
      "patch_id": "a2c2c248129f2fcd559bf74d3665f9046d6f519a",
      "decision": "retain-candidate",
      "why": "Preserve Air AssemblyAI transcription: multipart config/audio, provider-specific authorization/model header, duration bounds and settings/UI/secret contracts.",
      "evidence": [
        "https://github.com/nullStack65/t3code/commit/083270eb523fd7742b5e1490de042089e1aa7ffc",
        "apps/server/src/serverSettings.test.ts",
        "apps/server/src/sourceControl/sourceControlHostSecrets.test.ts",
        "apps/server/src/speech/CloudSpeech.test.ts"
      ]
    }
  ],
  "external_candidates": {
    "clo802": {
      "head": "ec444939d7eb67eaeb632a6b7082e14ed5be433c",
      "base": "044f07257c9684ae4543bd1e1ebf9c394e9e3830",
      "state": "local-unpublished-snapshot",
      "entries": [
        {
          "commit": "40e7b0f2daf32e7a23fb9c0e4b89c31b92f3489c",
          "parents": [
            "044f07257c9684ae4543bd1e1ebf9c394e9e3830"
          ],
          "tree": "cffd8fcbd23472bcd3bf9f84d9c3c8440039eed3",
          "patch_id": "dfbc1e8ab2cea6e69e25d813269afce9af2068b2",
          "decision": "proposal",
          "why": "Candidate cursor-bound next persisted thread event over existing replay/livestream; interruptible MCP fetch and read-only CLI authentication.",
          "evidence": [
            "CLO-802 local source snapshot; not remotely published"
          ]
        },
        {
          "commit": "ec444939d7eb67eaeb632a6b7082e14ed5be433c",
          "parents": [
            "40e7b0f2daf32e7a23fb9c0e4b89c31b92f3489c"
          ],
          "tree": "15e7ee07c0316b47f7deaa0e00457ee103ff4398",
          "patch_id": "36b5d1720f86124cb91c18aaac115e35c385874c",
          "decision": "proposal",
          "why": "Provision next-event CLI parser dependencies together; test-only follow-up after the independent candidate review.",
          "evidence": [
            "CLO-802 local source snapshot; not remotely published"
          ]
        }
      ]
    }
  },
  "maintenance": {
    "id": "clo805-inventory-guard-release-report-v1",
    "decision": "proposal",
    "files": {
      ".github/workflows/fork-delta.yml": "42a049854ac85db4227dcdd629f0276b61fa10920d1467b198d9e3c1f6f15689",
      ".github/workflows/fork-upstream-drift.yml": "a3c6035c9d641ba4d090a83f5ce2c7a6e08685d07d3ac002cb75189f909bcfa7",
      "FORK_DELTA.md": "072e7f0a3e0e2068ffcf5e834cb0c339acc623efdbbaa8fd81592ecab71a92ce",
      "scripts/fork_delta/guard.py": "a6c54f6505649443ff126a74b99f620e052e10c915aeb33c182c5500a33aceeb",
      "scripts/fork_delta/release_report.py": "f96d82df62626a40876e244874eaa9a529275d36b99976d2eec788c2f6d2fa7b",
      "scripts/fork_delta/test_guard.py": "eda35559a4459473d92817e2f062e6c0aa7fd0222453c7661b51c6d2ec0f5f14",
      "scripts/fork_delta/test_release_report.py": "ed5586f9697d40fc472a7e85cd0716ab507514cb82fa126647a436de24eafe68"
    }
  }
}
```
<!-- fork-delta-manifest:end -->
