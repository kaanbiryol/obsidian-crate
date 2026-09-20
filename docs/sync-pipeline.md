# Sync Pipeline

## Sync Modes

### 1. Periodic Check

Every N seconds (configurable via `syncInterval`, default 300s), the engine calls `GET /sync/check?since=<lastSeq>` and compares local file metadata with the local manifest. If the server reports changes, reports an expired cursor, queued paths exist, or any visible or hidden local file has changed, it triggers a sync. An expired cursor falls through to full reconciliation.

Entry point: `engine.ts:periodicCheck()`

### 2. Foreground Sync

When `syncOnResume` is enabled, the plugin schedules a sync when Obsidian comes back into focus, becomes visible, or the device reconnects to the network. Foreground triggers are debounced for 1 second and throttled by a 30-second cooldown.

Entry point: `runtime.ts:triggerForegroundSync()`

### 3. Incremental Sync

Primary sync mode. Fetches only changelog entries since `lastSeq`:

1. Paginate `GET /sync/changes?since=<seq>` (5000 entries per page)
2. Deduplicate each page into a path map as it arrives - only the latest entry per file is retained
3. Detect local changes (hash comparison) and local deletes (missing manifest paths)
4. Classify each affected path with the shared three-way reconciliation policy
5. Execute operations, preparing and uploading local files in bounded chunks
6. Update local manifest and `lastSeq`

Returns `null` to signal fallback to full sync (on error or cursor expiry).

Entry point: `planner.ts:runIncrementalSync()`

### 4. Full Sync (Fallback)

Triggered when incremental sync fails or `lastSeq` is 0:

1. Discover all local vault files
2. Fetch the remote manifest in 2,000-file pages, then replay changes that landed after the first-page snapshot
3. Compute hashes for local files (skip unchanged via manifest mtime/size)
4. 3-way diff using `reconciliation.ts:classifyPaths()`, which applies the same `classifyPath()` policy as incremental sync
5. Execute uploads, downloads, conflicts, deletes

Entry point: `engine.ts:sync()` -> `planner.ts:createFullSyncPlan()`

### 5. Initial Sync

First-time upload of all vault files. Files are prepared and uploaded in sequential byte-budgeted chunks so binary contents cannot accumulate without bound in memory.

Entry point: `engine.ts:initialSync()`

### 6. Force Full Sync

Snapshots and clears the local manifest, uploads all local files regardless of hash, and only then deletes remote-only files. If any upload fails or the operation is aborted, remote deletion never begins and the previous local manifest is restored. Replaced and deleted remote objects remain recoverable for 30 days. Restoring a retained version verifies its bytes and stages them under a fresh immutable object key before the conditional metadata commit. The retained key stays eligible for its original expiry, so cleanup cannot remove the newly restored content. An uncertain commit response leaves the staged object for reference-aware orphan cleanup. Orphan reference lookups check at most 50 keys per query (100 D1 bindings across live files and retained versions).

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

Delete/edit races use an edit-wins rule:

| Local state | Remote state | Action |
|---|---|---|
| Unchanged | Deleted | Delete local file |
| Deleted | Unchanged | Delete remote file |
| Edited | Deleted | Re-upload edited file and record an automatically resolved race |
| Deleted | Edited | Restore remote edit and record an automatically resolved race |

"Changed" = current hash differs from manifest hash at last sync.

## Conflict Resolution

When both sides changed with different content, Markdown files first attempt a
three-way line merge using the cached common base. Independent edits and
same-point insertions merge deterministically, so devices that see the two sides
in opposite order still produce identical bytes. When both sides replace the
same aligned prose lines, a bounded word-level merge also combines edits to
different words within a paragraph. Competing changes to the same word or
different insertions at the same word boundary remain conflicts. Frontmatter,
fenced code, and indented code retain the line-level policy. Inline refinement
is limited to 16,000 combined characters per line and 128,000 per merge.

Line and word changes are computed with jsdiff. Each comparison permits at most
2,000 token insertions/deletions; exceeding that budget falls back to conflict
handling without applying a partial merge. The limit is based on edit count,
not elapsed time, so device speed does not change the decision. Repeated lines
follow jsdiff's alignment and can be interpreted as shared deletions plus
independent insertions.

Cached common bases are hash-verified before use. A corrupt base is treated as
missing and marked for repair; background seeding can repair it only when the
local file still matches the manifest hash. Existing cache files are not read or
hashed by the seed pass. Missing/known-corrupt entries are seeded in groups of up
to 32 files or 8 MiB of declared content (one larger eligible file may occupy a
group), yielding and checking cancellation between groups. Non-Markdown files
retain whole-file conflict handling.

