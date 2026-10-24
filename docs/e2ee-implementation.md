# End-to-end encryption

Crate can encrypt synced content on the client before it reaches either a Cloudflare deployment or the self-hosted server. Encryption is opt-in, and enabling it converts existing remote data. Updating Crate alone does not enable encryption.

**Reading:** article content, URLs, tags, highlights, browser storage and queued changes are encrypted with the vault key like every other note. Obsidian extracts articles on the device. An unlocked web app asks the server to download a link without storing it, then encrypts the article itself. See [Reading encryption](reading-e2ee-assessment.md) for downloads and sharing behavior.

## Enable and recover

1. Update the plugin and server. Let any sync already in progress finish. Keep an independent backup and close other editing clients during conversion.
2. Open **Crate settings → Sync → End-to-end encryption**. The row checks the server and shows **Off → Enable encryption**, **On → Manage encryption**, or **Converting… → Resume conversion**. Select **Enable encryption** to start. If the status is unavailable, select **Retry**; a failed check never means encryption is off. A saved reset offers its own resume action.
3. Select **Copy**, save the recovery key outside your vault, and check **I’ve saved this key somewhere safe outside my vault.** Then select **Enable encryption**. An empty remote activates encryption without uploading local files. An existing remote converts its files and retained history; unsynced local changes wait for the next encrypted sync. Setup preserves the automatic-sync setting and does not force a normal sync. The dialog replaces the key form with conversion progress, shows acknowledged files/versions against the remaining total when supported by the server, and uses indeterminate progress for settings and cleanup. The completion screen explains manual or automatic sync and how to unlock web apps. Retry continues interrupted work with the same recovery key. Crate verifies that the generated key restores the vault, notification and seal keys before showing setup; copying does not check the acknowledgment or start conversion. There is no required paste-back step. Expand **What changes with encryption?** for conversion details, and keep Obsidian open while conversion runs. If interrupted, select **Resume conversion** in settings, acknowledge the saved key, and select **Resume conversion** in the dialog. A missing or damaged local key prompts you to restore your saved copy first.
4. On another Obsidian device, connect to the server, open **Manage encryption**, and enter the recovery key.
5. Reopen each connected web app after conversion. Select **Connect with Obsidian**, then open **Crate settings → Sync → Manage encryption → Connect web app** on an unlocked Obsidian device. Compare all three numbers on the two screens and select **Approve** in Obsidian only if they match. Then select **Confirm and unlock** in the app after checking the same code. This transfers the vault keys, which unlock both Reading and Reminders. The app remembers them as non-extractable CryptoKeys; pairing never transfers the recovery code. **Use recovery key instead** remains available when an unlocked Obsidian device is unavailable.

Safari and the installed iPhone app have separate key storage. After **Install Crate**, open the Home Screen app and confirm the matching code on both devices; no copying or reinstall is needed. An established app whose keys are missing can pair again without deleting pending work. Storage and conversion failures retain their specific errors. An expired or revoked server session still requires a fresh setup link; encryption pairing does not issue a login credential. Fresh setup links can also unlock the browser through their recovery-code fragment, which is removed during startup.

To test manual unlock after encryption is already enabled, select **Connect another device → Copy link** and use a fresh private browser window. Before opening the copied link, remove only its `crateKey` and `crateReadingKey` fragment parameters, leaving authentication parameters intact (including `reading`, if present). The app can sign in but remains locked. Select **Use recovery key instead**, paste the recovery key and verify that both connected features open, then reload to check that the key is remembered. Use a fresh setup link for each new test session; do not log out of or clear storage in an app with unsynced work just to force this screen.

**Manage encryption** shows **Encryption on** and **Unlocked on this device**, with **Connect web app → Connect** for approval and **Recovery key → Copy** for recovery and other Obsidian devices. Open **Advanced → Check recovery key** to verify your saved copy again. The PWA's **Settings → Encryption** reports Reading and Reminders separately, including their unlocked folders and Reminders notification keys; push permission and delivery status remain in **Notifications**. During conversion, the PWA explains how to resume in Obsidian. Missing or damaged keys lead to the unlock flow without deleting pending work.

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

