# Backup and recovery

Crate sync is not a backup. Keep independent copies of the vault. A D1 export alone does not contain note bytes: its `storage_key` values point to immutable R2 objects. A complete recovery archive must contain both.

## Create and verify a paired archive

The current recovery CLI supports source schemas 2, 3 and 4, so supported old deployments can be backed up before upgrading. Isolated restoration upgrades schema 2/3 to the current schema 4 while preserving the source archive. Unknown schemas are rejected; see the [compatibility matrix](compatibility.md).

The recovery CLI needs Python 3.9 or newer and a Cloudflare API token authorized for the selected D1 database and R2 bucket. Supply the token through `CLOUDFLARE_API_TOKEN`, never a command-line argument or a committed file. Get the account, database, and bucket identifiers from your deployment settings.

```sh
python3 scripts/crate-recovery.py backup /private/backups/crate-2026-09-06 \
  --account ACCOUNT_ID --database SOURCE_DATABASE_ID --bucket SOURCE_BUCKET
python3 scripts/crate-recovery.py verify /private/backups/crate-2026-09-06
```

The tool exports D1 at a single bookmark, reads its live and retained R2 references, downloads and verifies every object's SHA-256 and size, and writes `archive.json` only after the download succeeds. Settings are captured as a separate R2 object; their capture is independent of the D1 bookmark. The export can temporarily make D1 unavailable; schedule it during a quiet period. See Cloudflare's [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) and [R2 object API](https://developers.cloudflare.com/r2/api/).

The directory contains private vault content, paths, enrollment metadata, and cryptographic keys. Store it on encrypted storage with restricted access. Do not attach it to a public issue. The script creates directories with mode 0700 and files under umask 0077 on systems that support these permissions. Incomplete archives must not be used for recovery. Missing or corrupt source objects fail verification; the script never silently drops their references.

If backup is interrupted, repeat the same command with the same directory and source identifiers. `backup-progress.json` pins the exported database checksum and bookmark; verified object downloads are reused. The CLI paces R2 requests and retries rate limits and transient transport failures with bounded backoff, honoring `Retry-After`. Persistent failures leave the checkpoint available for a later run. Changing the source identifiers or corrupting a checkpoint stops resume.

## Restore into isolated resources

Create a **new empty D1 database and new empty R2 bucket**. Keep them disconnected from any live Worker while restoring. The first attempt rejects either original source resource and nonempty targets. It uploads and reads back verified objects before publishing database references. A partial failure leaves the target offline and never deletes either source or target content.

```sh
python3 scripts/crate-recovery.py restore /private/backups/crate-2026-09-06 \
  --account ACCOUNT_ID --database NEW_DATABASE_ID --bucket NEW_BUCKET
```

The original archive data remains unchanged. The CLI adds a `restore-<destination hash>.json` checkpoint to the archive directory before uploading. The restored database preserves files, retained versions, reminder identities, source ownership, occurrence observations, and mutation receipts. It clears device credentials, subscriptions, parsed caches, expired cleanup intents, and derived alarm state. Retained versions receive a new 30-day recovery window. Every Markdown file is queued for notification projection. Enroll devices again; do not copy old browser sessions or local sync checkpoints to the new deployment.

After an interrupted restore, repeat the same command and keep the destination offline. Its checkpoint binds the archive checksum, destination identifiers, and fixed restore timestamp. Resume verifies every destination object, including uploads whose acknowledgements were lost, and never overwrites mismatched bytes. Unexpected objects or database contents stop the restore. A recorded import bookmark resumes polling; a committed import is recognized by comparing the entire application database with the deterministic restore SQL, without importing again.

If the import acknowledgement was lost before a bookmark was received and the database is still empty, the CLI reports an unconfirmed import. Wait and retry after Cloudflare has finished processing it. An empty database alone does not prove an earlier import was rejected. If Cloudflare never confirms that attempt, retain the target for investigation and restore into another pair of empty resources. Do not edit or discard the checkpoint to force another ingest. Checkpoints do not store the API token, but belong with the private archive and should not be shared publicly.

Before connecting production devices:

1. Deploy the matching Worker version against the restored resources in a new Worker/DO namespace. Use the current Worker with the schema-4 target produced by these tools; supported schema-2/3 source archives upgrade during isolated preparation. Unsupported archives are rejected before remote mutation.
2. Compare the verified file count and hashes with the archive. Test a small disposable vault first, including a reminder edit and a binary file download.
3. Re-enroll a notification device and confirm the saved folder, timezone, and all-day time. Derived schedules are rebuilt from committed Markdown.
4. Back up every existing device vault, then connect one at a time. Local changes made after the archive bookmark need explicit review. Keep the old deployment available for comparison.
5. Retain the source resources and original archive until all devices have been verified.

The automated recovery tests restore a paired archive, check every reference and byte, retain retry receipts, exercise rate limits and interrupted downloads/uploads/imports, and prove corrupt/incomplete archives and unrelated targets are rejected. An independent Cloudflare account restore rehearsal is still a release check; a local test does not establish hosted API, OAuth, or physical-device behavior.

## Investigate a missing note

Pause automatic sync on affected devices and copy their vault directories before editing or forcing synchronization. Preserve the plugin's local manifest, Markdown base cache, conflicts, sync history, and browser draft state. Compare the current file with retained versions and incoming conflict copies. A preserved binary download is labeled as an incoming server copy; its original file remains intact pending review.

Check the vault's `.trash` folder, including after a crash or a failed delete acknowledgement. Crate uses local trash for remote deletions even when Obsidian's deletion preference is permanent. An edit made after the preflight hash check may be in that recovery copy. Restore it only after reviewing the remote deletion and keeping a separate copy; `.trash` itself is excluded from sync.

Collect the server request ID, approximate time, plugin/PWA/Worker versions, operation ID (for web edits), and device ID. Successful mutation logs contain request/session/operation identifiers and opaque file revision keys, without note text or filenames. File changelog revisions identify the committed incarnation; reminder operation receipts identify committed web mutations. Client HTTP errors carry `requestId` for correlation. Debug logs and local histories can contain paths: review them before sharing.

`GET /diagnostics` with a vault credential reports pending and failed notification projections/jobs, terminal delivery failures, oldest failed/overdue delivery times, retained objects, cleanup backlog, mutation receipts, and the last maintenance result. A growing backlog or nonzero failure count needs attention. Repair push enrollment or provider access and reschedule missed reminders to future times; replaying the same exhausted schedule does not reset its retry budget. Oversized reminder notes must be split; their vault bytes remain synced. Do not use force sync, erase local metadata, or restore D1 alone as a first response to a missing-file report.
