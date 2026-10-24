# Reading and end-to-end encryption

When vault encryption is enabled, Reading notes are encrypted with the vault key like every other note. The same implementation runs on Cloudflare and self-hosted servers. This document describes the implemented boundary.

## Supported workflow

- Obsidian keeps ordinary local Markdown notes. Sync encrypts their contents, including article text, source URLs, tags, reading status and highlights.
- The PWA uses the same recovery code as Obsidian to open the encrypted key bundle locally, remembers the vault keys, decrypts and indexes notes locally, and publishes conditional encrypted note replacements. It supports article viewing, search, favorites, archive, tags, highlights, offline article caching and queued offline edits.
- Browser library, article, draft, outbox and immutable retry records are encrypted. Queued edits retain their exact encrypted requests after a lost response. Recovery preserves damaged records and exports wrapped local-key metadata; explicit logout clears both Reading and Reminders keys and data, while fencing newer enrollments.
- Existing unencrypted Reading notes, queued captures and operation receipts convert before activation. Derived server indexes, extraction jobs and outstanding plaintext handoffs are removed. Conversion is resumable and also converts retained Reading versions.
- Destructive encryption reset deletes all seven Reading tables, including enrollment and handoff grants, at the start and completion of the reset.

## Saving articles

Obsidian downloads and extracts articles on the device, on desktop and mobile; its links never reach the server. Browsers cannot read most websites across origins, so an unlocked encrypted PWA sends the link in the body of `POST /reading/encrypted-extract`. The server downloads and extracts the page, returns the article and stores nothing about the request: no D1 row, queue entry, R2 object or log line holds the link or the article. The PWA encrypts the note before committing it. The server therefore sees each link and its public article text while it downloads them; stored notes, URLs and highlights stay encrypted. If the download fails, Crate saves an encrypted bookmark marked unavailable, and **Try again** works on any unlocked device, as in unencrypted vaults. This is independent of the deferred Cloudflare browser-rendering feature.

The iPhone Shortcut holds only its capture token. It sends the shared link to the shortcut prepare route. In an encrypted vault, the server downloads the page outside its write lock, builds the Reading note and seals it to the vault seal key, whose private half only unlocked devices hold. It commits the note as a new file at a generic `Article - <id>.md` path and shows **Saved** in the Shortcuts sheet. No handoff row, queue entry or log keeps the link or article. Devices open the note immediately; the first edit or rename re-saves it with the vault key. Until then, a sealed note can be read by anyone holding the vault keys, and a party with server write access could plant new notes in the Reading folder (creates only). Sharing a link twice creates two notes, because the server cannot see the library. The signed template must be published before releasing the app.

Encrypted manifests omit Android's native Web Share Target. Its POST fallback can send a plaintext URL to the server before any service worker runs. Use **Save a link** in the app. Existing installations should be reinstalled to refresh the manifest. Ordinary unencrypted vaults retain native sharing; shared drafts are protected with a non-extractable device-local key even before enrollment.

## Limits and privacy

Paths, sizes, revisions, timing, feature policy and account/session metadata remain visible to the server. New encrypted captures use generic filenames, but existing filenames are preserved. The PWA trusts the code served by its origin. Websites still see direct download/favicon requests. Local vault files, previous external backups and previously opened devices are not retroactively erased.

The browser accepts at most 10,000 Reading files and 12 MiB of indexed metadata. It retains at most 100 decrypted source notes within a 16 MiB in-memory budget; unchanged metadata is reused without downloading every note on refresh. Persistent opened-article storage remains bounded by the existing 50-article / 20 MiB policy. Unreadable or duplicate-ID notes are shown as issues and block mutations that could overwrite uncertain data. Damaged or future-format offline records stay exportable without blocking healthy articles. If the saved library cannot be decoded, a verified live refresh remains usable with a recovery notice, while the original library and its cached articles remain unchanged.

The Reading and Reminders folders must be separate. Changing either folder needs no re-encryption, because every note uses the vault key; see [moving files and folders](e2ee-implementation.md#moving-files-and-folders). Content-key rotation is not included.

## Verification boundary

All validation uses disposable local D1/R2/DO and desktop browser engines. Hosted D1 writes are zero. Physical iOS/Android offline and background-push acceptance, hosted quotas/CPU checks, and an independent security review remain separate release requirements.