The remote compare-and-swap is
committed before the local file is replaced, and the local hash is checked again
after the request so an edit made in flight is retained for the next pass.
Existing UTF-8 Markdown files are then compared and replaced inside Obsidian's
atomic `process()` callback (using the adapter for hidden files). An edit between
the hash check and that callback defers the write instead of being overwritten.
Other files retain the binary write path.

If the merge overlaps, the conflict remains unresolved:

1. **Remote version** is downloaded and saved at the original path
2. **Local version** is saved as a conflict copy:
   ```
   filename (conflict YYYY-MM-DD HH-mm-ss xxxx).ext
   ```
   Suffix includes timestamp (to seconds) + 4 random alphanumeric characters.

Only unresolved conflicts create a conflict copy and increment the user-visible
conflict count. Edit/delete races are recorded separately as resolved races in
sync history and do not trigger a conflict notice. Conflict files are
auto-ignored by `isConflictFile()` to prevent sync loops, so they remain
local-only until the user reviews or deletes them.

Active conflicts are stored in the plugin's `conflicts.json`, including the
original path, conflict-copy path, cause, timestamp, and available hashes. The
store is recovered through `conflicts.json.tmp` during startup. After the
workspace layout is ready, a deferred recovery pass scans non-ignored visible
and hidden files for untracked conflict copies and marks conflicts resolved when
their copies are deleted or renamed. This keeps startup responsive and the
status-bar and activity counts stable across restarts and unrelated sync runs.

Implementation: `conflict.ts:createConflictCopy()`, `conflict-store.ts:ConflictStore`

## File Discovery

Two-pass discovery in `file-discovery.ts:getAllVaultFiles()`:

1. **Pass 1:** `vault.getFiles()` - standard Obsidian API (excludes hidden files)
2. **Pass 2:** Walk dot-prefixed folders via `vault.adapter.list()` + `vault.adapter.stat()`
   - Hidden root folders (e.g. `.obsidian/`) are walked recursively
   - Non-hidden folders are walked iteratively at any depth while looking for nested hidden subfolders
3. **Deduplication:** via Set to avoid processing the same file twice
4. **Early filtering:** ignore patterns applied during discovery, before hashing
5. **Portability validation:** reject Windows-incompatible names plus case and Unicode-normalization collisions before any upload begins

The active Obsidian configuration folder's entire `plugins/` tree is always excluded, including plugin JavaScript, manifests, styles, and data files.

## Constants

| Constant | Value | Location |
|---|---|---|
| `debounceDelay` default | 5 seconds | `types.ts` |
| `MAX_DEBOUNCE_WAIT_MS` | 30,000 ms | `types.ts` |
| `MAX_FILE_SIZE_BYTES` | 25 MB | `types.ts` |
| `BATCH_UPLOAD_MAX_FILES` | 6 | `protocol/sync-limits.ts` |
| `BATCH_DELETE_MAX_FILES` | 6 | `protocol/sync-limits.ts` |
| `BATCH_DOWNLOAD_MAX_FILES` | 50 | `protocol/sync-limits.ts` |
| `BATCH_MAX_BYTES` | 10 MB | `types.ts` |
| `BATCH_FILE_SIZE_LIMIT` | 1 MB | `types.ts` |
| `UPLOAD_CONCURRENCY` | 2 | `engine-constants.ts` |
| `DOWNLOAD_CONCURRENCY` | 2 | `engine-constants.ts` |
| `FORCE_SYNC_CONCURRENCY` | 2 | `engine.ts` |
| `PREPARE_CONCURRENCY` | 2 | `engine-constants.ts` |
| Transfer chunk budget | 48 MiB mobile / 128 MiB desktop, max 128 files | `transfer-budget.ts` |
| `BATCH_UPLOAD_CONCURRENCY` | 1 | `engine-constants.ts` |
| `MAX_RETRIES` | 3 | `engine.ts` |
| `RETRY_BASE_DELAY_MS` | 1,000 ms | `engine.ts` |

## Batching Strategy

Files are split by size at the `BATCH_FILE_SIZE_LIMIT` (1 MB) threshold:

- **< 1 MB:** batched into JSON payloads with base64-encoded content. Each batch respects `BATCH_UPLOAD_MAX_FILES` (3) and `BATCH_MAX_BYTES` (10 MB) limits. Sent via `POST /sync/batch-upload`. Per-path failures carry a stable code and status; version conflicts are sent through targeted three-way reconciliation instead of becoming generic upload errors. The smaller mutation limit keeps worst-case conditional-write cleanup below Workers Free D1 query limits.
- **>= 1 MB:** uploaded individually as binary via `PUT /sync/upload` with retry.

