# Obsidian Crate

Obsidian plugin that syncs vault files to Cloudflare R2 via a CF Worker, with integrated reminders and push notifications.

## Commands

```bash
npm run build:worker # esbuild worker from src/cloudflare/worker/ -> worker-bundle.gen.ts
npm run build        # build:worker + tsc + vite build
npm test             # vitest run (all tests)
npx vitest run src/sync/planner.test.ts  # single test file
npm run lint         # eslint
npm run deploy       # build + copy to $OBSIDIAN_VAULT plugin dir
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
| Reminders core | `reminders/data/`, `reminders/services/`, `reminders/settings.ts` | Index, markdown writer, vault watcher, notification service |
| Reminders shared | `reminders/types/`, `reminders/utils/`, `reminders/components/` | Types, parsing, React components |
| Reminders UI | `ui/reminders-view.tsx`, `ui/reminders-context.ts`, `ui/modals.tsx` | React sidebar view (Shadow DOM), modals, context |
| Reminders query | `reminders/query/` | Code block processors, inline todo editor extension |
| Styles | `styles/main.scss`, `styles/colors.scss`, `styles/crate.scss` | Tailwind + SCSS pipeline |
| Cloudflare worker | `cloudflare/worker/` | Worker source (bundled by esbuild into `worker-bundle.gen.ts`) |
| Cloudflare infra | `cloudflare/api.ts`, `cloudflare/session-manager.ts`, `cloudflare/infrastructure.ts` | CF API, OAuth PKCE, deploy helpers |

## Critical Invariants

1. **Worker source** - real TypeScript in `src/cloudflare/worker/`, bundled to `worker-bundle.gen.ts` by `scripts/build-worker.mjs`
2. **Worker binding update** - new bindings must be added in plugin `cloudflare/api.ts:deployWorker()` AND `redeployWorker() keep_bindings` (includes `durable_object_namespace` for `REMINDER_ALARMS`)
3. **Hidden files require adapter API** - `vault.getFiles()` excludes hidden files; use `file-discovery.ts:getAllVaultFiles()` which also walks via `vault.adapter.list()`
4. **SecretStorageService empty-string-as-null** - Obsidian has no `deleteSecret`; empty string = deleted
5. **Batch constants must match worker validation** - `BATCH_MAX_FILES` (50) and `BATCH_MAX_BYTES` (10 MB) in `types.ts` must match limits in worker template
6. **D1 schema changes need two updates** - worker template `initDb()` for the tables + plugin-side readers that query the data
7. **Files >= `BATCH_FILE_SIZE_LIMIT` (1 MB) bypass batch upload** - sent as individual binary PUT requests
8. **Worker DO class `ReminderAlarm`** - exported from worker template; needs `durable_object_namespace` binding and migration metadata on deploy
9. **Reminders settings separate** - stored in `reminders-settings.json`, not `data.json`; accessed via `plugin.remindersSettings`
10. **Build system** - Vite for the plugin, esbuild for the worker bundle. `npm run build` runs worker bundle first, then tsc + vite

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
