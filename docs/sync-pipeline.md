# Sync Pipeline

## Sync Modes

### 1. Periodic Check

Every N seconds (configurable via `syncInterval`, default 300s), the engine calls `GET /sync/check?since=<lastSeq>`. If the server reports changes or local `pendingPaths` is non-empty, triggers an incremental sync.

Entry point: `engine.ts:periodicCheck()`

### 2. Foreground Sync

When `syncOnResume` is enabled, the plugin schedules a sync when Obsidian comes back into focus, becomes visible, or the device reconnects to the network. Foreground triggers are debounced for 1 second and throttled by a 30-second cooldown.

Entry point: `runtime.ts:triggerForegroundSync()`

### 3. Incremental Sync

Primary sync mode. Fetches only changelog entries since `lastSeq`:

1. Paginate `GET /sync/changes?since=<seq>` (5000 entries per page)
2. Deduplicate by path - only the latest entry per file matters
3. Detect local changes (hash comparison) and local deletes (missing manifest paths)
4. Categorize each file: upload, download, delete, or conflict
5. Execute all operations
6. Update local manifest and `lastSeq`

Returns `null` to signal fallback to full sync (on error or cursor expiry).

Entry point: `planner.ts:runIncrementalSync()`

### 4. Full Sync (Fallback)

Triggered when incremental sync fails or `lastSeq` is 0:

1. Discover all local vault files
2. Fetch full remote manifest from `GET /sync/manifest`
3. Compute hashes for local files (skip unchanged via manifest mtime/size)
4. 3-way diff using `conflict.ts:detectConflicts()`
5. Execute uploads, downloads, conflicts, deletes

Entry point: `engine.ts:sync()` -> `planner.ts:createFullSyncPlan()`

### 5. Initial Sync

First-time upload of all vault files. Processes files in pipelined chunks - prepares the next chunk while uploading the current one.

Entry point: `engine.ts:initialSync()`

### 6. Force Full Sync

Clears local manifest, uploads all local files regardless of hash, deletes remote-only files.

Entry point: `engine.ts:forceFullSync()`

## Change Detection (3-Way Hash)

For each file, three states are compared:

| State | Source |
|---|---|
| Local current | Vault file content (SHA-256 hash) |
| Local known | Last-synced hash from local manifest |
| Remote current | Changelog entry or remote manifest |

| Local changed? | Remote changed? | Action |
|---|---|---|
| No | No | Skip |
| Yes | No | Upload |
| No | Yes | Download |
| Yes | Yes, same hash | Skip (converged) |
| Yes | Yes, different hash | Conflict |

"Changed" = current hash differs from manifest hash at last sync.

## Conflict Resolution

When both sides changed with different content:

1. **Remote version** is downloaded and saved at the original path
2. **Local version** is saved as a conflict copy:
   ```
   filename (conflict YYYY-MM-DD HH-mm-ss xxxx).ext
   ```
   Suffix includes timestamp (to seconds) + 4-char random hex.

Conflict files are auto-ignored by `isConflictFile()` to prevent sync loops.

Implementation: `conflict.ts:createConflictCopy()`

## File Discovery

Two-pass discovery in `file-discovery.ts:getAllVaultFiles()`:

1. **Pass 1:** `vault.getFiles()` - standard Obsidian API (excludes hidden files)
2. **Pass 2:** Walk dot-prefixed folders via `vault.adapter.list()` + `vault.adapter.stat()`
   - Hidden root folders (e.g. `.obsidian/`) are walked recursively (unlimited depth)
   - Non-hidden folders are walked up to depth 5 (`MAX_NESTED_WALK_DEPTH`) looking for nested hidden subfolders
3. **Deduplication:** via Set to avoid processing the same file twice
4. **Early filtering:** ignore patterns applied during discovery, before hashing

## Constants

| Constant | Value | Location |
|---|---|---|
| `debounceDelay` default | 5 seconds | `types.ts` |
| `MAX_DEBOUNCE_WAIT_MS` | 30,000 ms | `types.ts` |
| `MAX_FILE_SIZE_BYTES` | 25 MB | `types.ts` |
| `BATCH_MAX_FILES` | 50 | `types.ts` |
| `BATCH_MAX_BYTES` | 10 MB | `types.ts` |
| `BATCH_FILE_SIZE_LIMIT` | 1 MB | `types.ts` |
| `UPLOAD_CONCURRENCY` | 10 | `engine.ts` |
| `DOWNLOAD_CONCURRENCY` | 5 | `engine.ts` |
| `FORCE_SYNC_CONCURRENCY` | 2 | `engine.ts` |
| `PREPARE_CONCURRENCY` | 20 | `engine.ts` |
| `INITIAL_SYNC_PIPELINE_CHUNK_FILES` | 500 | `engine.ts` |
| `BATCH_UPLOAD_CONCURRENCY` | 5 | `engine-constants.ts` |
| `MAX_RETRIES` | 3 | `engine.ts` |
| `RETRY_BASE_DELAY_MS` | 1,000 ms | `engine.ts` |

## Batching Strategy

Files are split by size at the `BATCH_FILE_SIZE_LIMIT` (1 MB) threshold:

- **< 1 MB:** batched into JSON payloads with base64-encoded content. Each batch respects `BATCH_MAX_FILES` (50) and `BATCH_MAX_BYTES` (10 MB) limits. Sent via `POST /sync/batch-upload`.
- **>= 1 MB:** uploaded individually as binary via `PUT /sync/upload` with retry.

Downloads use `POST /sync/batch-download` in chunks of `BATCH_MAX_FILES` (50). If a batch download fails, falls back to individual `GET /sync/download` requests.

Implementation: `transfer.ts:uploadPreparedFiles()`, `transfer.ts:createBatchUploadChunks()`

## Queue System

File events (create, modify, delete, rename) are debounced before syncing:

1. Events collected into `pendingPaths` Set on `SyncEngine`
2. Delete events use `delete:` prefix convention (e.g. `delete:notes/old.md`)
3. Rename events emit both a `delete:` for old path and an add for new path
4. Debounce timer (default 5s) resets with each new event, with a 30s maximum wait
5. After the quiet period or maximum wait, `processPendingChanges()` flushes the queue

Implementation: `queue.ts`

## Local Manifest

Stored as `file-manifest.json` in the plugin directory, separate from settings to avoid write amplification.

**Structure:**
```json
{
  "version": 1,
  "files": {
    "path": { "hash": "sha256...", "size": 1024, "modified": "ISO8601" }
  },
  "lastSeq": 42
}
```

**Crash safety:** write to `.tmp` file first, then to main file. On load, if main file is corrupt, recover from `.tmp`. Dirty flag skips unnecessary writes.

**Optimization:** during full sync, files whose size and mtime match the manifest entry skip re-hashing.

Implementation: `manifest.ts:LocalManifest`

## Error Recovery

- **Retry:** failed uploads retry up to 3 times with exponential backoff (1s base delay)
- **Incremental-to-full fallback:** if incremental sync returns `null` (error/cursor expiry), engine runs full sync
- **Manifest recovery:** corrupt main file recovers from `.tmp` file
- **Queue retry:** on flush failure, paths are re-added to `pendingPaths` and debounce timer restarts
- **Large files:** files > 25 MB are skipped with error message, not crashed
