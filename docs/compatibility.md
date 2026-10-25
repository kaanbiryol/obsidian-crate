# Upgrade, compatibility and rollback

Compatibility is a contract among plugin code, the Worker, the PWA asset build, persisted formats and recovery tools. A shared prerelease version string does not establish compatibility: retain the exact commit, embedded artifact fingerprint, PWA asset version and checksums in the release record.

## Current format matrix

Server revision, schema, wire protocol and transfer limits are checked against source in [current contract](current-contract.md).

| Boundary | Current format | Upgrade or recovery behavior |
| --- | --- | --- |
| API writes | `X-Crate-Protocol: 1`; oldest compatible is 1 | Clients negotiate the highest common version. Restores require a durable operation and the `restore-operation-receipts` capability. Missing or unsupported protocols receive 428 before mutations. Authenticated read endpoints remain available at the HTTP layer; a client's decoder may still require an update. |
| Encryption reset | `e2ee-reset-v1`; local secret-storage checkpoint version 1 | Explicit destructive reset revokes existing credentials, clears remote data/history and reuploads the initiating local vault. A replacement credential and server receipt make retries safe. PWAs must explicitly log out before plaintext enrollment; expiry preserves their encrypted state. |
| Native Shortcut capture | Contract 1; template revision 1; oldest revision 1 | Versioned capture routes evolve independently of the app wire protocol. Only the current contract's routes are admitted; other versions receive 404. The save page offers copyable diagnostics; a template below the oldest revision shows shortcut update guidance. See [shortcut maintenance](reading-shortcuts.md). |
| Initial import | `resumable-initial-import-v1` | Includes a resumable reminder-readiness acknowledgement after upload completion. |
| D1 | `crate_schema = 1` | Fresh databases initialize at schema 1, including the durable capture queue. No migrations are registered. |
| Reminder parsing | Parser version 1 | List caches are disposable; encrypted source rebuilds use ciphertext transport limits. The parser reads both literal `crate-desc:` descriptions, including multiline text, and URI-encoded `crate-desc:v1:` comments. New writes prefer literal text. Calendar recognition follows Chrono; inactive schedule, project and priority mentions, literal addresses and file references are preserved. Unsupported repeat qualifiers remain errors. Durable source verification is rebuilt from current R2 revisions before queued or installed notifications can deliver. |
| Browser read cache | IndexedDB 1; snapshot completeness metadata and session digest | Unknown store layouts preserve their bytes and are reported as unsupported with recovery guidance. Blocked opens are reported. |
| Browser pending commands | `crate-reminder-outbox:v1:` keys, envelope version 1 | Exact bodies and operation IDs survive reload and explicit same-folder session recovery. New IDs contain a server-issued UTC day. Expired commands require review/export; damaged/unsupported envelopes stay quarantined and exportable. |
| Browser drafts | Folder-scoped session-storage records | Session expiry/re-enrollment preserves drafts. Explicit logout clears them across tabs. Drafts are created with their folder scope. |
| Shared history checkpoints | R2 inventory/index format 1; `shared-history-checkpoints-v1` | Shared checkpoints have 20-entry/30-day limits. Existing local checkpoints are not advertised as shared states. |
| Local sync checkpoints | Checkpoint envelope version 1 with generation, server authority, rename dependencies, settled upload IDs, restore intents, optional initial-settings pull hashes and, in encrypted vaults, an entry's server path (`wire`) when it is not the tag of its name | Only version 1 is read and written. Select the newest valid main/tmp generation; authority mismatch or unsupported state stops sync. Reconfiguration verifies recovery copies before invalidating both files. The remote manifest is a separate version-1 format. |
| Upload retry journal | Version 1 for plaintext and encrypted records (encrypted records carry immutable `encryptedWire` bytes and their server path), ordered per-operation files in `pending-uploads/`, bound to the server authority | Persist exact upload bytes, merge preimages and the operation ID before dispatch. Unsupported journals stop for review; missing merge preimages are never invented. Recover receipts before planning; checkpoint settled IDs before pruning. Reconfiguration archives the journal with both checkpoint generations. |
| Plugin reminder moves | Journal version 1 in the plugin's `reminder-moves/` directory | Recover before normalization. Ambiguous or unsupported records preserve files and block affected writes for review. |
| Paired recovery archive | Archive format 1, schema 1 | Restore into the current schema while preserving source archive bytes, receipts and observations. The shared release manifest defines the supported chain. |

No unsupported database or checkpoint is silently interpreted as empty. Signing out is an explicit privacy operation and deletes the browser cache and all pending-command namespaces; a blocked deletion is reported. A cache-only rebuild never clears pending intent or unknown stores. See [browser recovery](pwa-storage-recovery.md) and [checkpoint recovery](sync-checkpoint-recovery.md).

Encrypted vaults additionally require matching vault/generation headers. Their content envelopes use `crate-e2ee-v1`; browser private records use `crate-local-e2ee-v1`. Server paths are keyed name tags, and feature folders carry encrypted labels. Turning encryption on replaces the server copy, so no pre-encryption receipt or history carries over. Encryption cannot be rolled back by deploying an older server. See [encryption](e2ee-implementation.md).

