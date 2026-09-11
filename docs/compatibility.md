# Upgrade, compatibility and rollback

Compatibility is a contract among plugin code, the Worker, the PWA asset build, persisted formats and recovery tools. A shared prerelease version string does not establish compatibility: retain the exact commit, embedded artifact fingerprint, PWA asset version and checksums in the release record.

## Current format matrix

| Boundary | Current format | Upgrade or recovery behavior |
| --- | --- | --- |
| API writes | `X-Crate-Protocol: 8`; oldest compatible is 7 | Clients negotiate the highest common version. Ordinary protocol-7 writes remain supported; restores require a durable operation and the `restore-operation-receipts` capability. Missing, older or future protocols receive 428 before mutations. Authenticated read endpoints remain available at the HTTP layer; an older application's decoder may still require an update. |
| D1 | `crate_schema = 5` | Empty databases initialize; schema 2/3/4 upgrade additively; other versions are rejected. Joining an existing deployment does not migrate or upload code. |
| Reminder parsing | Parser version 9 | List caches are disposable. Version 9 recognizes CRLF task lines. Durable source verification is rebuilt from current R2 revisions before queued or installed notifications can deliver. |
| Browser read cache | IndexedDB 2; snapshot completeness metadata and session digest | Known version-1 stores receive the freshness store atomically. Old snapshot payloads require a full response. Damaged or newer formats preserve bytes and show recovery guidance. |
| Browser pending commands | `crate-reminder-outbox:v1:` keys, envelope version 1 | Exact bodies and operation IDs survive reload and explicit same-folder session recovery. New IDs contain a server-issued UTC day. Expired commands require review/export; damaged/unsupported envelopes stay quarantined and exportable. |
| Browser drafts | Folder-scoped session-storage records | Session expiry/re-enrollment preserves drafts. Explicit logout clears them across tabs. Legacy unscoped drafts are bound before enrollment changes folders. |
| Local sync checkpoints | Checkpoint envelope version 3 with generation, server authority, rename dependencies, settled upload IDs and restore intents | Read supported version-1/2/3 checkpoints and write version 3. Older plugins reject format 3 to avoid dropping pending restore authority. Select the newest valid main/tmp generation; authority mismatch or unsupported state stops sync. Reconfiguration verifies recovery copies before invalidating both files. The remote manifest is a separate version-1 format. |
| Upload retry journal | Version 2, ordered per-operation files in `pending-uploads/`, bound to the server authority | Persist exact upload bytes, merge preimages and the operation ID before dispatch. Version-1 or unsupported journals stop for review; missing merge preimages are never invented. Recover receipts before planning; checkpoint settled IDs before pruning. Reconfiguration archives the journal with both checkpoint generations. |
| Plugin reminder moves | Journal version 1 in the plugin's `reminder-moves/` directory | Recover before normalization. Ambiguous or unsupported records preserve files and block affected writes for review. |
| Paired recovery archive | Archive format 1, schemas 2/3/4/5 | Verify source bytes without migration; isolated restore upgrades supported schema 2/3/4 to 5 while preserving source archive bytes, receipts and observations. |

No unsupported database or checkpoint is silently interpreted as empty. Signing out is an explicit privacy operation and deletes the browser cache and all pending-command namespaces; a blocked deletion is reported. A cache-only rebuild never clears pending intent or unknown stores. See [browser recovery](pwa-storage-recovery.md) and [checkpoint recovery](sync-checkpoint-recovery.md).

## Upgrade order

1. Preserve device vaults and pending browser text. Create and verify a paired D1/R2 archive with recovery tools that support the source schema. The current tools can archive schema 2, 3, 4 or 5 before any upgrade. Record the deployed artifact and resource identities.
2. Pause sync on every device, close editing web tabs, and allow in-flight writes to finish before publishing the new Worker. Preserve and compare any unresolved older upload: protocol 7 cannot reconstruct an identity for a request made by an older client, and replacing the Worker does not cancel its already-running requests. Also stop deployment/reset activity on older devices and direct account administration. Current deployment ownership cannot fence an older client or dashboard action that ignores it. Resolve any uncertain accepted provider request before proceeding.
3. Install the intended plugin and select **Authorize update**. The client verifies the live bindings, acquires the D1 deployment owner, and checks the current artifact again. It applies the supported additive schema before publishing the new Worker/PWA and updating schedules. Interruption leaves owned recovery state; do not lower a marker or discard a deployment fence to force a retry.
4. Let the new Worker verify sources and drain projection jobs. Existing first-observation timestamps survive. Check diagnostics for parser verification, ambiguous identities and unavailable sources; repair the source notes rather than bypassing validation.
5. Update other plugins and select the offered PWA update. The service worker precaches the target assets before activation and reload; older clients retain their known asset caches. Review pending commands after re-enrollment in the same origin and folder. Never rewrite an uncertain operation's body as part of an upgrade. Retained legacy receipts can confirm earlier commits, but a legacy request without a receipt stops for review; it cannot initiate a new mutation.
6. Run the exact-artifact acceptance checks and retain the pre-update archive until all devices converge. A successful build or local migration test does not establish hosted or physical-device behavior.