On the Obsidian device whose local vault should become the new server copy, expand **Manage encryption → Turn off encryption** and select **Reset sync and turn off encryption**. Read the warning and type `reset` to confirm. This deletes remote files, retained versions, shared checkpoints, saved operations and remote sync state. Remote-only files are lost. Local vault files stay intact and are uploaded without encryption, respecting the current sync exclusions. The server operator can then read their contents.

Crate saves a reset checkpoint before contacting the server. Sync and notifications pause; the server revokes existing device credentials, PWA sessions and unused enrollment links. If interrupted, keep this device’s vault and Crate configuration, reopen **Manage encryption**, and select **Resume reset**. A retry continues the same reset and never repeats a completed wipe. Automatic sync resumes with its previous setting only after the local upload and settings save succeed.

After the wipe, uploads and retries use normal conflict-aware sync. Changes made by another device that reconnects during recovery are preserved. If the server definitively rejects the first reset request, Crate releases the checkpoint so you can reconnect; an uncertain response keeps the recovery checkpoint. If a self-hosted tunnel changes address during a reset, select **Server details → Update server address**, then **Manage encryption → Resume reset**. Crate verifies the original vault or reset receipt before moving the saved connection.

Other Obsidian devices must **Disconnect this device** and reconnect. Existing local files on those devices are preserved and may sync back after reconnecting; review them first if you want to keep only the initiating device’s contents. In each PWA, select **Log out**, including from the expired-session screen, then open a fresh app link. Logout discards that browser’s keys, drafts and pending edits. Enable notifications again. An offline browser cannot be remotely erased; it retains its encrypted local copy until it reconnects or its data is cleared.

This works on Cloudflare and self-hosted servers. External backups, provider snapshots and copies on other devices are unchanged; keep the old recovery key if you need to decrypt encrypted backups. Disconnecting an Obsidian device removes its saved encryption keys too.

## Protection boundary

| Protected content | Server-visible metadata |
| --- | --- |
| Note and attachment bytes, original content hashes and content types | Paths, folder names, approximate sizes, revisions and change timing |
| Retained file versions and private fields of converted checkpoints | Checkpoint dates, counts, revisions and storage references |
| Shared settings, reminder titles/descriptions/recurrence and saved operation responses | Current reminder IDs, completion state, due times, notification policy and delivery state |
| Reading articles, URLs, tags, highlights and queued captures | Reading folder, session and feature-policy metadata; links and articles saved from the iPhone shortcut while the server downloads them |
| Notification display text | Push endpoints, delivery timing and payload sizes |

The local Obsidian vault remains ordinary files. Provider snapshots, previous exports, old device copies, and existing backups are not retroactively encrypted. Replacing database rows and objects is not a secure erase of underlying disks, SQLite free pages or provider history. Converted pre-encryption object names can retain old content fingerprints. Use encrypted disks and appropriate backup retention for those copies.

Browser keys are remembered as non-extractable CryptoKeys in IndexedDB. The cache, outbox, drafts and durable encrypted attempts are protected locally. This keeps offline viewing, reload recovery and notification decryption available. Reading supports cached articles and queued offline edits. Offline reminder data remains read-only, as before; pending online edits survive disconnection and resume with their original identities. Existing browser drafts and pending changes are encrypted when their own folder is unlocked; unopened devices, tabs and other folders keep their previous local copies until then. Explicit logout clears keys and private browser state; automatic session expiry preserves recoverable pending work.

A PWA trusts the JavaScript served by its origin. Non-extractable keys do not prevent malicious same-origin code, an unlocked device or a compromised client from using them. Revoking a device removes server access and subscriptions; it cannot erase copied content or keys.

## Implementation

