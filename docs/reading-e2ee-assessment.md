# Reading and end-to-end encryption

Reading now uses a separate folder key when vault encryption is enabled. The same implementation runs on Cloudflare and self-hosted servers. This document describes the implemented boundary; [the review](e2ee-review.md) records release acceptance.

## Supported workflow

- Obsidian keeps ordinary local Markdown notes. Sync encrypts their contents, including article text, source URLs, tags, reading status and highlights.
- The PWA uses the same recovery code as Obsidian to open the encrypted key bundle locally, remembers its Reading folder keys, decrypts and indexes notes locally, and publishes conditional encrypted note replacements. It supports article viewing, search, favorites, archive, tags, highlights, offline article caching and queued offline edits.
- Browser library, article, draft, outbox and immutable retry records are encrypted. Queued edits retain their exact encrypted requests after a lost response. Recovery preserves damaged records and exports wrapped local-key metadata; explicit logout clears both Reading and Reminders keys and data, while fencing newer enrollments.
- Existing unencrypted Reading notes, queued captures and operation receipts convert before activation. Derived server indexes, extraction jobs and outstanding plaintext handoffs are removed. Already encrypted vaults can select **Manage encryption → Add encrypted reading** to introduce the Reading scope without deleting their data. Conversion is resumable and also converts retained Reading versions.
- Destructive encryption reset deletes all seven Reading tables, including enrollment and handoff grants, at the start and completion of the reset.

## Saving articles

Obsidian downloads and extracts articles on the device, on desktop and mobile. An encrypted PWA attempts a direct, cookie-free website request. If the website does not permit browser access, Crate already saves an encrypted pending bookmark; an unlocked Obsidian device can later attempt full-text extraction after sync. Saving and opening the link do not require that device. This is independent of the deferred Cloudflare browser-rendering feature. Crate's server never downloads these encrypted captures.

The v2 iPhone Shortcut opens `/notifications?section=reading#readingCapture=…`. The URL remains in the fragment until the app removes it and stores an encrypted local draft. The user unlocks Reading if needed and selects **Save**. The signed v2 template must be published before releasing the updated app; v1 stays available for older servers. Previously installed shortcuts must be replaced because their old HTTP requests can disclose the URL before a server rejects them.

Encrypted manifests omit Android's native Web Share Target. Its POST fallback can send a plaintext URL to the server before any service worker runs. Use **Save a link** in the app. Existing installations should be reinstalled to refresh the manifest. Ordinary unencrypted vaults retain native sharing; shared drafts are protected with a non-extractable device-local key even before enrollment.

## Limits and privacy

Paths, sizes, revisions, timing, feature policy and account/session metadata remain visible to the server. New encrypted captures use generic filenames, but existing filenames are preserved. The PWA trusts the code served by its origin. Websites still see direct download/favicon requests. Local vault files, previous external backups and previously opened devices are not retroactively erased.

The browser accepts at most 10,000 Reading files and 12 MiB of indexed metadata. It retains at most 100 decrypted source notes within a 16 MiB in-memory budget; unchanged metadata is reused without downloading every note on refresh. Persistent opened-article storage remains bounded by the existing 50-article / 20 MiB policy. Unreadable or duplicate-ID notes are shown as issues and block mutations that could overwrite uncertain data. Damaged or future-format offline records stay exportable without blocking healthy articles. If the saved library cannot be decoded, a verified live refresh remains usable with a recovery notice, while the original library and its cached articles remain unchanged.

Reading folders and Reminders scopes must be separate. A Reading scope can be added to an existing encrypted vault. Moving or renaming an enrolled folder, or changing its setting, uses the [resumable folder conversion](e2ee-implementation.md#moving-files-and-folders). Folder and notification keys stay the same; other devices recover the updated bundle and browsers open fresh setup links. Content-key rotation is not included.

## Verification boundary

All validation uses disposable local D1/R2/DO and desktop browser engines. Hosted D1 writes are zero. Physical iOS/Android offline and background-push acceptance, hosted quotas/CPU checks, and an independent security review remain separate release requirements.