Downloads smaller than 1 MB use `POST /sync/batch-download` in chunks bounded by `BATCH_DOWNLOAD_MAX_FILES` (50) and `BATCH_DOWNLOAD_MAX_BYTES` (8 MB). Larger files use individual streaming downloads. The client validates returned paths, sizes, and hashes, and falls back to individual `GET /sync/download` requests if a batch is rejected or unavailable. Conditional deletes are chunked into four-file requests; partial results are aggregated and stale deletes are targeted for reconciliation.

Implementation: `transfer.ts:uploadPreparedFiles()`, `transfer.ts:createBatchUploadChunks()`

## Queue System

File events (create, modify, delete, rename) are debounced before syncing:

1. Events collected into `pendingPaths` Set on `SyncEngine`
2. Delete events use `delete:` prefix convention (e.g. `delete:notes/old.md`)
3. Rename events emit both a `delete:` for old path and an add for new path
4. Debounce timer (default 5s) resets with each new event, with a 30s maximum wait
5. After the quiet period or maximum wait, `processPendingChanges()` flushes the queue
6. Each event receives a revision so reconciliation cannot clear a newer edit that arrived while the sync was running; opposite upload/delete events for one path are coalesced
7. After successful reconciliation, pending events from applied downloads, merges, and deletions are checked against the committed local baseline. Matching contents clear in the same run; newer events or differing contents stay pending. Incremental paths whose local and remote hashes already match also settle without another transfer.
8. A conditional-write conflict sends only the affected queue keys through a bounded three-attempt reconciliation pass; current remote metadata is fetched only for those paths, and unrelated vault paths are not scanned

If a local Markdown file changes after an automatic merge has already been accepted remotely, Crate keeps the uploaded local snapshot as a virtual merge base and immediately replans the path. This prevents both overwriting the newer local edit and duplicating changes already included in the remote merge.

Implementation: `queue.ts`

## Local Manifest

Stored as `file-manifest.json` in the plugin directory, separate from settings to avoid write amplification.

**Structure:**
```json
{
  "version": 1,
  "generation": 1,
  "files": {
    "path": { "hash": "sha256...", "size": 1024, "modified": "ISO8601" }
  },
  "lastSeq": 42
}
```

**Crash safety:** serialized saves write a monotonically increasing `generation`
to `.tmp` first, then to the main file. Startup selects the newest valid
generation, including a newer temporary checkpoint alongside a valid older main
file. Unsupported checkpoints are rejected and preserved. Failed promotion keeps the
temporary checkpoint. A mutation revision ensures edits made during a save are
included in a follow-up checkpoint before that save finishes.

**Optimization:** during full sync, files whose size and mtime match the manifest entry skip re-hashing.

Implementation: `manifest.ts:LocalManifest`

## Error Recovery

- **Retry:** failed uploads retry up to 3 times with exponential backoff (1s base delay)
- **Cancellation:** abort and timeout stop the caller's wait and ignore late responses. Obsidian's HTTP transport may still finish and commit a mutation remotely. Uncertain queued paths remain pending; retries use expected-hash writes and reconciliation, and cancelled incremental runs do not advance the changelog cursor. Concurrent workers are drained before a failed operation unwinds.
- **Local deletion recovery:** visible files use Obsidian's local vault trash (`vault.trash(file, false)`); hidden/unindexed files use the adapter's local trash. The vault's `.trash/` directory is always excluded from sync. A trash failure never falls back to permanent removal. The hash check and deletion are not atomic: an edit arriving between them remains recoverable in trash.
- **Upload memory:** incremental and queued uploads reserve room for the next maximum-size file before preparation, using the 48 MiB mobile / 128 MiB desktop budget and a 128-file cap. Chunks finish uploading before further contents are prepared; history retains paths rather than file buffers. These budgets cover prepared binary contents, not total process memory or request encoding overhead.
- **Incremental-to-full fallback:** if incremental sync returns `null` (error/cursor expiry), engine runs full sync
- **Manifest recovery:** corrupt main file recovers from `.tmp` file
- **Startup event recovery:** event capture resumes before a post-startup metadata probe; if the startup sync missed a local edit, one recovery sync runs without opening another event blind window
- **Conflict recovery:** the durable conflict registry recovers from `.tmp` and discovers visible or hidden conflict copies that were created before their metadata was committed
- **Queue retry:** retryable flush failures are re-added to `pendingPaths`; version and validation conflicts request a targeted three-way replan for only the affected paths, with at most three compare-and-swap attempts
- **Large files:** files > 25 MB are skipped with error message, not crashed
- **Remote recovery:** replaced and deleted R2 objects are retained for 30 days, integrity-checked, and restorable with an expected-hash compare-and-swap
- **Ignored remote cleanup:** changing ignore patterns never deletes data implicitly; settings provide an explicit preview-and-confirm purge action