- JWE uses `jose` with A256KW key wrapping and A256GCM content encryption. Each envelope has a fresh content key. Protected headers bind vault, scope, object, purpose and key identity. Unknown formats and mismatched contexts fail closed.
- A random 256-bit vault key encrypts files, settings and receipts. A separate notification key encrypts push text, so a service worker can show it. A P-256 seal key pair lets the server create Reading notes it cannot read back; only its public half is on the server. A random 256-bit recovery code encrypts the full key bundle. Plugin keys use Obsidian secret storage, scoped to the connected deployment.
- A file the server creates for Save to Crate is sealed to the vault seal key: its descriptor carries an ephemeral P-256 key (`seal.epk`), and its wrapping key is HKDF-SHA256 over ECDH with that key, bound to the vault, object, seal key and both public keys. The JWE format is otherwise unchanged. Clients accept a sealed file only as Markdown inside the Reading folder; the Worker accepts one only from its own capture and only as a new file. Editing or renaming the note re-saves it with the vault key.
- Files use `CRATE-E2EE/1` framing. Authenticated private metadata contains path, original hash, size, content type and a digest of public scheduling data. Conversion verifies the original hash and size before interpreting interrupted ciphertext; ordinary files may start with the encryption framing prefix. Transport hashes identify ciphertext; sync planning and merge bases use verified plaintext hashes.
- Encrypted upload journals and PWA attempts persist exact ciphertext before dispatch. Lost-response retries reuse those bytes and operation IDs. File preconditions and atomic two-note moves preserve concurrent-edit safety. Converted receipts settle operations accepted before conversion without sending their plaintext again. Large encrypted responses use 512 KiB D1 chunks in the same transaction as their parent receipt and file changes, preserving exact retries without exceeding the D1 row limit. Cleanup reclaims chunks only after the parent receipt is gone.
- Encrypted commits carry whole-note ciphertext with hash and revision preconditions, so any concurrent edit to that note returns `409 version_conflict`. The Worker replays a committed copy of the operation before reporting a conflict, so a conflict confirms the attempt never committed. Reminders and Reading both mark that immutable attempt rejected and rebuild it once from current files under the same operation ID. The semantic command still carries its preconditions (a reminder's expected revision or project order, or the Reading fields' `before` values), so the rebuild succeeds only while the changed fields are unchanged; another conflict, or a changed field, goes to review. This matches the plaintext Worker, which applies commands to the current note, so edits to other reminders in a shared project note, or to other fields of an article, do not block a save. Rejected attempts are never resent; Reading review entries stay on the device for export.
- Browser cleanup removes only acknowledged attempts outside the server's 180-day retry window, with no pending outbox reference from any session. It skips deletion while this tab has editor drafts, preserves uncertain, rejected, damaged and unknown-format entries, and touches only the unlocked vault. Batches of at most 100 run under the outbox Web Lock and stop when session authority changes. Storage failures do not block normal use.
- Scheduled maintenance removes old file encryption descriptors only when no live file, retained version, changelog entry, deletion/upload receipt, or upload lease references the revision. It checks references atomically, keeps descriptors younger than one day, scans at most 100 per pass, and never removes them during conversion. File contents, retained history, key bundles and recovery envelopes are not deleted by this cleanup.
- A plugin without keys checks current encryption state before dispatching content mutations or URL-title requests. A device still waiting for recovery stops locally instead of uploading a plaintext body for the server to reject.
- Public scheduling projections contain the current occurrence plus encrypted display text. Client completion advances recurrence. Existing source, policy, occurrence and recipient fences remain in effect. Service workers decrypt push text using remembered notification keys; unavailable keys produce a generic notification. Safari's declarative delivery supplies `event.notification` instead of raw `event.data`; replacement notifications preserve its top-level `navigate` URL. The encrypted payload requests service-worker processing with top-level `mutable`, also retaining the nested flag for older Safari releases.
- Browser Web Storage writes remain synchronous and durable before dispatch. A separate random local key, wrapped by the vault key, protects records with XChaCha20-Poly1305 through `@noble/ciphers`. Associated data binds the vault, feature (Reminders or Reading) and storage key. Corrupt records remain available for recovery.
- Conversion freezes ordinary writes, rewrites live and retained R2 content, encrypts settings/checkpoints/receipts, cancels old alarms, converts queued Reading captures and receipts, removes derived plaintext Reading/reminder caches and Reading extraction jobs/handoffs and sweeps unreferenced Crate-managed objects. Each cleanup page batches reference lookups and deletions to stay within the request query budget. Activation invalidates both source verification rows and their scan cursors before rebuilding the inventory and encrypted notification projections. Revalidation bounds encrypted wire bytes separately from the 1 MiB plaintext note limit and always admits one valid file per pass. The first encrypted R2 replacement wins across an interrupted D1 update. Old upload leases remain tracked so cleanup can reclaim a late object from an already-running pre-conversion request.
- D1 uses schema 1; encryption adds no separate tables. Public encryption configuration and descriptors use namespaced maintenance records. Matching encryption authority is required after activation; clients without it cannot read or write the encrypted vault through ordinary routes. Paired backups retain the encrypted configuration and descriptors.

