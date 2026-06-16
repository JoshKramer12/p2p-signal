# Merm Signal Promotion Runbook

This repo uses a staging-first promotion model.

Professional release rule:

- Code is promoted by git commit, not by copying random files.
- Staging and production code should be identical at promotion time.
- Staging and production configuration must remain different.
- Production deploys are separate, explicit actions after review.

## Environments

Staging:

- App: `p2p-signal-staging`
- Runtime URL: `https://p2p-signal-staging.fly.dev/runtime-config.js`
- Branch: `staging/setup-environment`

Production:

- App: `p2p-signal`
- Runtime URL: `https://p2p-signal.fly.dev/runtime-config.js`
- Branch: `main`

## Fly Storage Safety Warning

Do not run `fly storage create` for benchmark buckets from this staging repo unless you first verify the Fly app target and understand the secret side effects.

Why:

- This staging working copy still contains a local `fly.toml` with `app = 'p2p-signal'`.
- `fly storage create` can use the current app context and automatically set `AWS_*` / `BUCKET_NAME` secrets on that app.
- That means a bucket experiment can unexpectedly touch production secrets if the app target is not pinned correctly.

Required rule:

- Treat `fly storage create` as production-risky from staging repos.
- Do not use it for benchmark buckets unless you explicitly verify `-a <expected-app>` and `-c <expected-config>` and confirm which app will receive secret updates.
- Prefer creating benchmark buckets from an isolated shell or Tigris Dashboard instead of from a staging repo directory.

## Normal Bugfix Flow

1. Make the fix in `/Users/josh/Desktop/p2p-signal-staging`.
2. Commit and push `staging/setup-environment`.
3. Deploy staging:

```bash
npm run deploy:staging
```

4. Verify staging runtime config:

```bash
npm run verify:staging
```

5. Test account login, friend requests, messaging, upload/download, and read/unread sync on staging.
6. Run the promotion readiness check:

```bash
npm run promotion:check
```

7. Prepare a production promotion branch only after staging approval:

```bash
MERM_PROMOTE_TO_PROD=1 npm run promotion:prepare
```

8. Review the production branch diff in `/Users/josh/Desktop/p2p-signal`.
9. Push that branch and open a PR, or merge locally when you explicitly decide to promote.
10. Deploy production from the production repo only after merge/approval:

```bash
cd /Users/josh/Desktop/p2p-signal
fly deploy -c fly.toml -a p2p-signal
```

11. Verify production runtime config:

```bash
cd /Users/josh/Desktop/p2p-signal-staging
npm run verify:production
```

## Promotion Check Philosophy

`npm run promotion:check` fails if:

- The staging repo is dirty.
- The production repo is dirty.
- The staging branch has not been pushed.
- The production repo is not up to date with `origin/main`.
- Fly config targets the wrong app.
- A staging working copy regains a convenient `deploy:prod` npm script.
- Hardcoded staging hosts or staging buckets appear outside allowed config/docs.

## What Should Differ

Allowed differences between staging and production:

- Fly app names.
- Fly volumes.
- Runtime env vars and secrets.
- Object-storage buckets and prefixes.
- Sanitized staging data copied from production.

Not allowed:

- Different backend behavior.
- Hardcoded production or staging URLs in app runtime paths.
- Manual production edits that did not pass through staging.
- Staging secrets or buckets used by production.

## Deploy Order

When a change touches both signal and web:

1. Deploy `p2p-signal` production first if the backend change is backward compatible.
2. Deploy `merm` production second.
3. If a change is not backward compatible, split it into two releases: compatibility first, behavior switch second.

## Rollback Rule

Every production deploy should have a known previous good commit. If production breaks:

1. Stop making new changes.
2. Redeploy the previous known good production commit or Fly image.
3. Confirm production runtime config still points to production.
4. Fix forward in staging.
