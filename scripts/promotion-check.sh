#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_REPO="${MERM_PRODUCTION_REPO:-/Users/josh/Desktop/p2p-signal}"
STAGING_BRANCH="${MERM_STAGING_BRANCH:-staging/setup-environment}"
PRODUCTION_BRANCH="${MERM_PRODUCTION_BRANCH:-main}"
STAGING_APP="${MERM_STAGING_APP:-p2p-signal-staging}"
PRODUCTION_APP="${MERM_PRODUCTION_APP:-p2p-signal}"

section() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_clean_repo() {
  local repo="$1"
  local label="$2"
  git -C "$repo" diff --quiet || fail "$label has unstaged changes."
  git -C "$repo" diff --cached --quiet || fail "$label has staged changes."
}

section "Repository safety"
[[ -d "$PRODUCTION_REPO/.git" ]] || fail "Production repo not found at $PRODUCTION_REPO"
[[ "$(git -C "$ROOT" branch --show-current)" == "$STAGING_BRANCH" ]] || fail "Staging repo must be on $STAGING_BRANCH"
[[ "$(git -C "$PRODUCTION_REPO" branch --show-current)" == "$PRODUCTION_BRANCH" ]] || fail "Production repo must be on $PRODUCTION_BRANCH"
require_clean_repo "$ROOT" "Staging repo"
require_clean_repo "$PRODUCTION_REPO" "Production repo"

section "Remote freshness"
git -C "$ROOT" fetch --quiet origin "$STAGING_BRANCH" "$PRODUCTION_BRANCH"
git -C "$PRODUCTION_REPO" fetch --quiet origin "$PRODUCTION_BRANCH"

staging_head="$(git -C "$ROOT" rev-parse HEAD)"
origin_staging_head="$(git -C "$ROOT" rev-parse "origin/$STAGING_BRANCH")"
[[ "$staging_head" == "$origin_staging_head" ]] || fail "Push staging first: local $STAGING_BRANCH is not equal to origin/$STAGING_BRANCH"

production_head="$(git -C "$PRODUCTION_REPO" rev-parse HEAD)"
origin_production_head="$(git -C "$PRODUCTION_REPO" rev-parse "origin/$PRODUCTION_BRANCH")"
[[ "$production_head" == "$origin_production_head" ]] || fail "Update production repo first: local $PRODUCTION_BRANCH is not equal to origin/$PRODUCTION_BRANCH"

section "Fly config guardrails"
grep -Eq "app *= *['\"]$STAGING_APP['\"]" "$ROOT/fly.staging.toml" || fail "fly.staging.toml does not target $STAGING_APP"
grep -Eq "app *= *['\"]$PRODUCTION_APP['\"]" "$ROOT/fly.toml" || fail "fly.toml does not target $PRODUCTION_APP"
if node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts["deploy:prod"] ? 0 : 1)' >/dev/null 2>&1; then
  fail "package.json must not contain deploy:prod in a staging working copy."
fi

section "Hardcoded production/staging scan"
bad_refs="$(
  git -C "$ROOT" grep -n -E \
    'https://merm-staging\.fly\.dev|https://p2p-signal-staging\.fly\.dev|wss://p2p-signal-staging\.fly\.dev|merm-staging-send-storage|merm-staging-signal-storage' \
    -- \
    ':!PROMOTION_RUNBOOK.md' \
    ':!scripts/*' \
    ':!fly.staging.toml' \
    ':!.env.staging.example' || true
)"
[[ -z "$bad_refs" ]] || fail "Unexpected hardcoded staging references found outside allowed config/docs:\n$bad_refs"

section "Commits queued for production"
if git -C "$ROOT" merge-base --is-ancestor "origin/$PRODUCTION_BRANCH" HEAD; then
  git -C "$ROOT" log --oneline --decorate "origin/$PRODUCTION_BRANCH..HEAD"
else
  fail "Staging is not based on origin/$PRODUCTION_BRANCH. Rebase or inspect divergence before promotion."
fi

section "Diff summary"
git -C "$ROOT" diff --stat "origin/$PRODUCTION_BRANCH..HEAD"

section "Result"
printf 'Promotion check passed for %s.\n' "$ROOT"
printf 'Next step after staging approval: MERM_PROMOTE_TO_PROD=1 npm run promotion:prepare\n'
