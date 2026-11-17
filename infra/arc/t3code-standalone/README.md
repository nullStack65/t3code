# t3code-standalone ARC runner scale set

Non-secret deployment source for the repository-scoped runner pool that runs
`.github/workflows/standalone-arc-ci.yml` (`runs-on: t3code-standalone-ci-arc`)
on the existing Closura ARC cluster. Task: CLO-866.

These files add one Helm release and one NetworkPolicy. They do not create a
controller, change the GitHub App, touch other pools or hold credentials.

| File | Purpose |
| --- | --- |
| `values.json` | `gha-runner-scale-set` 0.14.2 values: repo `nullStack65/t3code-standalone`, scale set and label `t3code-standalone-ci-arc`, min 0 / max 1, nonroot runner and egress-gate init container, no service-account token, 4Gi memory request / 8Gi limit, 16Gi work storage, `closura.io/arc-worker` Linux nodes (R720 preferred) |
| `network-policy.json` | `arc-t3code-standalone-runner-egress`: DNS plus public internet egress only; private, link-local and cluster ranges and the k3s API are blocked |
| `values-token-auth.json` | Optional, temporary overlay. Changes only `githubConfigSecret` to `t3code-standalone-arc-github-token` (see [Temporary token auth](#temporary-token-auth)) |

Credentials are referenced by Secret **name only**. By default that is
`closura-ci-arc-github-app`, the existing ARC App secret. No secret value
belongs in this repository.

## Provenance

These files are cloned from the qualified `t3code-ci-arc` values and policy,
with only the repository, scale-set name, label and resources changed. Root
staged them on 2026-11-17 and ran a server dry-run against chart 0.14.2 (all
four resource kinds passed; nothing was applied).

- `network-policy.json`: byte-identical to the staged file,
  sha256 `be3bcbcd1c58911d2f8f09ea62076752d86c89674011b7d9d63163b7418d5e7b`.
- `values.json`: the staged file (sha256
  `432eddef849e530220957190ea96367257c2d836e99b6a5c3bee37c2648ae006`) with one
  correction. `scaleSetLabels` still held the fork pool's label `t3code-ci-arc`,
  so it now reads `t3code-standalone-ci-arc` to match the workflow's `runs-on`.
  Result sha256 `a256c096c770347e1fc0bb48e533de4ec718077691a784530974b98ee4be570d`.
  Re-run the server dry-run with this file before applying.

## Prerequisites

1. The existing ARC GitHub App installation must include
   `nullStack65/t3code-standalone`. Add only this repository; do not switch
   the installation to all repositories.
2. The `arc-systems` controller and the `arc-runners` namespace already exist,
   and Secret `closura-ci-arc-github-app` is present in `arc-runners`.
3. Run from the ARC controller with the cluster admin kubeconfig, in a quiet
   window. Other pools are not touched.

## Deploy

```sh
CHART=oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
k3s kubectl -n arc-runners get autoscalingrunnerset t3code-standalone-ci-arc --ignore-not-found  # must print nothing

# Dry runs
k3s kubectl apply --dry-run=server -f infra/arc/t3code-standalone/network-policy.json
helm template t3code-standalone-ci-arc "$CHART" --version 0.14.2 \
  --namespace arc-runners -f infra/arc/t3code-standalone/values.json \
  | k3s kubectl apply --dry-run=server -f -

# Apply: egress policy first, then the scale set
k3s kubectl apply -f infra/arc/t3code-standalone/network-policy.json
helm install t3code-standalone-ci-arc "$CHART" --version 0.14.2 \
  --namespace arc-runners -f infra/arc/t3code-standalone/values.json \
  --atomic --wait --timeout 10m
```

## Verify

```sh
k3s kubectl -n arc-runners get autoscalingrunnerset t3code-standalone-ci-arc \
  -o jsonpath='{.spec.githubConfigUrl} {.spec.runnerScaleSetLabels} {.spec.minRunners}/{.spec.maxRunners}{"\n"}'
k3s kubectl -n arc-systems get pods | grep t3code-standalone   # listener Running
```

Then dispatch **T3 standalone ARC CI** on `standalone/main`. A runner pod named
`t3code-standalone-ci-arc-*` should pick the job up, and the job log's
"Prove exact ARC repository and worker" step shows the runner name.

## Temporary token auth

Use this only while the existing ARC GitHub App installation cannot yet be
granted `nullStack65/t3code-standalone`. It switches only this pool to ARC's
native `github_token` authentication, using an existing, already authorized
owner credential with admin access to this repository. It adds no scopes and
does not change the App, the controller or any other pool. This is the
standard scale-set flow, not manual JIT runner registration.

**Custody.** The token is stored only in Kubernetes Secret
`t3code-standalone-arc-github-token` (key `github_token`) in `arc-runners`.
- The ARC controller reads it, and passes it to this pool's listener in
  `arc-systems` through the controller-managed listener config.
- Runner pods do not mount it. Each job gets only a short-lived, per-runner
  registration (JIT) config from GitHub, and the runner pods have
  `automountServiceAccountToken: false`.
- Never commit, print, log or pass the value on a command line. Create the
  Secret from a `0600` file and remove the file afterwards.

```sh
# On the controller only. TOKEN_FILE holds the credential, mode 0600, outside any repository.
k3s kubectl -n arc-runners create secret generic t3code-standalone-arc-github-token \
  --from-file=github_token="$TOKEN_FILE"
shred -u "$TOKEN_FILE"   # or rm, if shred is unavailable
k3s kubectl -n arc-runners label secret t3code-standalone-arc-github-token \
  closura.io/workstream=clo866 closura.io/temporary=true
```

Deploy as above, adding the overlay after `values.json` in both the dry run
and the install:

```sh
helm install t3code-standalone-ci-arc "$CHART" --version 0.14.2 \
  --namespace arc-runners -f infra/arc/t3code-standalone/values.json \
  -f infra/arc/t3code-standalone/values-token-auth.json \
  --atomic --wait --timeout 10m
```

To use a different Secret name, pass `--set githubConfigSecret=<name>`
instead of the overlay. Use a name only, never a value.

**Switch back to the App and clean up.** Once the App installation includes
this repository:

```sh
helm upgrade t3code-standalone-ci-arc "$CHART" --version 0.14.2 \
  --namespace arc-runners -f infra/arc/t3code-standalone/values.json \
  --atomic --wait --timeout 10m
k3s kubectl -n arc-runners get autoscalingrunnerset t3code-standalone-ci-arc \
  -o jsonpath='{.spec.githubConfigSecret}{"\n"}'   # expect closura-ci-arc-github-app
k3s kubectl -n arc-systems get pods | grep t3code-standalone   # listener Running again
k3s kubectl -n arc-runners delete secret t3code-standalone-arc-github-token
```

Deleting the Secret ends ARC's custody of the credential. The credential
itself stays the owner's working credential: do not revoke or rotate it as
part of this cleanup.

## Rollback

Removing the pool only stops this repository's CI; it affects no other pool.

```sh
helm uninstall t3code-standalone-ci-arc --namespace arc-runners --wait
k3s kubectl -n arc-runners delete networkpolicy arc-t3code-standalone-runner-egress --ignore-not-found
k3s kubectl -n arc-runners delete secret t3code-standalone-arc-github-token --ignore-not-found  # only if token auth was used
```

Queued jobs stay queued until a pool with the label exists again, or until
GitHub expires them after 24 hours.
