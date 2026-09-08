# PWA storage recovery

The browser stores confirmed reminder snapshots in the `crate-reminders` IndexedDB database. Pending commands use one local-storage key per operation; editor drafts use session storage. An offline-copy rebuild touches only the selected folder's confirmed snapshot and freshness metadata. It never changes pending commands, drafts, server data, or Markdown files.

## Confirmed offline copies

The current database version is 2. A known version-1 database containing the `snapshots` store with the `folderPath` key receives an additive `freshness` store. The upgrade transaction preserves snapshot bytes; an abort leaves the old version intact for retry. Unknown stores, unexpected keys, and newer database versions are preserved and rejected. There is no destructive automatic downgrade or database reset. A future migration must follow the same ownership checks or use a separate database name.

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

Removal verifies the enrolled folder, storage key and full exported string immediately before deletion, then verifies deletion succeeded. A changed draft or storage error keeps the editor blocked with an explanation. An unreadable storage API offers retry and never opens an editor over an unknown draft. Ordinary valid drafts and valid legacy attempted bodies retain their existing restore behavior. Explicit logout still clears drafts as a privacy operation.

## Verification

`pwa-cache-test.mjs` covers creation, metadata-only 304 refresh, stale revision guards and clearing. `pwa-cache-recovery-test.mjs` runs native IndexedDB in Chromium and WebKit: additive migration, aborted migration/retry, an old connection blocking upgrade, abandoned-request fencing, damaged rows, quota and denied-storage failures, folder-only rebuild, session isolation, future-format preservation, and blocked deletion. It checks that pending-command and editor-draft bytes survive.

`pwa-cache-recovery-ui-test.mjs` exercises the built PWA against native IndexedDB: blocked startup retains the live reminder UI, the keyboard recovery action rebuilds the cache, damaged cached rows stay unrendered during network failure, and reconnection replaces them without using their ETag or losing drafts and pending commands. Cloudflare responses use the local preview server; these tests do not establish physical-device or hosted acceptance.

`pwa-outbox-recovery-test.mjs` exercises two built-PWA tabs in Chromium and WebKit at a mobile viewport. Healthy current and earlier-session commands sync despite damaged neighbors; only valid operation bodies reach the preview server. Downloads preserve exact Unicode and malformed JSON strings, markup stays inert, and removal after a concurrent edit preserves changed and unexported entries. Unit tests also cover quota-free quarantine, invalid reminder presentation fields, conflicting recovery destinations and explicit logout cleanup.

`pwa-draft-recovery-test.mjs` verifies the built editor in Chromium and WebKit: malformed fields stay unrendered, close/reload preserves exact strings, export includes full Unicode text without executing markup, and changed or failed storage removals cannot open an editor over the retained draft. Other folders remain private, and no reminder mutation is sent during recovery.
