# Backup and recovery

Crate sync is not a backup. Keep independent copies of the vault. A D1 export alone does not contain note bytes: its `storage_key` values point to immutable R2 objects. A complete recovery archive must contain both.

## Restore an automatic upgrade backup in Obsidian

Select **Settings → Crate → Server and usage → Restore backup…** under **Server backup recovery**. On a disconnected device with a remembered Cloudflare server, this action appears beside the connection settings. Sign in to Cloudflare if requested, choose a completed backup by date, and review the confirmation.

Crate verifies the paired database and file checksums, creates a separate D1 database and R2 bucket, and copies files and retained history. After checking the restored data, it publishes and verifies a separate server named after your vault with **(restored)** appended. The original server, backup, current connection, and local vault are retained. The new storage counts toward your Cloudflare usage.

Keep Obsidian open while restoring. If the connection fails or Obsidian closes, select **Resume restore** on the same device. The saved restore fixes the backup checksum, destination identities, restore timestamp, and installed server build. Verified uploads are reused; committed database batches are recognized even when their responses were lost. Mismatched bytes or unrelated destination data stop the restore. Keep the same plugin build until recovery finishes; do not delete or edit its saved restore state or destination resources to force a retry. Uncertain Worker publication uses the existing [deployment recovery checks](server-upgrades.md).

After completion, **View restored server** shows its address and offers **Choose server…**. Back up your device vaults before connecting, select the server marked **(restored)**, and reconnect devices individually. Old device tokens, web sessions, subscriptions, and derived schedules are cleared; retained versions receive a new 30-day window. Review local changes made after the backup before syncing. No device is connected automatically. You can also select **Choose backup…** to create another restored server.

This flow reads completed automatic upgrade backups from the remembered server's original R2 bucket; it cannot recover a deleted backup bucket. It supports registered archive schemas up to the installed build's schema version (currently schema 1; see the checked [current contract](current-contract.md)), emitted by Crate's upgrade backup writer, with a database export up to 128 MiB and generated row statements up to 70,000 bytes. For a downloaded archive or a larger export, use the CLI below. Backup SQL is decoded as literal rows and copied into the bundled current schema; downloaded SQL definitions are never executed.

## Create and verify a paired archive

The recovery CLI supports the schemas registered in the shared server release manifest. Registered upgrades preserve the source archive. Unknown schemas are rejected; see the [compatibility matrix](compatibility.md).

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

The original archive data remains unchanged. The CLI adds a `restore-<destination hash>.json` checkpoint to the archive directory before uploading. The restored database preserves files, retained versions, reminder identities, source ownership, occurrence observations, and mutation receipts. It clears device credentials, subscriptions, parsed caches, expired cleanup intents, and derived alarm state. Retained versions receive a new 30-day recovery window. Markdown files in the saved notification folder are queued for notification projection. Enroll devices again; do not copy old browser sessions or local sync checkpoints to the new deployment.

After an interrupted restore, repeat the same command and keep the destination offline. Its checkpoint binds the archive checksum, destination identifiers, and fixed restore timestamp. Resume verifies every destination object, including uploads whose acknowledgements were lost, and never overwrites mismatched bytes. Unexpected objects or database contents stop the restore. A recorded import bookmark resumes polling; a committed import is recognized by comparing the entire application database with the deterministic restore SQL, without importing again.

If the import acknowledgement was lost before a bookmark was received and the database is still empty, the CLI reports an unconfirmed import. Wait and retry after Cloudflare has finished processing it. An empty database alone does not prove an earlier import was rejected. If Cloudflare never confirms that attempt, retain the target for investigation and restore into another pair of empty resources. Do not edit or discard the checkpoint to force another ingest. Checkpoints do not store the API token, but belong with the private archive and should not be shared publicly.

Before connecting production devices:

1. Deploy the matching Worker version against the restored resources in a new Worker/DO namespace. Use the matching Worker for the current schema produced by these tools. Unsupported archives are rejected before remote mutation.
2. Compare the verified file count and hashes with the archive. Test a small disposable vault first, including a reminder edit and a binary file download.
3. Re-enroll a notification device and confirm the saved folder, timezone, and all-day time. Derived schedules are rebuilt from committed Markdown.
4. Back up every existing device vault, then connect one at a time. Local changes made after the archive bookmark need explicit review. Keep the old deployment available for comparison.
5. Retain the source resources and original archive until all devices have been verified.

The automated CLI and in-app recovery tests restore paired archives, check every reference and byte, retain retry receipts, exercise rate limits and interrupted downloads/uploads/imports, and prove corrupt/incomplete archives and unrelated targets are rejected. An independent Cloudflare account restore rehearsal is still a release check; a local test does not establish hosted API, OAuth, or physical-device behavior.

## Investigate a missing note

Pause automatic sync on affected devices and copy their vault directories before editing or forcing synchronization. Preserve the plugin's local manifest, Markdown base cache, conflicts, sync history, and browser draft state. Compare the current file with retained versions and incoming conflict copies. A preserved binary download is labeled as an incoming server copy; its original file remains intact pending review.

Check the vault's `.trash` folder, including after a crash or a failed delete acknowledgement. Crate uses local trash for remote deletions even when Obsidian's deletion preference is permanent. An edit made after the preflight hash check may be in that recovery copy. Restore it only after reviewing the remote deletion and keeping a separate copy; `.trash` itself is excluded from sync.

