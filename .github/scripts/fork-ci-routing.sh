#!/usr/bin/env bash
#
# Fork CI routing guard.
#
# Decide whether a CI run may execute on the fork's owner-admitted self-hosted
# validation capacity, and fail closed with an exact reason when it may not.
# This is the single source of truth for the routing policy documented in
# `docs/internals/fork-ci.md`. `.github/workflows/ci.yml` runs it before any
# checkout or install, and `.github/scripts/fork-ci-routing.test.py` exercises
# it with bounded fixtures.
#
# Inputs (environment):
#   EVENT_NAME             github.event_name
#   HEAD_REPO              github.event.pull_request.head.repo.full_name ("" otherwise)
#   REPOSITORY             github.repository
#   AUTHORIZED             vars.T3CODE_AUTHORIZED_RUNNERS (comma-separated labels)
#   T3CODE_LINUX_RUNNER    vars.T3CODE_LINUX_RUNNER
#   T3CODE_MACOS_X64_RUNNER vars.T3CODE_MACOS_X64_RUNNER
#   REQUIRED_ROLES         space-separated roles this run needs (default: linux)
#
# Output and exit codes:
#   0  ADMITTED               every required role is declared and authorized
#   2  CAPACITY_NOT_CONFIGURED a required runner variable or the authorized list
#                             is unset or empty
#   3  UNTRUSTED_FORK         an external or unidentified pull request; never
#                             routed onto self-hosted capacity
#   4  RUNNER_NOT_AUTHORIZED  a declared label is absent from the authorized list
#   5  UNTRUSTED_CONTEXT      an unknown event or an unidentified repository;
#                             nothing can be trusted, so refuse
#
# The workflow does not require this file to exist at the pull request base: on
# first introduction the base tree predates it, so the workflow carries an
# equivalent bootstrap (see `.github/workflows/ci.yml`). This script stays the
# single policy definition and `fork-ci-routing.test.py` cross-checks the
# bootstrap against it.
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
HEAD_REPO="${HEAD_REPO:-}"
REPOSITORY="${REPOSITORY:-}"
AUTHORIZED="${AUTHORIZED:-}"
REQUIRED_ROLES="${REQUIRED_ROLES:-linux}"

fail() {
  local token="$1" message="$2" code="$3"
  printf '%s: %s\n' "$token" "$message" >&2
  exit "$code"
}

trim() {
  printf '%s' "$1" | tr -d '[:space:]'
}

is_authorized() {
  local label="$1" candidate
  local IFS=','
  for candidate in $AUTHORIZED; do
    candidate="$(trim "$candidate")"
    if [ "$candidate" = "$label" ]; then
      return 0
    fi
  done
  return 1
}

runner_var() {
  case "$1" in
    linux) printf '%s' "${T3CODE_LINUX_RUNNER:-}" ;;
    macos) printf '%s' "${T3CODE_MACOS_X64_RUNNER:-}" ;;
  esac
}

# 0. Context. Only the two events this workflow is wired to are routable, and an
#    unidentified repository cannot be verified. Refuse anything else instead of
#    falling through to admission.
case "$EVENT_NAME" in
  pull_request | push) ;;
  *)
    fail UNTRUSTED_CONTEXT \
      "unsupported event '$EVENT_NAME'; only pull_request and push are routed" 5
    ;;
esac
if [ -z "$REPOSITORY" ]; then
  fail UNTRUSTED_CONTEXT \
    "repository identity is empty; the event origin cannot be verified" 5
fi

# 1. Trust. A pull request must come from this repository. An empty head
#    repository is unidentified, which is not the same as trusted, so it is
#    rejected too. The workflow's job-level guard also blocks external PRs
#    before a runner is even allocated; this check keeps the policy honest if
#    that changes.
if [ "$EVENT_NAME" = "pull_request" ] && [ "$HEAD_REPO" != "$REPOSITORY" ]; then
  fail UNTRUSTED_FORK \
    "pull request head '$HEAD_REPO' is not '$REPOSITORY'; external or unidentified PR code is never routed to self-hosted runner capacity" 3
fi

# 2. Owner-declared admission. An absent declaration is unknown capacity, not
#    permission to guess a label.
if [ -z "$AUTHORIZED" ]; then
  fail CAPACITY_NOT_CONFIGURED \
    "repository variable T3CODE_AUTHORIZED_RUNNERS is unset or empty; set it to the comma-separated self-hosted runner labels this fork may use" 2
fi

admitted=""
for role in $REQUIRED_ROLES; do
  case "$role" in
    linux | macos) ;;
    *) fail CAPACITY_NOT_CONFIGURED "unknown required role '$role'" 2 ;;
  esac

  label="$(runner_var "$role")"
  if [ -z "$label" ]; then
    case "$role" in
      linux) var="T3CODE_LINUX_RUNNER" ;;
      macos) var="T3CODE_MACOS_X64_RUNNER" ;;
    esac
    fail CAPACITY_NOT_CONFIGURED \
      "repository variable $var is unset or empty; no admitted $role validation capacity is declared" 2
  fi
  if ! is_authorized "$label"; then
    fail RUNNER_NOT_AUTHORIZED \
      "declared $role runner '$label' is not listed in T3CODE_AUTHORIZED_RUNNERS" 4
  fi
  admitted="$admitted $role=$label"
done

printf 'ADMITTED%s\n' "$admitted"