# PWA storage recovery

The browser stores confirmed reminder snapshots in the `crate-reminders` IndexedDB database. Pending commands use one local-storage key per operation; editor drafts use session storage. An offline-copy rebuild touches only the selected folder's confirmed snapshot and freshness metadata. It never changes pending commands, drafts, server data, or Markdown files.

## Confirmed offline copies

The current database version is 2. Fresh databases create both `snapshots` and `freshness` stores. Pre-launch version-1 databases are unsupported and remain untouched. Unknown stores, unexpected keys, and newer database versions are preserved and rejected. There is no destructive automatic downgrade or database reset. A future migration must follow the same ownership checks or use a separate database name.

Opening the cache stops waiting when IndexedDB reports a blocked upgrade, or after three seconds without an outcome. An abandoned request closes its eventual connection and aborts any later upgrade. Startup and confirmed network mutations can continue. **Offline copy unavailable** explains the problem. Close older tabs and select **Rebuild offline copy** to retry known-format access and request a full server snapshot. Unsupported formats require their matching application version; the rebuild action does not erase unknown stores.

Snapshots require complete envelope and reminder validation, unique identities, valid explicit dates and recurrence, scoped file paths, and source-issue metadata. Damaged snapshots retain their bytes until a successful replacement or explicit rebuild. Their ETags are not reused. Older snapshots without completeness or session metadata also require a full refresh. The entire snapshot is rejected rather than presenting a silently shortened list. Without a valid offline copy or server response, the app shows its load error instead of rendering damaged records.

Each snapshot includes a SHA-256 digest of the session credential. The credential itself is not stored in IndexedDB. A replacement session cannot hydrate its predecessor's snapshot, including when an older tab blocks deletion. Successful refreshes recreate the offline copy under the current session. Failed writes preserve the previous committed snapshot and show that offline storage is unavailable.

Explicit logout still deletes the whole private cache and clears pending commands/drafts. A blocked delete remains queued by the browser; the app promptly reports that it could not confirm erasure and directs the user to close other tabs and clear site data. It does not report a blocked deletion as successful. Session and cache generations prevent delayed writes from recreating the signed-out snapshot.

## Damaged pending commands

A damaged or unsupported pending-command entry is quarantined in its original local-storage key. Reading the queue neither rewrites nor deletes it, and needs no additional storage space. Valid commands remain available and can sync with their original operation IDs and request bodies. Valid commands from an earlier session still require the existing same-folder review and resume action. A damaged destination never overwrites a valid earlier-session recovery source.

**Damaged pending changes** shows the number of affected entries and a text preview. **Export damaged entries** downloads a JSON file containing the exact original strings and their storage keys for the current origin and enrolled folder, including earlier sessions in that folder. Other folders and healthy commands are excluded. The preview renders text, limits each entry to 20,000 characters, and scrolls within the mobile viewport; the export contains every byte represented by the stored strings.

Compare the export with current reminders before restoring missing text in Obsidian. An uncertain request may already have committed. Damaged requests are never automatically repaired, replayed, or assigned replacement operation IDs. Exported files contain private reminder text and should be kept locally or redacted before sharing.

After confirming **I saved and reviewed the export**, **Remove exported copies from device** removes only still-damaged entries whose current key and string exactly match that export. Changed, repaired, unexported, or differently scoped entries survive. The operation uses the same cross-tab lock as sending. Explicit logout clears quarantined entries along with other pending commands. Storage-access failures still block queue initialization with an actionable error; an unreadable storage API is never treated as an empty queue.

## Saved editor drafts

Opening an editor validates every stored draft field, recurrence and retained-attempt envelope before rendering it. Malformed JSON, damaged fields, out-of-folder attempts and a different recovery operation remain in their original session-storage key. **Saved draft needs review** offers the same exact-string export and reviewed removal controls as damaged pending commands. Closing or reloading that screen preserves the draft. Export and compare it with current reminders before removing it and opening a fresh editor; a retained earlier attempt may already have committed.