Collect the server request ID, approximate time, plugin/PWA/Worker versions, operation ID (for web edits), and device ID. Successful mutation logs contain request/session/operation identifiers and opaque file revision keys, without note text or filenames. File changelog revisions identify the committed incarnation; reminder operation receipts identify committed web mutations. Client HTTP errors carry `requestId` for correlation. Debug logs and local histories can contain paths: review them before sharing.

`GET /diagnostics` with a vault credential reports pending and failed notification projections/jobs, terminal delivery failures, oldest failed/overdue delivery times, retained objects, cleanup backlog, mutation receipts, and the last maintenance result. A growing backlog or nonzero failure count needs attention. Repair push enrollment or provider access and reschedule missed reminders to future times; replaying the same exhausted schedule does not reset its retry budget. Oversized reminder notes must be split; their vault bytes remain synced. Do not use force sync, erase local metadata, or restore D1 alone as a first response to a missing-file report.

### In-app restore implementation checks

`src/cloudflare/restore/` owns archive decoding, isolated copy/verification, saved recovery state, and Obsidian dialogs. The deployment service supplies OAuth, operation exclusion, and lifecycle/source fencing. Tests exercise real upgrade-writer archives for each schema supported by the installed build, literal SQL decoding, source preservation, database and object interruptions, and explicit device reconnection. D1 row/checkpoint updates share one [REST query batch](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/); local D1 tests also check rollback and replay. Hosted OAuth, R2 management API, publication, and physical-device restore acceptance require a separate Cloudflare rehearsal.
## Encrypted vaults

Paired archives preserve encryption configuration, folder labels, recovery envelopes, immutable descriptors and ciphertext stored under tagged names. Restoring those bytes does not decrypt them. Keep the recovery key outside the archive and vault, restore with an encryption-capable server, and unlock clients before syncing. Archives created before encryption was turned on remain plaintext. Server authentication and push credentials in an archive still require private storage even when note content is encrypted.

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### File history browser checks

Run `npm run build && npm run test:file-history-browser` for the production file-history renderer in Chromium and WebKit, at desktop/mobile widths in light and dark themes. The harness covers chronological history, direct file access including deleted files and files with no earlier versions, desktop/mobile version navigation, keyboard selection, compact no-difference previews, saved text escaping, local comparisons, deletion filtering, preview retry, and restore confirmation/cancellation. Screenshots are written to `.generated/file-history/`. Obsidian supplies the real modal focus shell; verify native focus/dismissal and physical-device navigation separately.

Whole-vault history restore is covered by `src/sync/history/restore.test.ts`,
`src/sync/runtime/history-restore.test.ts`, and
`src/cloudflare/worker/sync/history-state-restore.integration.ts`. The file-history browser
harness also checks the checkpoint action, per-file preview, cancellation, busy
controls, unavailable versions, and retry in both engines and viewport sizes.
History rows show second-level timestamps; restore-point IDs appear in the confirmation. Browser checks
cover selecting same-minute points, exact-point text diffs, addition/removal
previews, escaped text, and ignoring stale previews when switching files.
The History tab retains expandable sync entries and per-file history actions. One
**Browse vault history** button opens the dedicated three-pane screen. The harness
checks file actions, expanded rows and focus across refresh, lazy loading,
stacked dialog dismissal and focus return to the preserved activity list, desktop
columns, mobile pane navigation, selected restore targets,
current-vault comparisons even for the oldest checkpoint, matching-state messages,
explicit comparison refresh, load retry, stale sync requests, and selection
stability during refresh. `engine/history.test.ts`,
`history-comparison.test.ts`, and `runtime/history-comparison.test.ts` cover
complete-inventory comparisons, unsynced edits, hidden configuration, exclusions,
incomplete reads, missing saved states, byte verification, preview limits, and
connection changes.
`file-history-preview.test.ts`, `pending-diff.test.ts`, `history-comparison.test.ts`
and `conflict/review.test.ts` protect each flow's BOM behavior and rejection of
binary or invalid UTF-8 text alongside storage, size and integrity checks.
Restore opens a compact confirmation directly from Vault history. Browser checks
cover transparent footer actions, current-file counts, cancellation during preflight,
unavailable versions, unchanged states, busy dismissal guards, and failed-restore
retry with a fresh preflight. No extra diff review or second confirmation appears.
For native Obsidian acceptance, verify dismissal is blocked while restoring,
restore an edit/deletion/rename/addition checkpoint in a disposable synced vault,
and confirm another device converges. Interrupt a restore and restart Obsidian to
verify automatic sync stays off and the local recovery copies remain available.

Shared-checkpoint coverage also exercises a second device discovering and restoring
another device's checkpoint without its local history, retained attachments over
256 KB, concurrent publication, lost index-write responses, page-generation races,
20-entry limits, expiry, metadata cleanup, and vault-token authorization. Run
`npx vitest run --config vitest.cloudflare.config.ts src/cloudflare/worker/sync/history-state-restore.integration.ts`
for those real D1/R2/DO checks. Hosted and physical-device acceptance still requires
updating the server and plugin on both devices and restoring from the second one.
