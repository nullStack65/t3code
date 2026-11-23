#!/usr/bin/env bash
# Daily upstream sync for the nullStack65/t3code fork.
#
# Fetches upstream main. A clean merge into sync/upstream-<date>, cut from the
# release line, is pushed and opened as a pull request. An existing sync branch
# is updated by merge, never by force-push. Conflicts, and a push that is not
# a fast-forward, are written to one issue for Platform / CTO.
#
# DRY_RUN=1 prints the decision and does not commit, push, or call gh.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

base="${BASE_BRANCH:-release/native-0.1.10}"
date="${SYNC_DATE:-$(date -u +%Y-%m-%d)}"
branch="sync/upstream-${date}"
remote="${PUSH_REMOTE:-origin}"
upstream_url="${UPSTREAM_URL:?UPSTREAM_URL is required}"
repo="${GH_REPO:-nullStack65/t3code}"
dry="${DRY_RUN:-0}"
ci_flag=()
if [ -n "${T3_FORK_SYNC_TOKEN:-}" ]; then
  ci_flag=(--ci-will-start)
fi

file_issue() {
  local decision="$1"
  local body
  body="$(mktemp)"
  node --input-type=module -e '
    const decision = JSON.parse(process.argv[1]);
    process.stdout.write(decision.issue ?? "");
  ' "$decision" >"$body"
  local existing
  existing="$(gh issue list --repo "$repo" --state open --search "Upstream sync blocked in:title" --json number --jq '.[0].number // empty')"
  if [ -z "$existing" ]; then
    gh issue create --repo "$repo" --title "Upstream sync blocked" --body-file "$body"
  else
    gh issue comment "$existing" --repo "$repo" --body-file "$body"
  fi
  rm -f "$body"
}

git fetch --no-tags "$upstream_url" main:refs/remotes/upstream/main
git fetch --no-tags "$remote" "$base:refs/remotes/origin/$base"
if git fetch --no-tags "$remote" "$branch:refs/remotes/origin/$branch" 2>/dev/null; then
  have_branch=1
else
  have_branch=0
fi

set +e
receipt="$(node scripts/fork-drift-receipt.mjs --base "origin/$base")"
receipt_rc=$?
set -e
if [ "$receipt_rc" -eq 2 ]; then
  printf '%s\n' "$receipt" >&2
  exit 2
fi

read -r behind ahead merge_base < <(
  node --input-type=module -e '
    const drift = JSON.parse(process.argv[1]);
    process.stdout.write(`${drift.behind} ${drift.ahead} ${drift.mergeBase}\n`);
  ' "$receipt"
)

plan() {
  node scripts/fork-sync-plan.mjs \
    --behind "$behind" \
    --ahead "$ahead" \
    --merge-base "$merge_base" \
    --date "$date" \
    "$@" \
    "${ci_flag[@]}"
}

stop_for() {
  local decision extra=()
  if [ ! -s "$conflicts_file" ] && [[ " $* " != *" --push-rejected "* ]]; then
    extra+=(--merge-failed)
  fi
  decision="$(plan "$@" "${extra[@]}")"
  printf '%s\n' "$decision"
  git merge --abort >/dev/null 2>&1 || git reset --hard HEAD
  if [ "$have_branch" = 1 ]; then
    git checkout -B "$branch" "origin/$branch" >/dev/null 2>&1 || true
  else
    git checkout -B "$base" "origin/$base" >/dev/null 2>&1 || true
  fi
  if [ "$dry" = 1 ]; then
    exit 0
  fi
  file_issue "$decision"
  exit 0
}

if [ "$behind" -eq 0 ]; then
  plan
  exit 0
fi

if [ "$have_branch" = 1 ]; then
  git checkout -B "$branch" "origin/$branch"
else
  git checkout -B "$branch" "origin/$base"
fi
git branch --unset-upstream "$branch" >/dev/null 2>&1 || true

conflicts_file="$(mktemp)"
trap 'rm -f "$conflicts_file"' EXIT

merge_one() {
  local ref="$1"
  : >"$conflicts_file"
  set +e
  git merge --no-ff --no-commit "$ref"
  local merge_rc=$?
  set -e
  git diff --name-only --diff-filter=U >"$conflicts_file" || true
  if [ -s "$conflicts_file" ] || [ "$merge_rc" -ne 0 ]; then
    return 1
  fi
  if git diff --cached --quiet; then
    git merge --abort >/dev/null 2>&1 || true
  else
    git -c user.name="github-actions[bot]" \
      -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit -m "Merge ${ref} into ${branch}"
  fi
}

if [ "$have_branch" = 1 ]; then
  if ! merge_one "origin/$base"; then
    stop_for --conflicts-file "$conflicts_file"
  fi
fi

if ! merge_one upstream/main; then
  stop_for --conflicts-file "$conflicts_file"
fi

if [ "$dry" = 1 ]; then
  plan
  exit 0
fi

set +e
git push "$remote" "HEAD:refs/heads/${branch}"
push_rc=$?
set -e
if [ "$push_rc" -ne 0 ]; then
  stop_for --push-rejected
fi

decision="$(plan)"
printf '%s\n' "$decision"
body="$(mktemp)"
node --input-type=module -e '
  const decision = JSON.parse(process.argv[1]);
  process.stdout.write(decision.pullRequest ?? "");
' "$decision" >"$body"
existing="$(gh pr list --repo "$repo" --head "$branch" --base "$base" --json number --jq '.[0].number // empty')"
if [ -z "$existing" ]; then
  gh pr create --repo "$repo" --base "$base" --head "$branch" \
    --title "sync: upstream main ${date}" --body-file "$body"
else
  gh pr edit "$existing" --repo "$repo" --body-file "$body"
fi
rm -f "$body"