## Discarding local changes

Sync Activity discard compares selected files with the local manifest and restores
last-synced bytes from the on-device Markdown base cache. It does not fetch server
metadata or contents, upload changes, or advance the remote sync cursor. Files
absent from the local manifest move to local trash; unchanged files are kept.
Missing or corrupt cached copies block review without changing the selection.
Existing non-Markdown files currently have no cached baseline and cannot be
restored through local discard.

Confirmation rechecks local contents and manifest versions before applying changes.
Recovery copies are verified before replacing files, and edits arriving during
application are preserved. Restored files retain their last-synced revision, so
newer server changes are still discovered by the next normal sync.

## Returning to a history checkpoint

Successful syncs without unresolved conflicts or pending restore/upload intents ask
servers advertising `shared-history-checkpoints-v1` to save a complete server file
inventory. R2 holds the inventories and an ETag-protected index; no file contents
are duplicated and no D1 schema migration is required. Checkpoints are visible on
all connected devices, including devices without local activity history. The index
keeps the newest 20 distinct server generations for at most 30 days. Repeated or
concurrent saves of the same generation resolve to the same checkpoint.

The server reads the inventory in bounded pages and verifies the monotonic changelog
generation before and after capture. An incomplete initial import or concurrent
mutation rejects capture. Current limits are 20,000 files and 8 MiB of metadata;
exceeding them never publishes a partial inventory. The small shared index is
published conditionally only after its immutable inventory exists. Uncertain writes
retain their possible committed objects; a bounded, cursor-based maintenance sweep
removes unreferenced metadata after a one-day grace period.

Expiry uses server time. Replaced/deleted versions retain at least 30 days from the
D1 commit time, so a checkpoint expires no later than its required retained bytes.
The server rejects expired or evicted checkpoint reads. Checkpoint file downloads
check the live index and exact current/retained D1 path and revision ownership; the
client verifies size and SHA-256 against the checkpoint before staging. Unlike text
previews, these reads support the full 25 MiB sync-file limit.

Older servers keep the local `history-checkpoints/` fallback and History explains
that an update is needed for sharing. Existing local-only checkpoints stay local;
new shared checkpoints begin after the server update and a successful sync.
Unreferenced local inventories are pruned at startup. Local legacy checkpoints
remain bound to their original server and exclusion rules. Shared checkpoints
contain the full remote inventory; each restoring device preserves its current
excluded files and rejects exclusion changes during review.

The History tab keeps expandable sync summaries with uploaded, downloaded, merged,
and deleted files. Each file offers **File history**. A single
**Browse vault history** button opens a dedicated Vault history dialog above Sync
activity. Closing it returns to the unchanged activity list and its previous scroll
position. The wider
screen combines sync selection, files, and saved-state previews in three panes
(History → Files → Diff on narrow screens). Saved contents load only when this
screen opens. A selected checkpoint is compared
with the preceding available checkpoint, using complete inventories and verified
saved bytes, never current local contents. Without an available predecessor, the
browser shows saved contents instead of presenting every file as an addition.
Entries without checkpoints retain recorded paths and errors; they cannot provide
an exact saved-state preview. File previews retain the 256 KB text limit.

**Vault history → Restore to this point** opens one compact confirmation with the
number of current files that will change, including local unsynced edits. Excluded files remain untouched. The current server
inventory must match the device's baseline before reviewing. Every required version
must still be available from the server's current files or 30-day retained history.
Confirmation rechecks the complete local and remote inventories, stages and verifies
all required bytes and originals under `state-recovery/`, then persistently pauses
automatic sync before applying changes. Replacements use atomic text comparison or
local trash and checked creation; deleted files always go to local trash.

Explicit removals sync before restored uploads to support file/folder namespace
changes. The final full sync and inventory verification must both succeed before
restoring the previous automatic-sync preference. This is a recoverable multi-file
operation, not an atomic server transaction: an interruption can leave some files
restored. Automatic sync remains off on failure, including after restart; reopen
the checkpoint to review and finish, or recover original bytes using the saved
`recovery.json` inventory. Concurrent edits are preserved or surfaced for review,
and a mismatching final inventory is never reported as a successful restore.
