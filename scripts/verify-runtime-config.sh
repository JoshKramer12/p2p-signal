#!/usr/bin/env bash
set -euo pipefail

mode="${1:-staging}"

case "$mode" in
  staging)
    signal_url="https://p2p-signal-staging.fly.dev/runtime-config.js"
    must_have=("deployEnv\":\"staging" "p2p-signal-staging.fly.dev")
    must_not_have=("https://p2p-signal.fly.dev" "wss://p2p-signal.fly.dev")
    ;;
  production|prod)
    signal_url="https://p2p-signal.fly.dev/runtime-config.js"
    must_have=("p2p-signal.fly.dev")
    must_not_have=("p2p-signal-staging.fly.dev" "deployEnv\":\"staging")
    ;;
  *)
    printf 'Usage: %s [staging|production]\n' "$0" >&2
    exit 2
    ;;
esac

payload="$(curl --fail --silent --show-error --max-time 15 "$signal_url")"

for needle in "${must_have[@]}"; do
  if ! grep -Fq "$needle" <<<"$payload"; then
    printf 'ERROR: runtime config for %s is missing expected value: %s\n' "$mode" "$needle" >&2
    exit 1
  fi
done

for needle in "${must_not_have[@]}"; do
  if grep -Fq "$needle" <<<"$payload"; then
    printf 'ERROR: runtime config for %s contains forbidden value: %s\n' "$mode" "$needle" >&2
    exit 1
  fi
done

printf 'Runtime config check passed for %s.\n' "$mode"
