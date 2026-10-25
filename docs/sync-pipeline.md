# Sync Pipeline

Automatic sync is off by default on new installs. Connecting a server, restarting
Obsidian, editing files, and opening Sync activity or History do not start file
transfers while it is off. Start a manual sync with **Crate: Sync now** or
enable **Automatic sync** in Crate settings. A manual sync leaves automatic sync
off. Enabling encryption runs its own syncs: it syncs once, replaces the server
copy, then uploads the vault encrypted, and afterwards restores the previous
automatic-sync setting. Explicitly saved preferences are preserved when upgrading or restarting.

In an encrypted vault the server stores keyed name tags instead of paths. The
Worker API layer (`worker-api/sync.ts` with `encryption/encrypted-files.ts` and
`encryption/path-index.ts`) maps plaintext paths to server paths on every request
and maps responses back, so planning, conflict detection and the local manifest use
plaintext paths. Server deletes carry no metadata; the client maps them back through
paths it has synced and ignores server paths it never knew. If two server files
claim the same plaintext name, the one stored at that name's own tag keeps it and
the other syncs locally as `<name> - <first 8 characters of its server name>.<ext>`.

`automaticSync` is the device-local control for startup, foreground, periodic and
edit-triggered sync. Tests that disable automatic work should set
`automaticSync: false`.

Configured vaults start with a yellow indicator while the saved sync state loads.
With automatic sync off, it stays yellow through the local pending-file scan after
layout readiness. With automatic sync on, it stays yellow through startup sync. A
saved last-sync timestamp does not show green before those checks finish. Sync
activity shows **Checking local files…** during local startup checks; errors and
server availability warnings remain visible.

## Sync Modes

### 1. Periodic Check

When `automaticSync` is enabled, every N seconds (configurable via `syncInterval`, default 300s), the engine calls `GET /sync/check?since=<lastSeq>` and compares local file metadata with the local manifest. If the server reports changes, reports an expired cursor, queued paths exist, or any visible or hidden local file has changed, it triggers a sync. An expired cursor falls through to full reconciliation.

Entry point: `engine/lifecycle.ts:periodicCheck()`

### 2. Foreground Sync

When `automaticSync` is enabled, the plugin schedules a sync when Obsidian comes back into focus, becomes visible, or the device reconnects to the network. Foreground triggers are debounced for 1 second and throttled by a 30-second cooldown.

Entry point: `runtime.ts:triggerForegroundSync()`

### 3. Incremental Sync

Primary sync mode. Fetches only changelog entries since `lastSeq`:

1. Paginate `GET /sync/changes?since=<seq>` (5000 entries per page)
2. Deduplicate each page into a path map as it arrives - only the latest entry per file is retained
3. Detect local changes (hash comparison) and local deletes (missing manifest paths)
4. Classify each affected path with the shared three-way reconciliation policy
5. Execute operations, preparing and uploading local files in bounded chunks
6. Update local manifest and `lastSeq`

Returns `null` to signal fallback to full sync (on cursor expiry or a non-transient error). Transport failures and retryable server statuses (408, 425, 429, 5xx) return a failed result instead, so the next sync retries incrementally without re-reading the vault.

Entry point: `planner/incremental.ts:runIncrementalSync()`.
The coordinator retains phase ordering, progress, manifest saves and cursor
advancement. `incremental-changelog.ts` handles pagination and path deduplication;
`incremental-remote-reconciliation.ts` keeps fresh local reads and guarded deletes
together and returns edits discovered after the scan. The coordinator propagates
local deletions only after earlier uploads and reconciliation succeed.

### 4. Full Sync (Fallback)

Triggered when incremental sync fails or `lastSeq` is 0:

1. Discover all local vault files
2. Fetch the remote manifest in 2,000-file pages, then replay changes that landed after the first-page snapshot
3. Compute hashes for local files. Automatic recovery from an expired or failed cursor reuses the baseline hash when size and mtime match; first and manual full syncs read every file
4. 3-way diff using `reconciliation.ts:classifyPaths()`, which applies the same `classifyPath()` policy as incremental sync
5. Execute uploads, downloads, conflicts, deletes

