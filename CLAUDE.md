# Obsidian Crate

Obsidian plugin that syncs vault files to Cloudflare R2 via a CF Worker. Includes a CLI (`packages/cli`) for provisioning.

## Commands

```bash
npm run build        # tsc + esbuild
npm test             # vitest run (all tests)
npx vitest run src/sync/planner.test.ts  # single test file
npm run lint         # eslint
npm run deploy       # build + copy to $OBSIDIAN_VAULT plugin dir
npm run build:cli    # build the CLI package
```

## Module Map

| Module | Key files | Purpose |
|---|---|---|
| Plugin core | `main.ts`, `types.ts`, `settings.ts`, `logger.ts` | Entry point, types, constants |
| Secret storage | `secret-storage.ts` | OS keychain wrapper + Obsidian type augmentation |
| Sync engine | `sync/runtime.ts`, `sync/engine.ts` | Lifecycle coordinator, sync orchestration |
| Sync planning | `sync/planner.ts`, `sync/conflict.ts` | Diff computation, 3-way conflict detection |
| Sync execution | `sync/transfer.ts`, `sync/queue.ts` | Upload/download/delete, debounced queue |
| Sync support | `sync/api.ts`, `sync/manifest.ts`, `sync/file-discovery.ts`, `sync/hasher.ts` | HTTP client, local manifest, file discovery, hashing |
| UI | `ui/status.ts`, `ui/settings-tab.ts`, `ui/settings/` | Status bar, settings sections |
| Cloudflare | `cloudflare/worker-template.ts`, `cloudflare/api.ts`, `cloudflare/session-manager.ts` | Worker source, CF API, OAuth PKCE |
| CLI | `packages/cli/` | Infrastructure provisioning (see `packages/cli/CLAUDE.md`) |

## Critical Invariants

1. **Worker template duplication** - `src/cloudflare/worker-template.ts` (plugin) and `packages/cli/src/worker-template.ts` (CLI) must stay in sync
2. **Worker binding 2-place update** - new bindings must be added in CLI `commands/init.ts:deployWorker()` AND `cloudflare/api.ts:redeployWorker() keep_bindings`
3. **Hidden files require adapter API** - `vault.getFiles()` excludes hidden files; use `file-discovery.ts:getAllVaultFiles()` which also walks via `vault.adapter.list()`
4. **SecretStorageService empty-string-as-null** - Obsidian has no `deleteSecret`; empty string = deleted
5. **Batch constants must match worker validation** - `BATCH_MAX_FILES` (50) and `BATCH_MAX_BYTES` (10 MB) in `types.ts` must match limits in worker template
6. **D1 schema changes need two updates** - worker template `initDb()` for the tables + plugin-side readers that query the data
7. **Files >= `BATCH_FILE_SIZE_LIMIT` (1 MB) bypass batch upload** - sent as individual binary PUT requests

## Testing

- vitest, test files co-located as `*.test.ts`
- Obsidian mocks in `src/test/mocks/obsidian.ts`
- See `docs/testing.md` for patterns (harness, context interfaces, `vi.hoisted()`)

## Docs Reference

| Document | Read when... |
|---|---|
| `docs/architecture.md` | Understanding component ownership, auth flows, worker bindings, secret storage |
| `docs/sync-pipeline.md` | Working on sync modes, change detection, batching, constants, conflict resolution |
| `docs/worker-api.md` | Modifying worker endpoints, D1 schema, request/response formats |
| `docs/testing.md` | Writing or modifying tests, understanding mock patterns |
| `packages/cli/CLAUDE.md` | Working on CLI commands, worker bindings checklist |