File and folder moves use existing encrypted sync; every file uses the vault key. Encrypted upload journals and saved encrypted attempts always record their key generation and server path, so a retry reaches the same server path with the same bytes.

## Upgrade order

1. Preserve device vaults and pending browser text. Create and verify a paired D1/R2 archive with recovery tools that support the source schema. Record the deployed artifact and resource identities.
2. Pause sync on every device, close editing web tabs, and allow in-flight writes to finish before publishing the new Worker. Preserve and compare any unresolved upload: replacing the Worker does not cancel already-running requests. Also stop deployment/reset activity on other devices and direct account administration. Deployment ownership cannot fence a client or dashboard action that ignores it. Resolve any uncertain accepted provider request before proceeding.
3. Install the intended plugin and select **Authorize update**. The client verifies the live bindings, acquires the D1 deployment owner, and checks the current artifact again. It initializes empty databases or follows the explicit upgrade plan, publishes the Worker/PWA, and verifies the live release before unlocking writes. Interruption leaves owned recovery state; do not lower a marker or discard a deployment fence to force a retry.
4. Let the new Worker verify sources and drain projection jobs. Existing first-observation timestamps survive. Check diagnostics for parser verification, ambiguous identities and unavailable sources; repair the source notes rather than bypassing validation.
5. Update other plugins and select the offered PWA update. The service worker precaches the target assets before activation and reload; clients retain their known asset caches until then. Review pending commands after re-enrollment in the same origin and folder. Never rewrite an uncertain operation's body as part of an upgrade.
6. Run the exact-artifact acceptance checks and retain the pre-update archive until all devices converge. A successful build or local migration test does not establish hosted or physical-device behavior.

Reading is included in the schema-1 baseline, including deferred capture. Migrations must preserve file hashes and object references; a refreshed sync listing must not be confused with re-uploading unchanged contents. See the [server upgrade contract](server-upgrades.md).

## Rollback policy

Prefer a forward fix using the current schema and protocol. Replacing the Worker with an older parser can restore unsafe notification interpretation; deleting new D1 tables destroys recovery evidence. The updater therefore does not provide a schema downgrade or an in-place historical rollback.

For a historical rollback, keep the current deployment offline or preserved for comparison. Use the historical build and matching recovery tools with its pre-update paired archive, restored into separate empty resources and a fresh Worker/DO namespace. That copy excludes subsequent writes. Review post-backup vault edits and pending browser commands before enrolling devices into the restored deployment. Credentials and local checkpoints from another deployment must not be copied across authorities.

Current recovery tools restore supported schema-1 archives into isolated resources; they are not schema downgrade tools. They retain the original database export and object bytes. An unsupported future archive stops before uploading objects or importing SQL. Service-worker and browser-storage downgrades likewise require their matching application; current cache rebuilding refuses unknown formats.

## Rules for the next format change

- Bump the wire protocol when required fields or mutation semantics change. Raise the oldest compatible version whenever an older writer can violate the new invariant, even if its JSON still parses. Specify both old-client/new-server and new-client/old-server behavior.
- Introduce additive D1 structures before code requires them; retain old readers only where verified. Test interrupted initialization/migration, repeated application, queued jobs and an active old request crossing publication.
- Bump the parser/cache version when identical bytes produce different domain state. Revalidate durable notification authority as well as disposable list caches.
- Migrate browser read caches separately from pending intent. Never clear pending commands to install an update, silently repair their operation IDs, or carry them into a different origin/folder. Unknown command formats need export or a matching client.
- Define retry expiry before pruning operation receipts or reserved create identities. An expired request must remain unable to apply after its receipt disappears, including an already-started transaction. The protocol enforces a 180-UTC-date window at validation and inside publication; cleanup advances a monotonic floor before pruning. See [retention](reminder-retention.md).
- Update this matrix, recovery tooling and exact-artifact checklist in the same change. Keep rollback fixtures from every supported source schema and reject unsupported ones before any remote write.

## Local evidence

`protocol-compatibility.integration.ts` sends old, missing, invalid and future protocol headers through the real Worker and D1/R2 bindings, proving that writes cannot change file pointers, settings or reminder receipts while authenticated reads remain available. Provisioner and D1 runtime tests cover baseline preservation, synthetic future transaction rollback, revision fences, interrupted Worker deployment and exact-build resumption; archive tests cover baseline backup, exact source preservation and repeated restore. Native Chromium/WebKit upgrade, blocking, corruption, auth recovery and service-worker update tests cover their browser boundaries. The release checklist records the remaining hosted and physical acceptance separately.

Protocol 1 requires durable upload identities for both single and batch writes. Unsupported writers receive 428. Upload receipts (including rejected preconditions) share the 180-UTC-date retry window, and the baseline schema includes their durable table. The reminder parser quarantines non-UTF-8 or NUL-containing Markdown; generic byte sync remains available. See [upload recovery](upload-recovery.md).