## Moving files and folders

File moves and renames use normal encrypted sync, including moves into or out of the Reading or Reminders folder. Every file uses the vault key, so changing folders never re-encrypts anything or needs a new browser enrollment.

Selecting a different Reading or Reminders folder in settings works as in an unencrypted vault: the server's folder policy changes and selecting a folder does not move local files. Web apps whose session belongs to the previous folder need a fresh setup link. Notes already inside a newly selected Reminders folder schedule notifications after their next edit in Obsidian; until then the server reports them in reminder issues.

Plugin requests without local encryption keys check server encryption before sending sync, settings, Reading or Reminders mutation bodies. This also protects queued Reading URLs after another device enables encryption. A fresh PWA link containing an encryption key stays locked if the server reports no encryption; it cannot fall back to submitting plaintext.

## Current limits

Data-key rotation is not available in this version. Changing server credentials or revoking a browser does not rotate content keys. Turning encryption off requires the destructive reset described above; there is no in-place decryption of server history. The setup UI discloses these limits before activation.

On the Cloudflare Free plan, D1 allows 100,000 row writes per day. Converting a vault rewrites a few rows per live file and retained version, so a vault of tens of thousands of files can reach that limit mid-conversion. Sync stays paused, the dialog reports the failure, and **Resume conversion** continues from the first unconverted file once the limit resets at 00:00 UTC; converted files are not rewritten.

Server-side URL title lookup is disabled for encrypted content, so pasted links keep their URL labels. This avoids revealing URLs from private notes to the server. The existing 25 MiB file and 1 MiB reminder-note limits remain; ciphertext transport permits encryption overhead. Per-note notification metadata is bounded to 2 MiB and 10,000 entries. Large scheduling plans use bounded D1 parameters within one transaction, preserving unchanged alarm tokens and rolling back every chunk on failure. Notes exceeding that limit remain encrypted and synced, and their reminders remain readable and editable in the PWA; a source warning requests smaller projects before encrypted notifications can resume.

Reading uses `/reading/encrypted-*` routes with the same conditional encrypted-file commit boundary. Its local cache/outbox uses a separate cipher and AAD-bound records. Browser exports include readable unlocked records plus preserved unreadable ciphertext and wrapped local secrets. Explicit exports may contain plaintext and should be kept private.

## Verification and release acceptance

Unit tests cover context substitution, tampering, wrong keys, recovery, size bounds, immutable uploads, local storage failures and reminder edits. Worker tests cover encrypted publication/scheduling, interrupted conversion, retained history, sequence fences, incompatible/scoped clients, destructive reset retries, credential revocation and uploads completing after reset. `tests/browser/pwa/pwa-encryption-test.mjs` runs the production PWA against disposable self-hosted D1/R2 in Chromium and WebKit, including conversion, recovery, enrollment, private storage, offline reload, lost-response replay, notification decryption, destructive reset and plaintext PWA re-enrollment. Chromium exercises native offline navigation. The WebKit harness simulates an offline browser signal and unavailable data APIs while serving cached-shell assets, because Playwright WebKit cannot reliably navigate offline through its service worker. Physical-device offline acceptance is still required.

Before production release, complete physical iOS/Android installation and background-push acceptance, hosted Cloudflare quota/CPU checks with representative vaults, and an independent cryptographic/security review. Automated browser tests do not establish OS push delivery or replace that review.

## References

- [JWE standard](https://www.rfc-editor.org/rfc/rfc7516.html)
- [jose documentation](https://github.com/panva/jose)
- [noble ciphers](https://github.com/paulmillr/noble-ciphers)
- [Web Crypto security considerations](https://www.w3.org/TR/webcrypto/#security-considerations)