Entry point: `engine/engine.ts:sync()` -> `planner/full.ts:createFullSyncPlan()`

On a device with no successful sync, no existing file checkpoint, and no eligible
local files outside the active Obsidian configuration folder, the first sync
adopts existing server settings. Differing setup files are downloaded without
creating conflict copies; this includes settings created while installing BRAT
and Crate in an otherwise empty vault. Local-only files retain ordinary upload
behavior, and ignore patterns still apply.

Before transfer, the planner checkpoints the hashes of the local setup files
eligible for replacement, separately from the last-synced file baseline. An
interrupted pull can resume across restarts even after notes have downloaded.
Only unchanged setup bytes qualify: a new edit during download defers the write,
and an edit before retry receives normal conflict handling. A populated local
vault and subsequent syncs always use normal reconciliation. The setup intent is
removed after successful reconciliation.

### 5. Initial Import

There is no separate initial-sync command. Each sync first asks the server for an unfinished initial import; while one is open, the vault is uploaded through it before any incremental or full reconciliation. Server files missing locally are pruned from the import, files are prepared in byte-budgeted chunks so binary contents cannot accumulate without bound in memory, and small files are committed in batches of up to 32. Files over 25 MB are reported as skipped and keep any server copy they already have. Only the device that started the import prunes or uploads for it; another device stops until it finishes (see [upload recovery](upload-recovery.md)). Finishing the import sets the changelog cursor.

Entry point: `engine/engine.ts:sync()` -> `engine/initial-import.ts:runInitialImport()`

### 6. Force Full Sync

Uploads all local files regardless of hash, conditioned on the server's current hash, and only then deletes remote-only files. Files over 25 MB are reported as skipped, and their server copy is neither replaced nor deleted. The local manifest keeps its baselines throughout and each acknowledged upload replaces its entry, so a failed, stopped or interrupted run leaves correct baselines for every file it did not reach. If any upload fails or the operation is aborted, remote deletion never begins. Only after a run without errors does it drop manifest entries for paths that are no longer local. Replaced and deleted remote objects remain recoverable for 30 days. Restoring a retained version verifies its bytes and stages them under a fresh immutable object key before the conditional metadata commit. The retained key stays eligible for its original expiry, so cleanup cannot remove the newly restored content. An uncertain commit response leaves the staged object for reference-aware orphan cleanup. Orphan reference lookups check at most 50 keys per query (100 D1 bindings across live files and retained versions).

