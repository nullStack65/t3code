# qa: feature map and Playwright verification

`qa/features.ts` is the map of every user-facing feature of the web app. `node qa/verify.ts` proves it:
it boots the production web build on a fresh, seeded T3 home with the free Replay agent, drives every
feature in a real browser at desktop (1440) and phone (390) widths in light and dark, and writes
`qa/status.json` (verified, broken or unverified per feature, with the commit) and the rendered
`docs/FEATURES.md` and `qa/report/index.html`.

```sh
vp i
cd apps/web && vp build && cd ..          # about 3 minutes, once
vp exec playwright install chromium       # or T3_QA_CHROMIUM=/path/to/chrome
node qa/verify.ts                         # all four projects; --project desktop-light for one
node qa/check-map.ts                      # map and specs agree
node qa/check-map.ts --changed origin/release/native-0.1.10   # the PR gate
node qa/serve.ts                          # keep one seeded app up while writing specs; T3_QA_REUSE=1 playwright test ...
```

Adding or changing a feature: edit its entry in `qa/features.ts` (path, drive steps, success state, code
paths), write or adjust its spec with `feature("<id>", ...)`, run `node qa/verify.ts`, and commit the
regenerated `qa/status.json` and `docs/FEATURES.md`. A feature that cannot be driven on this harness
carries `unverified: <reason>`; it shows as unverified, never as passing.

Other targets: set `T3_QA_BASE_URL` and `T3_QA_CREDENTIAL` (a browser-session credential) to drive a
running deployment. Behind Cloudflare Access also set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
for an Access service token. Never commit or log them. Do not point the suite at a founder's live
threads: it creates threads.

Visual baselines live in `qa/baselines/<set>/<project>/` and are compared only when present. A baseline
must come from the machine image that compares it (fonts and the browser build change pixels), so CI
baselines are made on the ARC runner with `T3_QA_UPDATE_BASELINES=1` and committed under `baselines/ci`.
Local baselines use `T3_QA_BASELINES=<name>` and are not committed.
