#!/usr/bin/env bash
# Daily proposal for the fork's protected release line.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base="${BASE_BRANCH:-release/native-0.1.10}"
date="${SYNC_DATE:-$(date -u +%Y-%m-%d)}"
upstream_url="${UPSTREAM_URL:?UPSTREAM_URL is required}"
repo="${GH_REPO:-nullStack65/t3code}"
dry="${DRY_RUN:-0}"
report=docs/upstream-sync/pending.md

export GIT_AUTHOR_NAME='Upstream Sync'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_TERMINAL_PROMPT=0

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if [[ "$dry" != 1 ]]; then
  : "${GH_TOKEN:?Configure the T3_FORK_SYNC_TOKEN Actions secret for nullStack65}"
  actor=$(gh api user --jq .login)
  if [[ "$actor" != nullStack65 ]]; then
    echo 'The sync credential must authenticate as the CI-admitted nullStack65 account.' >&2
    exit 1
  fi
fi

git fetch --no-tags "$upstream_url" main:refs/remotes/upstream/main
git fetch --no-tags origin "$base:refs/remotes/origin/$base"
release=$(git rev-parse "refs/remotes/origin/$base")
upstream=$(git rev-parse refs/remotes/upstream/main)
merge_base=$(git merge-base "$release" "$upstream")
read -r ahead behind < <(git rev-list --left-right --count "$release...$upstream")

if git merge-base --is-ancestor "$upstream" "$release"; then
  echo 'The protected release already contains upstream.'
  exit 0
fi

number= branch="sync/upstream-proposal-$date-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}" draft=true old_head=
if [[ "$dry" != 1 ]]; then
  gh api --paginate --method GET "repos/$repo/pulls" -f state=open -f base="$base" -F per_page=100 \
    | jq -s --arg repo "$repo" '[.[][] | select((.head.repo.full_name // "" | ascii_downcase) == ($repo | ascii_downcase)) | select(.head.ref | test("^sync/(upstream-|clo-1110-upstream-)"))]' \
    > "$scratch/proposals"
  if [[ $(jq length "$scratch/proposals") -gt 1 ]]; then
    echo 'Multiple upstream proposals are open. Platform / CTO must reconcile them.' >&2
    exit 1
  fi
  if [[ $(jq length "$scratch/proposals") -eq 1 ]]; then
    read -r number branch draft old_head author < <(jq -r '.[0] | [.number,.head.ref,.draft,.head.sha,.user.login] | @tsv' "$scratch/proposals")
    if [[ ! "$branch" =~ ^sync/upstream-proposal-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+-[0-9]+$ || "$author" != "$actor" ]]; then
      echo "Upstream reconciliation is owned by the existing PR #$number."
      exit 0
    fi
    git fetch --no-tags origin "refs/heads/$branch"
    [[ $(git rev-parse FETCH_HEAD) == "$old_head" ]] || { echo 'Proposal head changed during discovery.' >&2; exit 1; }
  fi
fi

# Compute conflict paths without a worktree merge or executing candidate code.
status=0
if git merge-tree --write-tree --name-only -z "$release" "$upstream" > "$scratch/merge-tree"; then
  :
else
  status=$?
  [[ "$status" == 1 ]] || exit "$status"
fi

mode=clean
if [[ "$status" == 1 ]]; then
  mode=conflict
elif [[ "${ADMITTED_UPSTREAM_SHA:-}" != "$upstream" ]]; then
  mode=admission
fi

if [[ "$dry" == 1 ]]; then
  node scripts/fork-sync-plan.mjs "$mode" "$date" "$release" "$release" "$upstream" "$merge_base" "$ahead" "$behind" "$scratch/merge-tree" false
  exit 0
fi

# Only publish upstream code after the exact SHA has been admitted. A same-repo
# PR can run workflow files with repository credentials and reach private CI.
cp scripts/{fork-sync-plan,fork-drift-receipt}.mjs "$scratch/"
git switch --detach "${old_head:-$release}"
merge_into_proposal() {
  local ref="$1"
  if git merge --no-ff --no-commit "$ref"; then return 0; fi
  git diff --name-only --diff-filter=U -z > "$scratch/merge-conflicts"
  [[ -s "$scratch/merge-conflicts" ]] || exit 1
  { printf 'tree\0'; cat "$scratch/merge-conflicts"; } > "$scratch/merge-tree"
  git merge --abort
  git switch --detach "${old_head:-$release}"
  mode=conflict
}

if [[ "$mode" == clean ]]; then
  merge_into_proposal "$release"
  if [[ "$mode" == clean ]] && git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
    git -c commit.gpgsign=false commit -m "Merge $base into $branch" -m $'Model: github-actions\nTask: upstream-sync\nAgent: upstream-sync workflow'
  fi
  if [[ "$mode" == clean ]]; then merge_into_proposal "$upstream"; fi
  if [[ "$mode" == clean ]]; then
    if [[ -f "$report" ]]; then git rm -- "$report"; fi
    if ! git diff --cached --quiet || git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
      git -c commit.gpgsign=false commit -m "Merge upstream $upstream" -m $'Model: github-actions\nTask: upstream-sync\nAgent: upstream-sync workflow'
    fi
  fi
fi

if [[ "$mode" != clean ]]; then
  if [[ "$draft" == false ]]; then
    gh pr ready "$number" --repo "$repo" --undo
    draft=true
  fi
  if [[ -z "$old_head" ]]; then
    mkdir -p "$(dirname "$report")"
    printf '# Upstream sync triage\n\nSee the pull request description for the current refs and triage status.\n' > "$report"
    git add -- "$report"
    git -c commit.gpgsign=false commit -m 'docs(sync): open upstream triage proposal' -m $'Model: github-actions\nTask: upstream-sync\nAgent: upstream-sync workflow'
  fi
fi

head=$(git rev-parse HEAD)
ancestor=false
if git merge-base --is-ancestor "$upstream" "$head"; then ancestor=true; fi
if [[ "$mode" == clean ]] && { [[ "$ancestor" != true ]] || ! git merge-base --is-ancestor "$release" "$head"; }; then
  echo 'The proposed clean merge must contain both pinned inputs.' >&2
  exit 1
fi
node "$scratch/fork-sync-plan.mjs" "$mode" "$date" "$head" "$release" "$upstream" "$merge_base" "$ahead" "$behind" "$scratch/merge-tree" "$ancestor" > "$scratch/body"
title=$(head -n 1 "$scratch/body")

if [[ "$head" != "$old_head" ]]; then
  git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin "HEAD:refs/heads/$branch"
fi

if [[ -z "$number" ]]; then
  draft_args=()
  if [[ "$mode" != clean ]]; then draft_args=(--draft); fi
  gh pr create --repo "$repo" --base "$base" --head "$branch" --title "$title" --body-file "$scratch/body" "${draft_args[@]}"
else
  gh api --method PATCH "repos/$repo/pulls/$number" -f title="$title" -F body=@"$scratch/body" --jq .html_url
  if [[ "$mode" == clean && "$draft" == true ]]; then
    gh pr ready "$number" --repo "$repo"
  fi
fi
