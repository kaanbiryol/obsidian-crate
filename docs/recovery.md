# Backup and recovery

Crate sync is not a backup. Keep independent copies of the vault. A D1 export alone does not contain note bytes: its `storage_key` values point to immutable R2 objects. A complete recovery archive must contain both.

## Create and verify a paired archive

The recovery CLI needs Python 3.9 or newer and a Cloudflare API token authorized for the selected D1 database and R2 bucket. Supply the token through `CLOUDFLARE_API_TOKEN`, never a command-line argument or a committed file. Get the account, database, and bucket identifiers from your deployment settings.

```sh
python3 scripts/crate-recovery.py backup /private/backups/crate-2026-09-06 \
  --account ACCOUNT_ID --database SOURCE_DATABASE_ID --bucket SOURCE_BUCKET
python3 scripts/crate-recovery.py verify /private/backups/crate-2026-09-06
```

The tool exports D1 at a single bookmark, reads its live and retained R2 references, downloads and verifies every object's SHA-256 and size, and writes `archive.json` only after the download succeeds. Settings are captured as a separate R2 object; their capture is independent of the D1 bookmark. The export can temporarily make D1 unavailable; schedule it during a quiet period. See Cloudflare's [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) and [R2 object API](https://developers.cloudflare.com/r2/api/).

The directory contains private vault content, paths, enrollment metadata, and cryptographic keys. Store it on encrypted storage with restricted access. Do not attach it to a public issue. The script creates directories with mode 0700 and files under umask 0077 on systems that support these permissions. Incomplete archives must not be used for recovery. Missing or corrupt source objects fail verification; the script never silently drops their references.

## Restore into isolated resources

Create a **new empty D1 database and new empty R2 bucket**. Keep them disconnected from any live Worker while restoring. The CLI rejects either original source resource and nonempty targets. It uploads and reads back verified objects before publishing database references. A partial failure leaves the target offline and never deletes either source or target content.

```sh
python3 scripts/crate-recovery.py restore /private/backups/crate-2026-09-06 \
  --account ACCOUNT_ID --database NEW_DATABASE_ID --bucket NEW_BUCKET
```

The original archive remains unchanged. The restored database preserves files, retained versions, reminder identities, and mutation receipts. It clears device credentials, subscriptions, parsed caches, expired cleanup intents, and derived alarm state. Retained versions receive a new 30-day recovery window. Every Markdown file is queued for notification projection. Enroll devices again; do not copy old browser sessions or local sync checkpoints to the new deployment.

Before connecting production devices:

1. Deploy the matching Worker version against the restored resources in a new Worker/DO namespace. Finish all schema migrations before enabling clients.
2. Compare the verified file count and hashes with the archive. Test a small disposable vault first, including a reminder edit and a binary file download.
3. Re-enroll a notification device and confirm the saved folder, timezone, and all-day time. Derived schedules are rebuilt from committed Markdown.
4. Back up every existing device vault, then connect one at a time. Local changes made after the archive bookmark need explicit review. Keep the old deployment available for comparison.
5. Retain the source resources and original archive until all devices have been verified.

The automated recovery test restores a paired archive, checks every reference and byte, retains retry receipts, and proves corrupt/incomplete archives and nonempty/source targets are rejected. An independent Cloudflare account restore rehearsal is still a release check; a local test does not establish hosted API, OAuth, or physical-device behavior.

## Investigate a missing note

Pause automatic sync on affected devices and copy their vault directories before editing or forcing synchronization. Preserve the plugin's local manifest, Markdown base cache, conflicts, sync history, and browser draft state. Compare the current file with retained versions and incoming conflict copies. A preserved binary download is labeled as an incoming server copy; its original file remains intact pending review.

Collect the server request ID, approximate time, plugin/PWA/Worker versions, operation ID (for web edits), and device ID. Successful mutation logs contain request/session/operation identifiers and opaque file revision keys, without note text or filenames. File changelog revisions identify the committed incarnation; reminder operation receipts identify committed web mutations. Client HTTP errors carry `requestId` for correlation. Debug logs and local histories can contain paths: review them before sharing.

`GET /diagnostics` with a vault credential reports pending and failed notification projections/jobs, retained objects, cleanup backlog, mutation receipts, and the last maintenance result. A growing backlog or nonzero failed projections needs attention. Oversized reminder notes must be split; their vault bytes remain synced. Do not use force sync, erase local metadata, or restore D1 alone as a first response to a missing-file report.