The schema 2/3/4-to-5 upgrade only adds tables/indexes and updates the marker. An older Worker may continue using existing tables while that schema is being added; it does not gain the new parser-verification or deletion-audit guarantees until replaced. Quiescing old deployment clients prevents publication races. Avoid relying on that temporary overlap as a supported long-term mixed deployment.

## Rollback policy

Prefer a forward fix using the current schema and protocol. Replacing the Worker with an older parser can restore unsafe notification interpretation; deleting new D1 tables destroys recovery evidence. The updater therefore does not provide a schema downgrade or an in-place historical rollback.

For a historical rollback, keep the current deployment offline or preserved for comparison. Use the historical build and matching recovery tools with its pre-update paired archive, restored into separate empty resources and a fresh Worker/DO namespace. That copy excludes subsequent writes. Review post-backup vault edits and pending browser commands before enrolling devices into the restored deployment. Credentials and local checkpoints from another deployment must not be copied across authorities.

Current recovery tools restore supported old archives into the current schema; they are an upgrade recovery path, not an old-schema downgrade tool. They retain the original database export and object bytes. An unsupported future archive stops before uploading objects or importing SQL. Service-worker and browser-storage downgrades likewise require their matching application; current cache rebuilding refuses unknown formats.

## Rules for the next format change

- Bump the wire protocol when required fields or mutation semantics change. Raise the oldest compatible version whenever an older writer can violate the new invariant, even if its JSON still parses. Specify both old-client/new-server and new-client/old-server behavior.
- Introduce additive D1 structures before code requires them; retain old readers only where verified. Test interrupted initialization/migration, repeated application, queued jobs and an active old request crossing publication.
- Bump the parser/cache version when identical bytes produce different domain state. Revalidate durable notification authority as well as disposable list caches.
- Migrate browser read caches separately from pending intent. Never clear pending commands to install an update, silently repair their operation IDs, or carry them into a different origin/folder. Unknown command formats need export or a matching client.
- Define retry expiry before pruning operation receipts or reserved create identities. An expired or legacy request must remain unable to apply after its receipt disappears, including an already-started transaction. Protocol 6 enforces a 180-UTC-date window at validation and inside publication; cleanup advances a monotonic floor before pruning. Legacy missing receipts fail closed. See [retention](reminder-retention.md).
- Update this matrix, recovery tooling and exact-artifact checklist in the same change. Keep rollback fixtures from every supported source schema and reject unsupported ones before any remote write.

## Local evidence

`protocol-compatibility.integration.ts` sends old, missing, invalid and future protocol headers through the real Worker and D1/R2 bindings, proving that writes cannot change file pointers, settings or reminder receipts while authenticated reads remain available. Provisioner tests and actual D1 migration tests cover schema 2/3/4-to-5 retries; archive tests cover schema-2 backup, isolated upgrade restore, exact source preservation and repeated restore. Native Chromium/WebKit migration, blocking, corruption, auth recovery and service-worker update tests cover their browser boundaries. The release checklist records the remaining hosted and physical acceptance separately.

Protocol 7 requires durable upload identities for both single and batch writes. Older writers receive 428. Upload receipts (including rejected preconditions) share the 180-UTC-date retry window, and schema 5 adds their table plus an index on live storage keys. Parser 8 quarantines non-UTF-8 or NUL-containing Markdown; generic byte sync remains available. See [upload recovery](upload-recovery.md).

Parser 9 additionally recognizes task lines ending in CRLF. The plugin validates raw Markdown bytes before indexing or rewriting reminders, including move recovery. An unreadable source leaves its last known entries visible with an incomplete-list warning and blocks reminder mutations for that file until a successful refresh. Generic byte sync remains available. See [reminder source recovery](reminder-source-recovery.md).

## Protocol 7 to 8 rolling window

Protocol 8 retains protocol 7 for upload, delete, reminder, settings and notification operations. The plugin and PWA negotiate the highest common version before each mutation; they do not rewrite saved operation bodies. New plugins connected to a protocol-7 server can use ordinary sync but refuse restore before dispatch when the safety capability is absent. Old plugins connected to the new server can sync; their restore calls receive 428 until updated. This targeted restriction closes the unsafe legacy restore route without blocking safe operation families.

Maintain at least the current and immediately preceding safe protocol through the next release cycle. Before retiring a version, document the affected operations, keep authenticated recovery reads available, and test pending-command recovery through the 180-day receipt window. A security/data-safety defect may require a targeted earlier fence. Additive fields must remain optional for older decoders; required new semantics must be capability-gated or raise the minimum for that operation. Never silently create replacement IDs for pending work.

`protocol-rolling-upgrade.test.ts` exercises the actual current plugin HTTP transport and PWA fetch implementation against frozen protocol-7 metadata. `protocol-compatibility.integration.ts` sends protocol-7 upload and reminder bodies through the real protocol-8 Worker, verifies exact duplicate receipts, and rejects legacy restores without changing data. These are executable wire-compatibility checks; physical installation and hosted rollout acceptance are recorded separately.
