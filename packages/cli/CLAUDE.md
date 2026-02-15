# Crate CLI

## Worker Bindings

The worker uses these binding types:
- **r2_bucket** — `BUCKET` (R2 storage)
- **secret_text** — `AUTH_TOKEN` (auth secret), `CF_ANALYTICS_TOKEN` (analytics sub-token, optional)
- **d1** — `DB` (changelog database)
- **plain_text** — `CF_ACCOUNT_ID`, `CF_WORKER_NAME`, `CF_BUCKET_NAME`, `CF_DATABASE_ID` (config vars exposed via `/sync/config`)

When adding new worker bindings, you must update **two** places:

1. **`commands/init.ts`** — `deployWorker()` call sets all bindings for fresh installs
2. **`cloudflare/api.ts` → `redeployWorker()`** — ensure `keep_bindings` preserves the binding type so `crate deploy` / `crate update` don't strip it

## Command Roles

- `crate login` — OAuth browser flow, saves credentials to `~/.crate/credentials.json`
- `crate init` — Creates everything from scratch (R2 bucket, D1 database, auth token, worker, all bindings)
- `crate deploy` — Code-only redeploy, preserves all existing bindings via `keep_bindings`
- `crate update` — Code-only redeploy (same as deploy), preserves all existing bindings via `keep_bindings`
- `crate analytics` — Optional. Prompts for an API token with Analytics Read + User API Tokens Edit, creates a scoped sub-token, and adds it as `CF_ANALYTICS_TOKEN` worker binding

## Worker API

See `docs/worker-api.md` for endpoint details and D1 schema.

## Analytics

Usage analytics are handled entirely by the Obsidian plugin, not the CLI or worker. The plugin queries the Cloudflare GraphQL Analytics API directly using the analytics token fetched from the worker's `/sync/config` endpoint. The `CF_ANALYTICS_TOKEN` binding is set up via `crate analytics` (optional, separate from init).
