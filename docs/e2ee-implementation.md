# End-to-end encryption

Crate can encrypt synced content on the client before it reaches either a Cloudflare deployment or the self-hosted server. Encryption is opt-in. Turning it on replaces the server copy with this device's vault, encrypted. Updating Crate alone does not enable encryption.

**Reading:** article content, URLs, tags, highlights, browser storage and queued changes are encrypted with the vault key like every other note. Obsidian extracts articles on the device. An unlocked web app asks the server to download a link without storing it, then encrypts the article itself. See [Reading encryption](reading-e2ee-assessment.md) for downloads and sharing behavior.

## Enable and recover

1. Update the plugin and server. Sync your other devices so their changes reach the server, keep an independent backup, and close other editing clients until setup finishes.
2. Open **Crate settings → Sync → End-to-end encryption**. The row checks the server and shows **Off → Enable encryption**, **On → Manage encryption**, or **Reset in progress → Resume reset** when this device has an unfinished reset or setup (**View reset** when another device started it). Select **Enable encryption** to start. If the status is unavailable, select **Retry**; a failed check never means encryption is off.
3. Select **Copy**, save the recovery key outside your vault, and check **I’ve saved it outside my vault.** Then select **Enable encryption**. A confirmation lists what is deleted and who must reconnect; type **encrypt** and select **Delete server copy and encrypt**. This device syncs first and stops if that sync has errors or conflicts, so no change that exists only on the server is lost. Crate then deletes the server copy, its retained history and checkpoints (the same wipe as [turning encryption off](#turn-encryption-off)), stores the encrypted vault configuration, and uploads this device's vault encrypted, respecting its sync exclusions. The server refuses to start while saved links are still downloading on the server or an initial import is running; a refused start removes the keys saved for it, so this device keeps syncing in plaintext. Setup restores the previous automatic-sync setting when it finishes. The dialog replaces the key form with progress for each stage. The completion screen explains manual or automatic sync and how to unlock web apps. Crate verifies that the generated key restores the vault, notification and seal keys before showing setup; copying does not check the acknowledgment or start setup. There is no required paste-back step. Until encryption is turned on, reopening the dialog or selecting **Retry connection** shows the same recovery key for that server while Obsidian stays open. Expand **What changes with encryption?** for details, and keep Obsidian open while setup runs. If interrupted, select **Retry** in the dialog, or later select **Resume reset** in settings and **Resume** in **Resume turning on encryption**. Setup saves its keys and a checkpoint before starting the wipe, resumes from that checkpoint, and never repeats a completed wipe. Keep this device’s vault and Crate configuration until it finishes.
4. Turning encryption on revokes every other device credential, web app session, setup link and push subscription. On each other Obsidian device, select **Disconnect this device**, connect to the server again, open **Manage encryption**, and enter the recovery key before syncing. Existing local files on those devices are preserved and may sync back after reconnecting; review them first if you want to keep only this device's contents.
5. In each web app, select **Log out**, including from the expired-session screen, then open a fresh setup link. Logging out discards that browser's drafts and pending edits. Enable notifications again. To unlock, select **Connect with Obsidian**, then open **Crate settings → Sync → Manage encryption → Connect web app** on an unlocked Obsidian device. Compare all three numbers on the two screens and select **Approve** in Obsidian only if they match. Then select **Confirm and unlock** in the app after checking the same code. This transfers the vault keys, which unlock both Reading and Reminders. The app remembers them as non-extractable CryptoKeys; pairing never transfers the recovery code. **Use recovery key instead** remains available when an unlocked Obsidian device is unavailable.

Safari and the installed iPhone app have separate key storage. After **Install Crate**, open the Home Screen app and confirm the matching code on both devices; no copying or reinstall is needed. An established app whose keys are missing can pair again without deleting pending work. Storage and setup failures retain their specific errors. An expired or revoked server session still requires a fresh setup link; encryption pairing does not issue a login credential. Setup links never carry the recovery key, because links persist in browser history and sync and the key cannot be rotated; the web app unlocks by pairing or by entering the recovery key. The web app still accepts a recovery-code fragment from links created by older plugin versions and removes it during startup. In an encrypted vault, a Reminders setup link carries the plaintext folder name only in that fragment (`crateFolder`), never in the query, so it never reaches the server. After unlocking, the web app derives the path key and opens its folder's encrypted label.

To test manual unlock after encryption is already enabled, select **Connect another device → Copy link** and open the copied link in a fresh private browser window. The app signs in but remains locked. Select **Use recovery key instead**, paste the recovery key and verify that both connected features open, then reload to check that the key is remembered. Use a fresh setup link for each new test session; do not log out of or clear storage in an app with unsynced work just to force this screen.

**Manage encryption** shows **Encryption on** and **Unlocked on this device**, with **Connect web app → Connect** for approval and **Recovery key → Copy** for recovery and other Obsidian devices. Open **Advanced → Check recovery key** to verify your saved copy again. The PWA's **Settings → Encryption** reports Reading and Reminders separately, including their unlocked folders and Reminders notification keys; push permission and delivery status remain in **Notifications**. During a reset, the PWA asks you to resume it in Obsidian and then reconnect. Missing or damaged keys lead to the unlock flow without deleting pending work.

The recovery key unlocks the complete synced vault. One vault key encrypts every note, so an unlocked web app holds a key that can decrypt the whole vault, not only Reading and Reminders. Treat the PWA as a trusted client: malicious code served by its origin could capture its keys or the recovery code. Server credentials remain limited to the connected Reading and Reminders features and cannot call vault sync or administration routes. Authentication credentials are independent of decryption keys. Losing all enrolled keys and the recovery key makes remote content unrecoverable.

## App approval protocol

The server advertises `web-pairing-v1`. This flow uses WebCrypto ECDH P-256,
HKDF-SHA256 and AES-256-GCM. The requester commits to its ephemeral public key
and request context before seeing the responder key. It pins the responder key
before revealing its own; the responder verifies that reveal against the
commitment. Both derive the same three four-digit comparison groups (39 bits).
The key and comparison code use different HKDF labels. AES-GCM authenticates
the complete transcript, including origin, request ID, vault, generation,
commitment and both public keys. Private ephemeral keys remain in memory and
are never exportable. Reloading either pairing screen requires a new attempt.

Only the explicit **Approve** action seals the vault key bundle.
The recipient requires its own explicit code confirmation, then checks every key identity against the server's public configuration
before storing keys. Import preserves existing wrapped local secrets for drafts
and queued changes. Changing the connection or closing the screen fences pending
imports. The relay sees public handshake data and ciphertext. It cannot decrypt
the packet by itself. Both confirmations are required: a packet claiming approval is not proof of an Obsidian peer. Without recipient confirmation, a malicious relay could invent keys and a matching public configuration for future writes. The human comparison detects a relay that
substitutes handshake keys; never approve different codes or an unsolicited app.

Requests expire after five minutes. The server retains at most three attempts
per app per five-minute window and 32 across the server, including cancelled
attempts until their expiry. Polls do not mutate pairing records. Conditional
writes restrict each step to its actor and current vault generation. Finish and
cancel remove the encrypted packet; periodic maintenance and new attempts prune
expired records. Polling runs only while a pairing screen is open and visible.
The same Worker route runs on Cloudflare and self-hosted deployments without a
new table or binding.

The commitment and decimal comparison follow the design principles described
in [Matrix SAS verification](https://spec.matrix.org/v1.17/client-server-api/#short-authentication-string-sas-verification).
This is a Crate-specific protocol, not Matrix wire compatibility or an independent
security review. Approval does not protect against malicious code already running
in the PWA or Obsidian. A compromised origin can replace the client itself.

## Turn encryption off

On the Obsidian device whose local vault should become the new server copy, expand **Manage encryption → Turn off encryption** and select **Reset sync and turn off encryption**. Read the warning and type `reset` to confirm. This device syncs first and stops if that sync has errors or conflicts, so remote-only changes reach it. The reset then deletes remote files, retained versions, shared checkpoints, saved operations and remote sync state. Files this device does not sync, such as excluded folders, are lost. Local vault files stay intact and are uploaded without encryption, respecting the current sync exclusions. The server operator can then read their contents.

Crate saves a reset checkpoint before contacting the server. Sync and notifications pause; the server revokes existing device credentials, PWA sessions and unused enrollment links. If interrupted, keep this device’s vault and Crate configuration, reopen **Manage encryption**, and select **Resume reset**. A retry continues the same reset and never repeats a completed wipe. Automatic sync resumes with its previous setting only after the local upload and settings save succeed.

After the wipe, uploads and retries use normal conflict-aware sync. Changes made by another device that reconnects during recovery are preserved. If the server definitively rejects the first reset request, Crate releases the checkpoint so you can reconnect; an uncertain response keeps the recovery checkpoint. If a self-hosted tunnel changes address during a reset, select **Server details → Update server address**, then **Manage encryption → Resume reset**. Crate verifies the original vault or reset receipt before moving the saved connection.

Other Obsidian devices must **Disconnect this device** and reconnect. Existing local files on those devices are preserved and may sync back after reconnecting; review them first if you want to keep only the initiating device’s contents. In each PWA, select **Log out**, including from the expired-session screen, then open a fresh app link. Logout discards that browser’s keys, drafts and pending edits. Enable notifications again. An offline browser cannot be remotely erased; it retains its encrypted local copy until it reconnects or its data is cleared.

This works on Cloudflare and self-hosted servers. External backups, provider snapshots and copies on other devices are unchanged; keep the old recovery key if you need to decrypt encrypted backups. Disconnecting an Obsidian device removes its saved encryption keys too.

## Protection boundary

| Protected content | Server-visible metadata |
| --- | --- |
| Note and attachment bytes, file and folder names, original content hashes and content types | Folder structure (depth and how many items each folder holds), which files are Markdown, approximate sizes, revisions and change timing |
| Retained file versions | Checkpoint dates, file counts, revisions and storage references |
| Shared settings, reminder titles/descriptions/recurrence and saved operation responses | Current reminder IDs, completion state, due times, notification policy and delivery state |
| Reading articles, URLs, tags, highlights and queued captures; Reading and Reminders folder names | Which tagged folders hold Reading and Reminders, session and feature-policy metadata; links and articles saved from the iPhone shortcut while the server downloads them |
| Notification display text | Push endpoints, delivery timing and payload sizes |

The server stores every file and folder name as a 26-character keyed tag and keeps only the `.md` extension readable, so it can apply Markdown rules. A tag depends only on the name and its parent folder: the same name in the same folder always gets the same tag, so the server can tell when a file returns to an earlier name, and names that differ only in letter case or Unicode form share one server path. Equal names in different folders get unrelated tags. Renaming a folder changes the tag of everything inside it, so the server sees each of those files move.

The local Obsidian vault remains ordinary files. Provider snapshots, previous exports, old device copies, and existing backups are not retroactively encrypted. Replacing database rows and objects is not a secure erase of underlying disks, SQLite free pages or provider history. Use encrypted disks and appropriate backup retention for those copies.

Browser keys are remembered as non-extractable CryptoKeys in IndexedDB. The cache, outbox, drafts and durable encrypted attempts are protected locally. This keeps offline viewing, reload recovery and notification decryption available. Reading supports cached articles and queued offline edits. Offline reminder data remains read-only, as before; pending online edits survive disconnection and resume with their original identities. Existing browser drafts and pending changes are encrypted when their own folder is unlocked; unopened devices, tabs and other folders keep their previous local copies until then. Explicit logout clears keys and private browser state; automatic session expiry preserves recoverable pending work.

A PWA trusts the JavaScript served by its origin. Non-extractable keys do not prevent malicious same-origin code, an unlocked device or a compromised client from using them. Revoking a device removes server access and subscriptions; it cannot erase copied content or keys.

## Implementation

- JWE uses `jose` with A256KW key wrapping and A256GCM content encryption. Each envelope has a fresh content key. Protected headers bind vault, scope, object, purpose and key identity. Unknown formats and mismatched contexts fail closed.
- A random 256-bit vault key encrypts files, settings and receipts. A separate notification key encrypts push text, so a service worker can show it. A P-256 seal key pair lets the server create Reading notes it cannot read back; only its public half is on the server. A random 256-bit recovery code encrypts the full key bundle. Clients derive a path key from the vault key with HKDF-SHA256 (salt: the vault ID, info `crate-e2ee-v1/path-tag`); the server never has it. Plugin keys use Obsidian secret storage, scoped to the connected deployment.
- File and folder names: each path segment's tag is HMAC-SHA256 under the path key over the case- and Unicode-normalized name and its normalized parent path, truncated to 16 bytes and encoded as lowercase base32 (26 characters), with `.md` appended for Markdown. The real path exists only in each file's authenticated private metadata; clients check that it matches the tag of the server path before using a file. The server rejects encrypted uploads at readable paths with 428. Because case variants share one server path, the server cannot report that `namespace_conflict`; clients detect it before uploading. Feature folders (the Reading policy, the notification policy and reminders web app enrollment) are stored by tag with a label encrypted under the vault key (`maintenance_state` key `e2ee:folder:<tag>`), which other devices and web apps open and check against the tag. Retained-file search by name (`search` on `/sync/versions`) is not sent.
- A file the server creates for Save to Crate is sealed to the vault seal key: its descriptor carries an ephemeral P-256 key (`seal.epk`), and its wrapping key is HKDF-SHA256 over ECDH with that key, bound to the vault, object, seal key and both public keys. The JWE format is otherwise unchanged. Without the path key the server cannot tag a name, so it gives the note a random tag-shaped server name directly inside the tagged Reading folder and seals the titled name inside. Clients accept a sealed file only as Markdown directly inside the Reading folder; the Worker accepts one only from its own capture and only as a new file. Editing the note re-saves it with the vault key and keeps its server name, which devices remember in the local manifest (`wire`); renaming it moves it to the tag of its new name.
- Files use `CRATE-E2EE/1` framing. Authenticated private metadata contains path, original hash, size, content type and a digest of public scheduling data. Ordinary files may start with the encryption framing prefix. Transport hashes identify ciphertext; sync planning and merge bases use verified plaintext hashes.
- Encrypted upload journals and PWA attempts persist exact ciphertext and its server path before dispatch. Lost-response retries reuse those bytes, that path and the operation ID. File preconditions and atomic two-note moves preserve concurrent-edit safety. Large encrypted responses use 512 KiB D1 chunks in the same transaction as their parent receipt and file changes, preserving exact retries without exceeding the D1 row limit. Cleanup reclaims chunks only after the parent receipt is gone.
- Encrypted commits carry whole-note ciphertext with hash and revision preconditions, so any concurrent edit to that note returns `409 version_conflict`. The Worker replays a committed copy of the operation before reporting a conflict, so a conflict confirms the attempt never committed. Reminders and Reading both mark that immutable attempt rejected and rebuild it once from current files under the same operation ID. The semantic command still carries its preconditions (a reminder's expected revision or project order, or the Reading fields' `before` values), so the rebuild succeeds only while the changed fields are unchanged; another conflict, or a changed field, goes to review. This matches the plaintext Worker, which applies commands to the current note, so edits to other reminders in a shared project note, or to other fields of an article, do not block a save. Rejected attempts are never resent; Reading review entries stay on the device for export.
- Browser cleanup removes only acknowledged attempts outside the server's 180-day retry window, with no pending outbox reference from any session. It skips deletion while this tab has editor drafts, preserves uncertain, rejected, damaged and unknown-format entries, and touches only the unlocked vault. Batches of at most 100 run under the outbox Web Lock and stop when session authority changes. Storage failures do not block normal use.
- Scheduled maintenance removes old file encryption descriptors only when no live file, retained version, changelog entry, deletion/upload receipt, or upload lease references the revision. It checks references atomically, keeps descriptors younger than one day, scans at most 100 per pass, and never removes them during a reset. File contents, retained history, key bundles and recovery envelopes are not deleted by this cleanup.
- A plugin without keys checks current encryption state before dispatching content mutations or URL-title requests. A device still waiting for recovery stops locally instead of uploading a plaintext body for the server to reject.
- Public scheduling projections contain the current occurrence plus encrypted display text. Client completion advances recurrence. Existing source, policy, occurrence and recipient fences remain in effect. Service workers decrypt push text using remembered notification keys; unavailable keys produce a generic notification. Safari's declarative delivery supplies `event.notification` instead of raw `event.data`; replacement notifications preserve its top-level `navigate` URL. The encrypted payload requests service-worker processing with top-level `mutable`, also retaining the nested flag for older Safari releases.
- Browser Web Storage writes remain synchronous and durable before dispatch. A separate random local key, wrapped by the vault key, protects records with XChaCha20-Poly1305 through `@noble/ciphers`. Associated data binds the vault, feature (Reminders or Reading) and storage key. Corrupt records remain available for recovery.
- Turning encryption on reuses the destructive reset: `POST /encryption/reset` on a plaintext vault carries the new public encryption configuration. The device syncs first, saves its keys and a reset checkpoint, then the server revokes other credentials, enrollment links and push subscriptions, clears Reading tables, cancels alarms and marks upload leases for cleanup so a late plaintext object from an already-running request is reclaimed. Repeated reset requests delete every R2 object and vault table in bounded passes; completion stores the encrypted configuration as active. The device then clears its local sync state, uploads its vault encrypted and saves encrypted shared settings. The server refuses to start while saved links are still downloading on the server or an initial import is running. There is no in-place conversion of existing server data.
- D1 uses schema 1; encryption adds no separate tables. Public encryption configuration, descriptors and folder labels use namespaced maintenance records. Matching encryption authority is required after activation; clients without it cannot read or write the encrypted vault through ordinary routes. Paired backups retain the encrypted configuration and descriptors.

## Moving files and folders

File moves and renames use normal encrypted sync, including moves into or out of the Reading or Reminders folder. Every file uses the vault key, so changing folders never needs a different key. A moved or renamed file is stored under the tag of its new name and folder, so it uploads again at that server path; renaming a folder does this for every file inside it.

Selecting a different Reading or Reminders folder in settings works as in an unencrypted vault: the server's folder policy changes and selecting a folder does not move local files. Connected web apps follow a Reminders folder change without a new setup link: the server moves their sessions to the new folder's tag, and each app opens that folder's encrypted label to learn its name. Changes a web app saved for the previous folder are kept for export instead of being sent. After a Reminders folder change, Obsidian uploads the Markdown notes already inside the new folder again, unchanged and conditional on their synced version, so they carry notification schedules. A note it could not republish shows in reminder issues until its next edit.

Plugin requests without local encryption keys check server encryption before sending sync, settings, Reading or Reminders mutation bodies. This also protects queued Reading URLs after another device enables encryption. A fresh PWA link containing an encryption key stays locked if the server reports no encryption; it cannot fall back to submitting plaintext.

## Current limits

Data-key rotation is not available in this version. Changing server credentials or revoking a browser does not rotate content keys. Turning encryption off requires the destructive reset described above; there is no in-place decryption of server history. The setup UI discloses these limits before activation.

On the Cloudflare Free plan, D1 allows 100,000 row writes per day. Turning encryption on uploads this device's whole vault again, writing a few rows per file, so a vault of tens of thousands of files can reach that limit before setup finishes. Sync stays paused and the dialog reports the failure. Once the limit resets at 00:00 UTC, **Retry** or **Resume reset** continues the upload with normal sync, which skips files already uploaded.

Each level of an encrypted server path takes 26 or 27 characters against the 1,024-character path limit, so a file can sit at most 36 folders deep. Turning encryption on stops before the wipe if a synced file is deeper. Deeper files created later fail with "This path is nested too deeply to sync in an encrypted vault."

Unlocked clients still request page titles for pasted links; the server sees each link only while fetching its title and stores nothing. The existing 25 MiB file and 1 MiB reminder-note limits remain; ciphertext transport permits encryption overhead. Per-note notification metadata is bounded to 2 MiB and 10,000 entries. Large scheduling plans use bounded D1 parameters within one transaction, preserving unchanged alarm tokens and rolling back every chunk on failure. Notes exceeding that limit remain encrypted and synced, and their reminders remain readable and editable in the PWA; a source warning requests smaller projects before encrypted notifications can resume.

Reading uses `/reading/encrypted-*` routes with the same conditional encrypted-file commit boundary. Its local cache/outbox uses a separate cipher and AAD-bound records. Browser exports include readable unlocked records plus preserved unreadable ciphertext and wrapped local secrets. Explicit exports may contain plaintext and should be kept private.

## Verification and release acceptance

Unit tests cover context substitution, tampering, wrong keys, recovery, size bounds, immutable uploads, local storage failures and reminder edits. Worker tests cover encrypted publication/scheduling, turning encryption on (including interrupted setup and refused starts), tagged and random server names, retained history, sequence fences, incompatible/scoped clients, destructive reset retries, credential revocation and uploads completing after reset. `tests/browser/pwa/pwa-encryption-test.mjs` runs the production PWA against disposable self-hosted D1/R2 in Chromium and WebKit, including turning encryption on, recovery, enrollment, private storage, offline reload, lost-response replay, notification decryption, destructive reset and plaintext PWA re-enrollment. Chromium exercises native offline navigation. The WebKit harness simulates an offline browser signal and unavailable data APIs while serving cached-shell assets, because Playwright WebKit cannot reliably navigate offline through its service worker. Physical-device offline acceptance is still required.

Before production release, complete physical iOS/Android installation and background-push acceptance, hosted Cloudflare quota/CPU checks with representative vaults, and an independent cryptographic/security review. Automated browser tests do not establish OS push delivery or replace that review.

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### Encryption acceptance

Turning encryption on runs through the production runtime and local Worker bindings in `encryption/reset-runtime.integration.ts`. It checks that the device syncs first so a server-only change survives, that the server then holds only this device's files under tagged names, sealed with the new keys, with no retained plaintext history or other credentials, and that ordinary encrypted sync continues afterwards. It also checks that setup stops before the wipe when a synced file is nested more than 36 folders deep, and that turning encryption off syncs first so a server-only change survives. Setup interrupted before the begin request, after a lost begin response or after a failed settings save resumes with the keys saved for it; a refused start leaves the plaintext server and credential untouched and removes the saved keys, so the next start syncs in plaintext. `encryption/reset.integration.ts` checks the server side: the wipe and activation, rejected configurations, refusal while saved links are downloading or an initial import is running, and refusal of a new configuration for an encrypted vault. The setup browser harness covers the dedicated progress, retry and completion screens without server requests.

Folder changes need no re-encryption. `encryption/sync-engine.integration.ts` also covers tagged server paths: a remote delete on a restarted device, a new file that differs only in letter case from a synced one, a case-only rename between case-insensitive devices, and a shortcut note that keeps its random server name through edits and is deleted after a restart. It syncs a renamed reminders folder through ordinary encrypted sync and republishes unchanged notes so a newly chosen reminders folder gets its schedules, and `encryption/source-rebuild.integration.ts` checks that a reminders note uploaded without schedules is reported as an issue instead of losing its reminders silently.

`node tests/browser/pwa/pwa-encryption-storage-test.mjs` exercises native Chromium/WebKit CryptoKey storage with the production session hook and a delayed cache-cleanup boundary. It covers cross-tab re-enrollment during logout, preservation of new drafts and immutable attempts after reload, rollback when authority changes during deletion, normal logout erasure, repair of partially damaged keys, and preservation of unsupported or unrecoverable records. The full encryption browser test also exercises damaged-key recovery through the unlock UI and turning encryption on over plaintext shared settings, including the first encrypted settings write.

The storage test also runs the production push listener and decryption bundle in a
real service worker, reading keys persisted by the page. It simulates both Safari's
declarative `event.notification` (with null `event.data`) and ordinary push data,
checks decrypted text and navigation, and verifies generic fallback after key
removal or payload substitution. Push transport and native notification display
are simulated; background delivery and lock-screen previews still require an iPhone.

The storage harness also queues real database opens behind blocked native deletions: bootstrap, key enrollment, attempt access and logout cleanup must reject promptly, push decryption must fall back, failed operations must preserve bytes, and abandoned opens must not create stores or write after unblocking. It checks successful retry and future-format preservation in both engines. Unit tests run the production service-worker push handler through the generic-notification deadline and fence late open/upgrade events. Worker `encryption/settings.integration.ts` stores and updates encrypted settings at the former failure size and the full plaintext request limit, and preserves committed settings after oversized writes. The full encryption browser test uses a 2,000-entry exclusion list for encrypted settings writes.

`node tests/browser/pwa/pwa-encryption-test.mjs` exercises both Chromium and WebKit against a disposable production self-hosted runtime. It covers active, locked and resetting encryption status and native IndexedDB cleanup, including expired acknowledgments, pending references from older sessions, drafts, damaged/unknown entries, other vaults' entries, and stale-session fences. It belongs to `test:pwa-browser`. Recovery-verification and settings tests check that setup is gated on decrypting the saved key and that editing the input or changing the connection invalidates verification. Worker `maintenance/encryption-metadata.integration.ts` checks bounded descriptor cleanup and references from files, history, receipts, changelog and upload leases. Run the encryption unit tests, Worker `encryption.integration.ts`, the full sync/notification regressions, and paired backup tests before enabling encryption in a release. Physical iOS/Android background push, browser storage eviction, hosted Worker limits and an independent security review remain separate acceptance checks; see [encryption](e2ee-implementation.md).

`CRATE_WORKER_PREBUILT=1 node tests/browser/pwa/pwa-encryption-regressions-test.mjs` checks long reminder completion, a large reminder acknowledgment stored in bounded chunks, plaintext that resembles ciphertext, setup resumed after a lost reply, tagged server paths, and interrupted save retries against the production local server in Chromium and WebKit. Run `npm run build:worker` first, or omit `CRATE_WORKER_PREBUILT` to build automatically.

Worker `encryption/source-rebuild.integration.ts` covers atomic chunked scheduling for 2,000 reminders with rollback and stable command tokens, and coordinator query budgets while rebuilding dense encrypted sources.

Worker `encryption/sync-engine.integration.ts` runs the production sync engines against D1/R2/DO bindings with persistent mock vaults: three-device offline merges, deletion and rename races, upload-response loss across restart, binary conflict preservation, and a 25 MiB attachment round trip. `encryption.integration.ts` checks atomic publication of ciphertext, descriptors and encrypted schedules, rejects plaintext publication prepared before encryption began, and fences old and scoped clients.

`encryption/upload-validation.integration.ts` exercises authenticated single and batch uploads against real D1/R2/DO bindings. It rejects plaintext, mixed batches and malformed encrypted framing before any staging lease or R2 write, verifies the content guard with an explicit encryption snapshot, rejects valid ciphertext at a readable path, and checks valid ciphertext receipt replay. Reset/upload regressions cover both the public transfer boundary and delayed publication inside the transfer executor.

`upload-publication.integration.ts` rejects Markdown publication at the coordinator
for single, batch and bulk-new uploads. It checks that bytes remain staged without
file metadata, changelog or receipts being committed, while binary uploads retain
their direct publication path.

After `npm run build:plugin`, run `node tests/browser/plugin/encryption-setup-test.mjs` for the
Obsidian encryption setup UI. It uses production key verification with a synthetic
Obsidian host in Chromium and WebKit, at desktop, phone and small-screen sizes in
both themes. It checks that loading and setup keep the same bounds and
header/footer positions, including reduced motion and touch-sized screens. It
also checks full recovery-key visibility, a compact field with Copy above it,
centered checkbox alignment, native settings-row spacing, keyboard acknowledgment, disabling the
action when unchecked, the visible footer, expanded details, clipboard success and
fallback, setup progress, retry and connection changes without
contacting a server. Set `CRATE_OBSIDIAN_CSS_PATH` to an extracted installed
Obsidian `app.css` to repeat the checks with the actual host stylesheet; it is
used only locally and is not committed. The synthetic host also includes the
modal settings-row selector that previously overrode the key field’s spacing.
Physical Obsidian mobile and keyboard behavior still need
manual verification. Unit tests in `src/ui/settings/encryption/encryption-section.test.ts`
cover automatic key-verification failure before setup, retrying an interrupted
setup with the same keys, and resuming a saved setup from the settings row. The optional saved-key
check retains wrong-key, edit and stale-result coverage.

#### Reading encryption acceptance

- `reading/encryption.integration.ts` covers ciphertext-only capture/edit/replay, blocked plaintext paths, captures named after their title and site, and renaming a link-named note when a retry finds its title.
- `reading/sealed-captures.integration.ts` checks that a Shortcut note is sealed under a random server name in the tagged Reading folder, that the vault opens it under its titled name, and that the server cannot read it.
- `encryption/reset.integration.ts` seeds all seven Reading tables and checks immediate/final deletion and old-grant rejection.
- `tests/browser/pwa/pwa-reading-encryption-test.mjs` runs the production PWA against disposable local bindings. Chromium covers offline edits/reload and exact ciphertext retry after response loss. Both browser engines cover enrollment, article access, logout key removal and a Shortcut arriving before folder unlock. It also checks that the production nonce-based CSP blocks injected inline and same-origin scripts while the app and deferred Reading code load, and that hostile encrypted article content remains inert after opening (and offline reopening in Chromium). Use `CRATE_TEST_BROWSER=webkit` for WebKit.
- `node tests/browser/reading/reading-content-security-test.mjs` mounts the production reader and reminder card in Chromium/WebKit document and Shadow DOM hosts with CSP disabled. It covers hostile HTML, malformed mixed namespaces, event handlers, active URLs, DOM clobbering, code-highlighter output and resource requests, while preserving benign Markdown and code. It runs in `test:pwa-browser`. This is regression coverage, not a substitute for an independent security review.
- `tests/browser/pwa/pwa-reading-encryption-storage-test.mjs` covers atomic plaintext-to-encrypted migration/rollback, vault-key recovery, preserving unrelated sessions, locked reads and cleanup racing a new sign-in in both engines.
- `node tests/browser/pwa/pwa-web-app-unlock-test.mjs`: shared recovery-key unlock for Reading/Reminders in Chromium and WebKit, wrong-vault rejection, session changes during import, native key persistence and offline draft recovery after reimport/reload.
- Native iOS Shortcut signing/import and physical iOS/Android offline/push delivery remain manual acceptance. Test encrypted Android after reinstalling its changed manifest. Hosted quota validation must use an explicitly budgeted disposable deployment; do not run local test fixtures against hosted D1.

### Encrypted iPhone onboarding

`node tests/browser/pwa/pwa-encryption-onboarding-test.mjs` checks the production PWA against fixture HTTP responses in Chromium and WebKit: Safari installation guidance, isolated installed-app storage, Reading and Reminders first unlock, wrong-key feedback, pending controls, remembered keys after reload, recovery after key loss, desktop copy and a 320px viewport. These contexts model iOS storage separation; physical Add to Home Screen and background push still require device acceptance.

Mobile setup links first offer **Continue to web** and **Install Crate**. The
script verifies that installation instructions leave vault screens unmounted,
reload keeps the choice, continuing opens the browser app and remembers that
choice, iOS/Android guidance differs, and standalone launches skip the chooser.

The same script starts each destination with one app credential and verifies that
one unlock opens both sections. It simulates offline API failures while serving
app assets, restores an encrypted Reading draft after reload, and expires an
encrypted Reading data request to verify app-wide reconnect without deleting the
draft. `pwa-sync-coordinator-test.mjs` also covers independent background delivery,
feature failures and shared logout before delayed/failed remote revocation.

#### Copy-free encrypted app approval

`node tests/browser/pwa/pwa-pairing-test.mjs` runs the production PWA and approval modal in
separate Chromium/WebKit contexts with real WebCrypto and native IndexedDB. The Obsidian DOM host and HTTP relay are fixtures; service workers are blocked
so requests stay in that fixture. The full encryption suites cover the real worker. It checks both feature entry
points, matching codes, no key persistence until both sides confirm (even after receiving a packet), no plaintext secrets in requests,
cancellation, expiry/restart, transient retry, both feature entry points, non-extractable stored
keys, reload and 320px light/dark layouts. It runs in `test:pwa-browser`.

Worker `encryption/pairing.integration.ts` checks the actual authenticated relay
with local D1, including vault/generation checks, concurrent claims, replay,
cancellation, expiry, revocation, generation/reset fences and attempt limits.
`encryption/pairing/protocol.test.ts`, `plugin/web-app-pairing.test.ts`, and
`pwa/encryption/web-app-unlock.test.ts` cover cryptographic binding, vault/session guards,
whole-bundle transfer and storage validation. These tests write no hosted D1 rows.

On a physical iPhone, install from Safari, open the Home Screen app, select
**Connect with Obsidian**, compare the codes in **Manage encryption → Connect web
app**, and approve. Select **Confirm and unlock** in the app after comparing its code. Verify both sections and relaunch. Repeat after backgrounding
either screen and after a network interruption. Desktop WebKit does not establish
native installation, storage-eviction or background-push acceptance.

The full Reading/Reminders encryption browser suites retain real service workers
and native storage. Their headless WebKit context disables the native push manager:
`getSubscription()` freezes the page on the current macOS test host, reproducible
on an empty page without Crate. Chromium keeps its native provider. These suites
do not establish physical-device push acceptance.

## References

- [JWE standard](https://www.rfc-editor.org/rfc/rfc7516.html)
- [jose documentation](https://github.com/panva/jose)
- [noble ciphers](https://github.com/paulmillr/noble-ciphers)
- [Web Crypto security considerations](https://www.w3.org/TR/webcrypto/#security-considerations)