Removal verifies the enrolled folder, storage key and full exported string immediately before deletion, then verifies deletion succeeded. A changed draft or storage error keeps the editor blocked with an explanation. An unreadable storage API offers retry and never opens an editor over an unknown draft. Ordinary valid drafts retain their restore behavior; obsolete attempted-save envelopes require review. Explicit logout still clears drafts as a privacy operation.

## Verification

`pwa-cache-test.mjs` covers creation, metadata-only 304 refresh, stale revision guards and clearing. `pwa-cache-recovery-test.mjs` runs native IndexedDB in Chromium and WebKit: unsupported old-format preservation, an old connection blocking upgrade, abandoned-request fencing, damaged rows, quota and denied-storage failures, folder-only rebuild, session isolation, future-format preservation, and blocked deletion. It checks that pending-command and editor-draft bytes survive.

`pwa-cache-recovery-ui-test.mjs` exercises the built PWA against native IndexedDB: blocked startup retains the live reminder UI, the keyboard recovery action rejects the retired format until explicit cache clearing, damaged cached rows stay unrendered during network failure, and reconnection replaces them without using their ETag or losing drafts and pending commands. Cloudflare responses use the local preview server; these tests do not establish physical-device or hosted acceptance.

`pwa-outbox-recovery-test.mjs` exercises two built-PWA tabs in Chromium and WebKit at a mobile viewport. Healthy current and earlier-session commands sync despite damaged neighbors; only valid operation bodies reach the preview server. Downloads preserve exact Unicode and malformed JSON strings, markup stays inert, and removal after a concurrent edit preserves changed and unexported entries. Unit tests also cover quota-free quarantine, invalid reminder presentation fields, conflicting recovery destinations and explicit logout cleanup.

`pwa-draft-recovery-test.mjs` verifies the built editor in Chromium and WebKit: malformed fields stay unrendered, close/reload preserves exact strings, export includes full Unicode text without executing markup, and changed or failed storage removals cannot open an editor over the retained draft. Other folders remain private, and no reminder mutation is sent during recovery.

## Storage protection and pending exports

**Settings → Device storage** reports whether persistent storage is granted, best effort, or unavailable. **Protect offline data** asks the browser for persistence where supported; denial retains the best-effort status. Persistence reduces automatic eviction risk but cannot protect against clearing site data, device loss, or every platform policy. Pending mutations exist only on this device until their server outcome is confirmed.

**Settings → Sync → Export unsynced reminders** saves all current-session pending changes with their exact request bodies and operation IDs. The export contains private reminder text but no session credential. It does not discard anything or replay the export. Keep it outside browser storage and compare with current reminders before recovering text; uncertain operations may already have committed. Routine pending changes use the header sync indicator without a separate notice, including while offline.

Logout invalidates in-memory authority and removes private rendered content before attempting any storage deletion. Token, draft, queue and cache cleanup run independently; failures leave a persistent sign-in-screen warning and direct the user to clear site data and revoke the browser session in Obsidian. A failed token removal cannot guarantee that reloading the browser will forget that credential. `pwa-storage-safety-test.mjs` injects these failures in the built Chromium and WebKit clients, checks persistence grant/denial/unavailability and downloads an ordinary pending export.

## Reading storage validation

Reading validates session fields, list and article caches, drafts and pending commands
when reading browser storage. A damaged pending queue blocks dispatch and retains its
original records for **Export earlier changes** or **Export Reading data**. Validation
preserves exact dispatched request bodies, operation IDs and unknown metadata. It never
repairs an uncertain command or interprets an unreadable queue as empty.

Hydration reads the cache, queue and draft independently. A damaged cache can be replaced
by a confirmed server refresh without discarding pending work. A damaged draft remains
untouched: the empty capture form cannot overwrite it during startup. Export and review
the retained data before changing browser storage; reload after repairing storage.

`src/pwa/reading/storage.test.ts` covers malformed durable records and exact-byte
preservation. `scripts/reading-optimistic.browser.test.mjs` also verifies native
IndexedDB preservation through reload and retry in Chromium and WebKit.

