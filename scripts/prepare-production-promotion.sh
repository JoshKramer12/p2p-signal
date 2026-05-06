#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_REPO="${MERM_PRODUCTION_REPO:-/Users/josh/Desktop/p2p-signal}"
STAGING_BRANCH="${MERM_STAGING_BRANCH:-staging/setup-environment}"
PRODUCTION_BRANCH="${MERM_PRODUCTION_BRANCH:-main}"
PROMOTION_BRANCH="${MERM_PROMOTION_BRANCH:-promotion/p2p-signal-$(date +%Y%m%d-%H%M%S)}"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

if [[ "${MERM_PROMOTE_TO_PROD:-}" != "1" ]]; then
  cat >&2 <<EOF
This prepares a production promotion branch in:
  $PRODUCTION_REPO

It does not deploy production, but it does write to the production repo checkout.
Rerun with:
  MERM_PROMOTE_TO_PROD=1 npm run promotion:prepare
EOF
  exit 2
fi

"$ROOT/scripts/promotion-check.sh"

tmp_patch="$(mktemp "${TMPDIR:-/tmp}/merm-p2p-signal-promotion.XXXXXX.patch")"
trap 'rm -f "$tmp_patch"' EXIT

git -C "$ROOT" format-patch --stdout "origin/$PRODUCTION_BRANCH..$STAGING_BRANCH" > "$tmp_patch"
[[ -s "$tmp_patch" ]] || fail "No commits to promote."

git -C "$PRODUCTION_REPO" checkout "$PRODUCTION_BRANCH"
git -C "$PRODUCTION_REPO" pull --ff-only origin "$PRODUCTION_BRANCH"
git -C "$PRODUCTION_REPO" checkout -b "$PROMOTION_BRANCH"
git -C "$PRODUCTION_REPO" am --3way "$tmp_patch"

cat <<EOF

Prepared production promotion branch:
  $PRODUCTION_REPO
  $PROMOTION_BRANCH

Review before merging:
  cd $PRODUCTION_REPO
  git diff --stat $PRODUCTION_BRANCH..$PROMOTION_BRANCH
  git diff $PRODUCTION_BRANCH..$PROMOTION_BRANCH

Push for a PR when ready:
  git push -u origin $PROMOTION_BRANCH

Production deploy remains a separate explicit approval step.
EOF
