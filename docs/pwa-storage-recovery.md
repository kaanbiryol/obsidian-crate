# PWA storage recovery

The browser stores confirmed reminder snapshots in the `crate-reminders` IndexedDB database. Pending commands use one local-storage key per operation; editor drafts use session storage. An offline-copy rebuild touches only the selected folder's confirmed snapshot and freshness metadata. It never changes pending commands, drafts, server data, or Markdown files.

## Confirmed offline copies

The current database version is 2. A known version-1 database containing the `snapshots` store with the `folderPath` key receives an additive `freshness` store. The upgrade transaction preserves snapshot bytes; an abort leaves the old version intact for retry. Unknown stores, unexpected keys, and newer database versions are preserved and rejected. There is no destructive automatic downgrade or database reset. A future migration must follow the same ownership checks or use a separate database name.

Opening the cache stops waiting when IndexedDB reports a blocked upgrade, or after three seconds without an outcome. An abandoned request closes its eventual connection and aborts any later upgrade. Startup and confirmed network mutations can continue. **Offline copy unavailable** explains the problem. Close older tabs and select **Rebuild offline copy** to retry known-format access and request a full server snapshot. Unsupported formats require their matching application version; the rebuild action does not erase unknown stores.

Snapshots require complete envelope and reminder validation, unique identities, valid explicit dates and recurrence, scoped file paths, and source-issue metadata. Damaged snapshots retain their bytes until a successful replacement or explicit rebuild. Their ETags are not reused. Older snapshots without completeness or session metadata also require a full refresh. The entire snapshot is rejected rather than presenting a silently shortened list. Without a valid offline copy or server response, the app shows its load error instead of rendering damaged records.

Each snapshot includes a SHA-256 digest of the session credential. The credential itself is not stored in IndexedDB. A replacement session cannot hydrate its predecessor's snapshot, including when an older tab blocks deletion. Successful refreshes recreate the offline copy under the current session. Failed writes preserve the previous committed snapshot and show that offline storage is unavailable.

Explicit logout still deletes the whole private cache and clears pending commands/drafts. A blocked delete remains queued by the browser; the app promptly reports that it could not confirm erasure and directs the user to close other tabs and clear site data. It does not report a blocked deletion as successful. Session and cache generations prevent delayed writes from recreating the signed-out snapshot.

## Verification

`pwa-cache-test.mjs` covers creation, metadata-only 304 refresh, stale revision guards and clearing. `pwa-cache-recovery-test.mjs` runs native IndexedDB in Chromium and WebKit: additive migration, aborted migration/retry, an old connection blocking upgrade, abandoned-request fencing, damaged rows, quota and denied-storage failures, folder-only rebuild, session isolation, future-format preservation, and blocked deletion. It checks that pending-command and editor-draft bytes survive.

`pwa-cache-recovery-ui-test.mjs` exercises the built PWA against native IndexedDB: blocked startup retains the live reminder UI, the keyboard recovery action rebuilds the cache, damaged cached rows stay unrendered during network failure, and reconnection replaces them without using their ETag or losing drafts and pending commands. Cloudflare responses use the local preview server; these tests do not establish physical-device or hosted acceptance.