Reading refresh commits the list and article removals in one IndexedDB transaction.
A failed list write leaves the previous list and articles intact. A source issue
does not authorize removing that source's cached article or its last verified list
entry; the issue remains visible while the saved copy is retained. Unknown article
records remain available for export. A complete response without that source or
an issue still removes its derived offline copy. HTTP failures preserve the prior
snapshot. `scripts/reading-cache-recovery.browser.test.mjs` tests these boundaries
in native Chromium and WebKit storage, including a quota failure after pruning.

Reading enrollment captures the current credentials and logout marker before
exchanging a setup grant. A delayed response cannot replace a newer session or
restore access after logout. Unused returned credentials are revoked on a best-effort
basis without storing their install grant or hydrating private data.
`scripts/pwa-auth-recovery-test.mjs` checks these cross-tab races in Chromium and WebKit.
## Encrypted enrollments

Encrypted enrollments unlock before reading private local state or draining the queue. Non-extractable folder and notification CryptoKeys live in `crate-encryption-keys`; a wrapped local key protects outbox/draft values, snapshots, cross-tab settlements and `crate-encrypted-reminder-attempts`. Conversion preserves and encrypts current-folder pending text in place. Quota failures keep the original bytes; damaged ciphertext remains quarantined. Exporting a healthy pending change explicitly decrypts its contents, so protect the downloaded file. Existing offline snapshots remain read-only. Expiry preserves keys and drafts for same-folder recovery; explicit logout clears them. See [encryption](e2ee-implementation.md).

Automatic attempt cleanup uses the server's operation day and keeps acknowledgments for the full 180-day retry window. It removes only expired acknowledged records without an outbox reference in any session, skips deletion while this tab has drafts, and preserves uncertain, rejected, damaged, and unknown-format records. Cleanup is bounded, shares the outbox Web Lock, and aborts if session authority changes. It does not delete drafts, pending commands, or encryption keys.

After a destructive encryption reset and explicit logout, already-open tabs can adopt a fresh unencrypted enrollment without reloading. The current session's encryption check releases the old in-memory storage lock before enabling drafts, pending commands and offline caching. Retained encryption markers, failed online checks and responses from an older session cannot unlock plaintext writes; any leftover ciphertext remains unchanged for recovery.

A valid folder grant can repair damaged saved data or notification CryptoKeys by decrypting the existing wrapped browser key. Recovery preserves that local key, so pending attempts and drafts remain readable. Unsupported records, a damaged wrapped key, mismatched folder identity, and older grants remain unchanged for recovery; they never trigger a replacement random local key. Logout carries its session check through cache cleanup, module loading and IndexedDB transactions, so delayed cleanup cannot erase a replacement session's keys or immutable attempts.

Opening either encrypted database rejects a blocked request immediately or stops waiting after three seconds. Startup and unlock report a retryable storage error; failed logout cleanup still reports unconfirmed erasure. Abandoned opens close late connections and abort late upgrades, so they cannot enroll keys or modify attempts after reporting failure. Unknown database versions and stores remain untouched. Push display has its own three-second deadline covering both key reads and decryption: it shows the generic **Crate reminder** notification if private display text cannot be obtained in time.

Encrypted Reading protects library/article caches, drafts, pending semantic commands and exact wire attempts in `crate-reading-v1`. Enrollment migrates only the current session's records and shared drafts in one transaction before hydration; failure leaves originals intact. Reading uses an independent local cipher wrapped by its Reading folder key. A recovery export includes readable unlocked records, preserved unreadable ciphertext and wrapped local-key metadata; keep exports private and retain the original folder recovery key.

A private-fragment Shortcut capture is staged first with a non-extractable device-local share key. The URL never needs a server POST and survives the folder-unlock reload. Shared records bind their encryption to their random share ID; logout deletes the key and records together. Key creation/write fencing prevents an in-flight share from silently surviving with a deleted key.