Entry point: `engine/engine.ts:forceFullSync()`

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
different insertions at the same word boundary remain conflicts. Frontmatter is
atomic: competing header edits preserve a conflict, even when they touch different
keys. The merged header must match one authored input. Competing edits inside
one fenced block also remain conflicts, including fences inside callouts,
blockquotes, and lists. Literal quote/list markers within a fence do not end its
protected region. Ambiguous or unterminated fences are treated conservatively
through the end of the document. Indented code is also treated conservatively as
an atomic region. The resulting fenced and indented blocks are checked with the
Markdown tokenizer; each code body and language must match an authored input
(ignoring the tokenizer's terminal-newline delimiter). Newly introduced blocks
must also survive as code, including their multiplicity. This protects newly added
or moved fences that did not exist in the base; unrelated prose and independent
whole code blocks can still merge. Inline refinement
is limited to 16,000 combined characters per line and 128,000 per merge.

Automatic Markdown merging is limited to 1 MiB per input and 20,000 lines; larger
notes keep the recoverable conflict path. Line and word changes are computed with
jsdiff. Each comparison permits at most
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

Implementation: `conflict.ts:createConflictCopy()`, `conflict/store.ts:ConflictStore`

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

Release and transfer values are also checked against source in [current contract](current-contract.md).

| Constant | Value | Location |
|---|---|---|
| `debounceDelay` default | 5 seconds | `types.ts` |
| `MAX_DEBOUNCE_WAIT_MS` | 30,000 ms | `types.ts` |
| `MAX_FILE_SIZE_BYTES` | 25 MB | `types.ts` |
| `BATCH_UPLOAD_MAX_FILES` | 3 | `protocol/sync-limits.ts` |
| `BATCH_DELETE_MAX_FILES` | 4 | `protocol/sync-limits.ts` |
| `BATCH_DOWNLOAD_MAX_FILES` | 50 | `protocol/sync-limits.ts` |
| `BATCH_MAX_BYTES` | 10 MB | `types.ts` |
| `BATCH_FILE_SIZE_LIMIT` | 1 MB | `types.ts` |
| `UPLOAD_CONCURRENCY` | 2 | `transfer/constants.ts` |
| `DOWNLOAD_CONCURRENCY` | 2 | `transfer/constants.ts` |
| `PREPARE_CONCURRENCY` | 2 | `transfer/constants.ts` |
| Transfer chunk budget | 48 MiB mobile / 128 MiB desktop, max 128 files | `transfer/budget.ts` |
| `BATCH_UPLOAD_CONCURRENCY` | 2 mobile / 4 desktop | `transfer/constants.ts` |
| `BATCH_DELETE_CONCURRENCY` | 2 | `transfer/constants.ts` |
| `MAX_RETRIES` | 3 | `engine/constants.ts` |
| `RETRY_BASE_DELAY_MS` | 1,000 ms | `engine/constants.ts` |

## Batching Strategy

Manual, selected-file, incremental, forced and edit-triggered automatic
sync use `transfer/upload.ts:uploadPreparedFiles()` for ordinary uploads. Files
are prepared in byte-bounded chunks and split at `BATCH_FILE_SIZE_LIMIT` (1 MB):

- **< 1 MB:** batched into JSON payloads with base64-encoded content. Edited Markdown batches contain up to 3 files; assets allow 4, and eligible new-file imports allow 8 when the server supports them. Each request respects `BATCH_MAX_BYTES` (10 MB). Sent via `POST /sync/batch-upload`, with up to 4 requests in flight on desktop or 2 on mobile. Per-path failures retain their code and status for targeted reconciliation or terminal failure handling. The smaller mutation limits keep worst-case conditional-write cleanup below Workers Free D1 query limits.
- **>= 1 MB:** uploaded individually as binary via `PUT /sync/upload`, with up to 2 requests in flight. Each mode retains its retry policy.

`protocol/sync-limits.ts:maxUploadBatchFiles()` defines the per-request file limit.
Chunk planning assumes new files are eligible for a new-file import; the request
client applies the rule again with the server capability and encryption state, and
splits a chunk the server cannot accept in one request.

Remote deletes in manual, selected-file, incremental, forced and automatic sync
use `transfer/delete.ts:deleteRemoteFiles()`. It waits for preceding uploads and
reconciliation to succeed, rechecks local absence, and uses `delete-batches.ts`
to send up to 4 conditional deletes per request with 2 requests in flight.
Rename preservation, expected hashes and revisions still guard every deletion.
Accepted sibling requests drain before cancellation returns; acknowledged
deletions are checkpointed. Activity reports **Deleting X of Y files** as batches
complete. Queue settlement and conflict retries remain with the calling mode.

Downloads smaller than 1 MB use `POST /sync/batch-download` in chunks bounded by `BATCH_DOWNLOAD_MAX_FILES` (50) and `BATCH_DOWNLOAD_MAX_BYTES` (8 MB). Larger files use individual streaming downloads. The client validates returned paths, sizes, and hashes, and falls back to individual `GET /sync/download` requests if a batch is rejected or unavailable.

Implementation: `transfer/upload.ts`, `transfer/upload-pipeline.ts`, `transfer/prepare.ts`, `transfer/delete.ts`, `delete-batches.ts`

## Queue System

File events (create, modify, delete, rename) are debounced before syncing:

1. Events collected into the `pendingKeys` Set on `SyncQueueController` (`src/sync/queue/controller.ts`)
2. Delete events are keyed with a `\0delete:` prefix (e.g. `\0delete:notes/old.md`). NUL cannot occur in a sync path, so delete keys never collide with a file literally named `delete:...`. Only `src/sync/pending/pending-change.ts` builds or parses these keys
3. Rename events emit both a delete key for the old path and an upload key for the new path
4. Debounce timer (default 5s) resets with each new event, with a 30s maximum wait
5. After the quiet period or maximum wait, `processPendingChanges()` flushes the queue
6. Each event receives a revision so reconciliation cannot clear a newer edit that arrived while the sync was running; opposite upload/delete events for one path are coalesced
7. After successful reconciliation, pending events from applied downloads, merges, and deletions are checked against the committed local baseline. Matching contents clear in the same run; newer events or differing contents stay pending. Incremental paths whose local and remote hashes already match also settle without another transfer.
8. A conditional-write conflict sends only the affected queue keys through a bounded three-attempt reconciliation pass; current remote metadata is fetched only for those paths, and unrelated vault paths are not scanned

If a local Markdown file changes after an automatic merge has already been accepted remotely, Crate keeps the uploaded local snapshot as a virtual merge base and immediately replans the path. This prevents both overwriting the newer local edit and duplicating changes already included in the remote merge.

Implementation: `queue/controller.ts` and `queue/flush.ts`

Selected-file sync classifies only the selected paths against current server
metadata. Ordinary uploads and deletes use the shared transfer executors and
concurrency limits, with progress reported per batch.
Only files that lose a conditional-write race fall back to individual
reconciliation. Remote deletions still wait for successful uploads and rename
preservation; unselected files and the global changelog cursor stay untouched.

File events also schedule a local content check after a 250 ms coalescing window,
including while automatic sync is off. Files matching their last-synced SHA-256
hash leave the pending list without a server request. The check refreshes their
verified modification times in one checkpoint write. New edits, changed baselines,
in-flight syncs, unreadable files, and outstanding durable mutations prevent stale
checks from clearing pending work. Previews remain read-only.

Raw notifications for tracked configuration and hidden files are checked locally
before publishing a new pending entry. Timestamp-only touches therefore do not
flash in Sync activity or change the sync indicator. These reads are serialized
to bound memory; real edits, deletions, unreadable files, and interrupted mutations
remain pending for ordinary sync and review.

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

**Change log:** after a full checkpoint, saves append one JSON line to
`file-manifest.log` with only the changed or removed entries and the recovery state
fields (renames, upload receipts, diagnostics, restore intents) that changed since the
previous record, with `null` clearing a field. A queue flush in a large vault rewrites
neither the whole baseline nor unchanged recovery state. The
log's header names the base checkpoint generation; loading applies its consecutive
records only when that base is the selected main checkpoint, so a log left behind by
an interrupted compaction is ignored. An interrupted append can only tear the final
line, which is dropped and forces the next save to compact. A damaged earlier record
stops loading. The log compacts into a new full checkpoint at 8 MiB. Durable uploads
also checkpoint every 64 receipts, removing their journal copies during long syncs.

**Optimization:** recovery full syncs skip re-hashing files whose size and mtime match the manifest entry. Manual and first syncs never trust timestamps.

**Encrypted server names:** entries stay keyed by plaintext path. An entry also
records its server path as `wire` when that path is not the tag of its name, such as a
note the server created for the iPhone shortcut under a random name. Edits keep that
server path; deleting or renaming the file drops it.

Implementation: `manifest.ts:LocalManifest`

## Error Recovery

- **Retry:** failed uploads retry up to 3 times with exponential backoff (1s base delay)
- **Cancellation:** abort and timeout stop the caller's wait and ignore late responses. Vault discovery checks cancellation before and after every directory listing and hidden-file stat; a cancelled scan never returns a partial inventory. Local hashing also checks cancellation before updating a baseline. Obsidian's HTTP transport may still finish and commit a mutation remotely. Uncertain queued paths remain pending; retries use expected-hash writes and reconciliation, and cancelled incremental runs do not advance the changelog cursor. Concurrent workers and filesystem reads already in progress are drained before a failed operation unwinds. **Stop sync** clears displayed progress immediately, then waits for local work, saves automatic sync as off, and reloads the idle engine.
- **Local deletion recovery:** visible files use Obsidian's local vault trash (`vault.trash(file, false)`); hidden/unindexed files use the adapter's local trash. The vault's `.trash/` directory is always excluded from sync. A trash failure never falls back to permanent removal. The hash check and deletion are not atomic: an edit arriving between them remains recoverable in trash.
- **Upload memory:** incremental and queued uploads reserve room for the next maximum-size file before preparation, using the 48 MiB mobile / 128 MiB desktop budget and a 128-file cap. Chunks finish uploading before further contents are prepared; history retains paths rather than file buffers. These budgets cover prepared binary contents, not total process memory or request encoding overhead.
- **Incremental-to-full fallback:** if incremental sync returns `null` (error/cursor expiry), engine runs full sync
- **Manifest recovery:** corrupt main file recovers from `.tmp` file
- **Startup event recovery:** the startup sync scans the vault itself, and vault events that arrive while it runs are queued once it finishes, keeping the latest change per path. Pending verification settles download echoes and other files that still match their baseline; real edits flush like live events
- **Conflict recovery:** the durable conflict registry recovers from `.tmp` and discovers visible or hidden conflict copies that were created before their metadata was committed
- **Revoked access:** a 401 shows the reconnect message in the status bar and Activity on every sync path. Full, incremental and forced syncs, queue flushes and queue reconciliation treat a 401 reported for one downloaded, uploaded or deleted file the same way. Its notice appears once until a sync succeeds or the connection changes, so background flushes that keep failing do not repeat it
- **Queue retry:** retryable flush failures are re-added to `pendingKeys`; version and validation conflicts request a targeted three-way replan for only the affected paths, with at most three compare-and-swap attempts
- **Large files:** local files > 25 MB are reported as skipped issues, not failures. They never become pending changes or local deletes, settle in the queue without failing their batch, and do not hold back the changelog cursor or an initial import. If a file grows past the limit while initial import or force full sync reads it, that run stops with an error. A remote change to such a path still fails until the local file is reduced
- **Remote recovery:** replaced and deleted R2 objects are retained for 30 days, integrity-checked, and restorable with an expected-hash compare-and-swap
- **Ignored remote cleanup:** changing ignore patterns never deletes data implicitly; settings provide an explicit preview-and-confirm purge action

## Pending change previews

Sync Activity compares the current local file with its last-synced contents.
Matching hashes need no baseline read. Changed text files use the on-device
Markdown cache first, then fetch the matching server copy or retained version
when the cache is unavailable (including JSON configuration files). Fetched
bytes must match the last-synced hash and size; a newer server version is never
substituted. Previews remain limited to 256 KB and do not modify files, the
manifest, or the sync queue. Uncached comparisons require a connection and a
server copy still within retention; failed loads can be retried.

## Discarding local changes

Sync Activity discard compares selected files with the local manifest and restores
their last-synced contents. It uses the on-device Markdown base cache first, then
fetches the matching server copy or retained version when needed, including for
JSON configuration files. Both preview and discard verify the same last-synced
hash and size. Cached copies remain usable offline; uncached copies require a
connection. Missing or unverified versions block review without changing files.
Discard does not upload changes or advance the remote sync cursor. Files absent
from the local manifest move to local trash; unchanged files are kept. Current
server copies can be restored up to the 25 MiB sync limit; uncached retained
versions use the server's 256 KB version-preview limit.

Confirmation rechecks local contents and manifest versions before applying changes.
Recovery copies are verified before replacing files, and edits arriving during
application are preserved. Restored files retain their last-synced revision, so
newer server changes are still discovered by the next normal sync.

## Returning to a history checkpoint

Successful syncs without unresolved conflicts or pending restore/upload intents ask
the server (`shared-history-checkpoints-v1`) to save a complete server file
inventory. R2 holds the inventories and an ETag-protected index; no file contents
are duplicated. Checkpoints are visible on
all connected devices, including devices without local activity history. The index
keeps the newest 20 distinct server generations for at most 30 days. Repeated or
concurrent saves of the same generation resolve to the same checkpoint. Initial and
full syncs always save one; ordinary syncs wait 360 ms per tracked file since the
last checkpoint (one hour at 10,000 files, ten hours at 100,000), keeping inventory
reads near 2.4 per day on the Cloudflare Free plan.

The server reads the inventory in bounded pages and verifies the monotonic changelog
generation before and after capture. An incomplete initial import or concurrent
mutation rejects capture. Current limits are 100,000 files and 32 MiB of metadata;
exceeding them never publishes a partial inventory, and vaults above these limits
get no checkpoints. The small shared index is
published conditionally only after its immutable inventory exists. Uncertain writes
retain their possible committed objects; a bounded, cursor-based maintenance sweep
removes unreferenced metadata after a one-day grace period.

Expiry uses server time. Replaced/deleted versions retain at least 30 days from the
D1 commit time, so a checkpoint expires no later than its required retained bytes.
The server rejects expired or evicted checkpoint reads. Checkpoint file downloads
check the live index and exact current/retained D1 path and revision ownership; the
client verifies size and SHA-256 against the checkpoint before staging. Unlike text
previews, these reads support the full 25 MiB sync-file limit.

Earlier releases saved device-local inventories; their history entries can still
be browsed and restored, and inventories that no sync history entry references are
pruned when the sync engine starts. Shared checkpoints
contain the full remote inventory; each restoring device preserves its current
excluded files and rejects exclusion changes during review.

The History tab keeps expandable sync summaries with uploaded, downloaded, merged,
and deleted files. Each file offers **File history**. A single
**Browse vault history** button opens a dedicated Vault history dialog above Sync
activity. Closing it returns to the unchanged activity list and its previous scroll
position. The wider
screen combines sync selection, files, and saved-state previews in three panes
(History → Files → Diff on narrow screens). Saved contents load only when this
screen opens. A selected checkpoint is compared with the current vault on this
device, including unsynced edits and hidden configuration files, using complete
inventories and verified bytes. Both sides honor the current sync exclusions.
The diff reads **Current vault → Selected saved state**: red is current content
and green is the selected saved content. **Differences** counts files that differ
from the current vault, independently of the selected sync's transfer counts.
Matching inventories show an explicit matching-state message, including for the
newest checkpoint. The oldest checkpoint can be compared without a predecessor.
Selecting a point, completing a sync, or selecting **Refresh comparison** reads
the vault again. Browsing never initiates sync or writes files; incomplete reads
fail visibly instead of displaying a partial comparison.
Entries without checkpoints retain recorded paths and errors; they cannot provide
an exact saved-state preview. File previews retain the 256 KB text limit.

**Vault history → Restore to this point** opens one compact confirmation with the
number of current files that will change, including local unsynced edits. Excluded files remain untouched. The current server
inventory must match the device's baseline before reviewing. Every required version
must still be available from the server's current files or 30-day retained history.
Confirmation stages and verifies all required bytes and originals under
`state-recovery/`, rechecks the complete local and remote inventories, then
persistently pauses automatic sync before applying changes. Replacements use atomic text comparison or
local trash and checked creation; deleted files always go to local trash.

Explicit removals sync before restored uploads to support file/folder namespace
changes. The final full sync and inventory verification must both succeed before
restoring the previous automatic-sync preference. This is a recoverable multi-file
operation, not an atomic server transaction: an interruption can leave some files
restored. Automatic sync remains off on failure, including after restart; reopen
the checkpoint to review and finish, or recover original bytes using the saved
`recovery.json` inventory. Concurrent edits are preserved or surfaced for review,
and a mismatching final inventory is never reported as a successful restore.