The parser also recognizes task lines ending in CRLF. The plugin validates raw Markdown bytes before indexing or rewriting reminders, including move recovery. An unreadable source leaves its last known entries visible with an incomplete-list warning and blocks reminder mutations for that file until a successful refresh. Generic byte sync remains available. See [reminder source recovery](reminder-source-recovery.md).

## Protocol baseline

Wire protocol 1 is the current contract, with oldest compatible version 1. Server revision and database schema are listed in the [current contract](current-contract.md). Native Shortcuts use an independent capture contract. Use matching plugin, Worker and PWA builds when recreating a development deployment.

`protocol/rolling-upgrade.test.ts` exercises plugin writes against frozen
protocol-1 metadata and preserves saved operation bodies. The PWA is served by
its own Worker and requires that matching server; it has no older-server fallbacks. The Worker compatibility
suite verifies duplicate receipts and rejects unsupported headers and restores
without durable operations before changing data. Future compatible protocol
increments should retain this baseline while its writers remain safe.

Server revisions and database versions advance independently of the wire protocol. See [server upgrades](server-upgrades.md) for the migration registry, verified recovery checkpoints, verification and release rules.

## Local server storage

Ordinary startup of self-hosted Miniflare storage requires the same runtime version and schema hash, and an equal or newer server revision. `check-upgrade` validates compatibility without changing stored data. Migrations require a stopped server and the explicit `upgrade` command, which creates a verified backup. Unsupported runtime or schema changes remain blocked; editing metadata does not make them compatible. Keep the backup and its matching installation before updating. See [Reading upgrade instructions](read-it-later-testing.md#existing-server-upgrade) and [self-hosting backup and restore](self-hosting.md#verified-backups-restore-and-updates).

The parser keeps the last inline schedule active and preserves earlier date and repeat phrases as title text. When a standalone weekday precedes a complete calendar date, only the calendar date is consumed; this keeps a title such as `Notes from Monday` intact after saving and reopening. Canonical recurring reminders combine their readable rule and next occurrence using `crate-rule` metadata. Weekday, alternate-week, plural-weekday, weekday-range and weekend phrases remain recurring. Calendar phrases are passed intact to Chrono: an unmatched phrase such as `February 30 at 9 in the morning` remains title text without an error or a derived morning reminder. Recognized dates follow Chrono's date ordering and year inference.

Reminder creates and edits write literal `crate-desc` description text, including spaces, percent signs, Unicode and newlines. Literal percent signs remain text. The URI-encoded `v1:` form is used only for text containing `--`, literal carriage returns, or a leading `v<number>:` that would otherwise be interpreted as an encoding. Encoded descriptions remain readable; scans and sync do not rewrite them. Unknown version prefixes, invalid URI encoding, unclosed comments and ambiguous comment boundaries remain quarantined. Plugin move journals retain the exact source block and validate complete multiline descriptions.

One-off and repeating editor schedules accept timezone suffixes, for example `tomorrow 09:00 UTC` and `every Monday 09:00 America/New_York`. Named zones use calendar rules for daylight-saving changes; explicit offsets such as `+05:30` remain fixed. Chrono's seasonal abbreviations (`CET`, `ET`, `CT`, `MT`, `PT`) are stored as their corresponding named zones for repeats; its other abbreviations retain their fixed offsets. The recurrence timezone field stores either form. Invalid offsets, unknown IANA names and conflicting suffixes block saving. Timezone text follows the schedule. Clock recognition and any unconsumed title text follow Chrono. Recurrence rules may include optional `second` and `millisecond` fields so accepted precision survives completion and reopening.

The baseline includes `reading-shortcut-pairing-v1`. Enrolled Reading sessions may mint one-use capture grants, but cannot renew or mint library sessions. Capture access is bounded by the issuer’s expiry. Manually configured shortcuts also work. Deploy the signed v1 shortcut through the Pages workflow before distributing a server revision; downloaded templates contain no account data.

An enrolled Reminders PWA can use the same browser credential for Reading after server Reading is enabled. The Reading library stays gated by the active server policy; Reminders credentials still cannot change Reading policy or access vault sync. Browsers open Reading through this Reminders sign-in; there are no Reading-only setup links. Reading-only sessions saved by older versions keep working until they expire.

Reading-folder imports do not require a Clipper marker. Imported notes without a web source use `source_url: ""` with
`capture_method: web-clipper`; URL captures still require a valid HTTP(S) URL.
The server indexes normalized notes and never adopts or
extracts arbitrary folder content itself.

Encrypted Reading uses the vault key and its own encrypted-file routes. It is part of every encrypted vault.

The iPhone Shortcut sends shared URLs to the preparation route; encrypted vaults receive notes sealed to the vault seal key. Publish its signed release asset before distributing the PWA.

Reading's derived source index uses projection format 1 (`_highlightIndex: 1`) and derives YouTube
URL identities from notes. Watch, Shorts, live, embed and shortened URLs
for the same video compare equally.
Transcript timing is derived from ordinary timestamped Markdown, using Reading
note version 1 and the current highlight format.
Optional `transcript_source` and `transcript_language` properties record provenance
and the caption language when known.
