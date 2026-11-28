# Worker API

Source lives in `src/cloudflare/worker/`; `scripts/build-worker.mjs` writes the deployable module to `.generated/cloudflare/worker.mjs` and the self-hosted server's module, which adds raised file limits and chunked transfers, to `.generated/cloudflare/worker-self-hosted.mjs` (see [architecture](architecture.md)). Routes marked self-hosted below do not exist on Cloudflare. The Vite production build embeds a compressed, hashed copy of that generated module for the in-plugin OAuth deployment. `src/cloudflare/worker-runtime.json` holds the compatibility date, flags, binding names and rate limit that the deployment payload and the local server both use; a test keeps `wrangler.jsonc` in step with it.

Each route is declared once in `routes/policy.ts`, with its methods, token scopes and execution. `routes/<domain>.ts` dispatches that domain's paths to handlers and holds no SQL. Handlers and their SQL live in the feature folders, such as `reminders/handlers/` and `reading/`, and throw domain errors that the request handler maps to responses.

App mutations require an `X-Crate-Protocol` the server accepts (1 or 2, or only 2 on a self-hosted server with a raised file limit); check `/.well-known/crate` before writing. Missing/incompatible protocols receive 428. The versioned native Shortcut transport has its own compatibility contract, described below. POST metadata and batch-download requests are reads. See [the protocol contract](protocol.md) for retry, revision, storage, and notification guarantees. Responses carry `X-Crate-Request-Id` for diagnostics. Authenticated responses also carry `X-Crate-Encryption-State: on|off`; clients skip the `/encryption` probe before plaintext requests while it reports `off`, and the server still rejects plaintext into an encrypted vault with 428.

## Authentication

All non-public API endpoints require an `Authorization: Bearer <token>` header. Tokens have `vault`, `reminders` or `reading_capture` scope, and may have an expiry. Reading grants are also bound to the active Reading policy generation. The Worker hashes the bearer token with SHA-256 and looks up the hash in the `auth_tokens` D1 table, joined with the single `server_state` row that holds the encryption state, feature policy and reset generation. Authentication fails closed with `503` when D1 is unavailable, or with the `d1_daily_limit` 429 below once the daily allowance is used. A failed last-seen update does not block the request.

Vault device tokens are registered only through Cloudflare account authorization: directly through a temporary Cloudflare OAuth authorization, or by redeeming a one-use [device pairing code](#post-authdevice-pairing-public) that a connected device wrote through the Cloudflare D1 API. No device token can issue a vault credential. PWA exchanges create 90-day `reminders` tokens bound to the enrolled folder. Once a Reading folder is configured, the same token can use Reading library, save, update, and shortcut-pairing routes. It cannot change the Reading folder, and it cannot call sync, settings, device-management or push-administration routes. Public compatibility, PWA assets, and reminder-enrollment endpoints are listed separately below. CORS headers are included on all JSON/API responses.

Self-hosted installations additionally have a Node gateway, outside the Worker:
`GET /__crate/ready` returns a per-process readiness identifier, and
`POST /__crate/pair` exchanges `{ code }` for `{ authToken }`. Pairing codes have
256 bits of randomness, expire after ten minutes, and are claimed once before
credential creation. Only a local authenticated administration socket can issue
codes; this socket is never forwarded through the public tunnel. The gateway
does not enable device registration on Cloudflare-hosted Workers. Existing vault
tokens and scoped PWA enrollment keep their current behavior.

## Admission before database work

Unknown routes and unsupported methods return 404 before authentication or
coordinator work. Public static assets and OPTIONS remain available without an
API budget. Other requests with unrecognized credentials, plus the sensitive
Reading/notification actions, use the edge admission binding: 60 requests per
minute per hashed source address and deployment host. Invalid rotating bearer
tokens share that budget. The local server replaces client-supplied forwarding
headers with the socket address. Behind its managed Cloudflare Tunnel or Tailscale
Funnel, where every request arrives from loopback, it uses the client address that
tunnel forwards: `CF-Connecting-IP` from Cloudflare, `X-Forwarded-For` from Tailscale.

A successful D1 authentication records only a bounded, 60-second credential-hash
hint in the isolate. Subsequent ordinary requests use a separate local budget
of 6,000 per minute per credential so vault bootstrap can proceed. Every request
still checks token validity, expiry and authorization against D1; an authentication
failure removes the hint. This is not an authentication cache. Coordinator routes
forward a hinted credential, which authenticates under the coordinator lock, and
uploads forward it to a transfer object, which authenticates it after queuing. Any
other credential authenticates at the edge first, so an invalid one never waits for
that lock or queue, and then again inside.

Action/day limits remain enforced after authentication. Each route's per-minute
action limit is its `rateLimit` in `routes/policy.ts`. Daily action budgets belong
to each credential (1,000 per UTC day for management and push actions, 500 for
Reading), so one token cannot exhaust another's. Enrollment exchanges share one
1,000-per-day pool, because each grant is single-use. A per-minute denial returns
429 with `Retry-After: 60`; a denial because the daily budget is spent returns 429
with a `Retry-After` that counts the seconds to 00:00 UTC (`admission/rate-limit.ts`).

When a Cloudflare Free plan account has used its daily D1 read or write allowance,
any route that reaches D1 returns 429 with `code: "d1_daily_limit"`. It sends no
Retry-After: the allowance resets at 00:00 UTC, beyond the clients' retry delays.

Without the edge binding, the restrictive budget also runs in bounded isolate
memory keyed by the original D1 binding, before request-local metering wrappers.
The authenticated sync budget and fallback are per isolate, not global quotas;
Cloudflare's [edge limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are also location-scoped abuse protection, not exact
account-wide billing caps. Keep Cloudflare account usage alerts enabled.
Ordinary Reading requests authenticate and authorize before entering the shared
coordinator; list and item reads enter it only to rebuild the index or list a page. Public one-use Reading grants enter it after admission because
redemption and capture must be serialized together.

## Endpoints

The scope column lists the token scopes `routes/policy.ts` declares for each route. `vault` is an Obsidian device token. `reminders` is a web app token; it is also the Reading library credential once a Reading folder is configured. `reading_capture` is a Shortcut capture token. Grant routes take a one-use grant instead of a bearer, and public routes take no credential. Routes marked plaintext only return 428 in an encrypted vault, where clients use the encrypted routes instead.

### Sync endpoints

All sync routes require `vault`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sync/check?since=<seq>` | Lightweight check: are there changes since this sequence? |
| `GET` | `/sync/changes?since=<seq>` | Paginated changelog entries (5000 per page, 2000 in an encrypted vault) |
| `GET` | `/sync/manifest?limit=<n>&after=<path>&snapshotSeq=<seq>` | Stable, cursor-paginated remote manifest |
| `POST` | `/sync/metadata` | Fetch current metadata for up to 50 selected paths (self-hosted: 100) |
| `PUT` | `/sync/upload?path=<path>` | Upload one conditionally-versioned file (binary body, max 25 MB unless the server advertises more) |
| `POST` | `/sync/upload-session?action=begin\|complete` | Self-hosted: begin or complete a chunked upload of a plaintext attachment over 25 MB (`chunked-uploads-v1`) |
| `PUT` | `/sync/upload-session?part=<n>` | Self-hosted: send one part of a chunked upload |
| `GET` | `/sync/download?path=<path>` | Download single file (streaming from R2; on a self-hosted server, `Range: bytes=a-b` returns one part) |
| `POST` | `/sync/batch-upload` | Batch upload `{ files: [...] }` (max 32 files, 10 MiB total; self-hosted: 100 files, 32 MiB) |
| `POST` | `/sync/batch-download` | Batch download `{ paths: [...] }` (max 50 paths and 8 MB decoded; self-hosted: 100 paths, 32 MiB) |
| `POST` | `/sync/batch-delete` | Conditional batch delete `{ files: [...] }` (max 32 files; self-hosted: 100) |
| `POST` | `/sync/batch-move` | Plaintext only: move up to 32 files to new paths, keeping their stored bytes `{ moves: [...] }` |
| `POST` | `/sync/import` | Start or resume the initial import of a never-populated server; returns `{ import }` or `{ import: null }` |
| `POST` | `/sync/import/upload` | Upload up to 32 base64 files into the open initial import |
| `PUT` | `/sync/import/upload?path=<path>` | Upload one binary file into the open initial import |
| `POST` | `/sync/import/prune` | Remove up to 50 imported files that were deleted locally while the import was paused |
| `POST` | `/sync/import/complete` | Verify the imported inventory page by page and seal it on the final page |
| `POST` | `/sync/import/readiness` | Poll and acknowledge reminder setup after the initial import |
| `GET` | `/sync/checkpoints?all=1` | List unexpired shared checkpoints, newest first (100 without `all`) |
| `POST` | `/sync/checkpoints` | Save the current server state as a checkpoint; an unchanged state reuses its checkpoint |
| `GET` | `/sync/checkpoint?id=<id>` | Rebuild and stream the complete inventory of a live shared checkpoint |
| `GET` | `/sync/checkpoint-file?id=<id>&path=<path>&revision=<revision>` | Stream an exact current/retained file revision while the checkpoint remains live. Replacing a revision that was live at the latest checkpoint always keeps it; a revision that is no longer kept returns 410 with `code: "version_unavailable"` |
| `GET` | `/sync/versions?path=<path>&search=<text>&cursor=<cursor>` | Page through unexpired recoverable file versions (100 per page) |
| `GET` | `/sync/version-preview?path=<path>&storageKey=<key>` | Read one retained version for preview |
| `POST` | `/sync/restore-version` | Restore a retained version with expected-hash compare-and-swap |

### Account, settings and server endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/health` | `vault`, `reminders` | Health check, returns `{ status, timestamp }` |
| `GET` | `/diagnostics` | `vault` | Backend counts, delivery failures, queue pressure, and scheduled-maintenance state |
| `GET` | `/server/host-status` | `vault` | A self-hosted server's own report: `{ host }` with install type, start time, last backup, daily backup state, public access and free disk space; `null` on Cloudflare |
| `POST` | `/links/title` | `vault`, `reminders` | Page-title lookup `{ url }`, returns `{ title: string \| null }` |
| `GET` | `/auth/tokens` | `vault` | List all registered auth tokens |
| `DELETE` | `/auth/tokens` | `vault` | Revoke an auth token `{ id }` |
| `DELETE` | `/auth/session` | `vault`, `reminders` | Atomically revoke the current bearer token and its owned push subscriptions |
| `GET` | `/settings` | `vault` | Get shared settings |
| `PUT` | `/settings` | `vault` | Store shared settings |
| `GET` | `/features` | `vault`, `reminders` | Read the shared feature policy |
| `POST` | `/features` | `vault` | Change the shared feature policy |
| `GET`, `POST` | `/history-retention` | `vault` | Read or change how long file history is kept; a self-hosted server also returns the `options` it offers, adding 180 and 365 days |

### Reminders and notifications endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/reminders/list?folderPath=<path>` | `vault`, `reminders` | List reminders and projects from synced Markdown files (plaintext only) |
| `POST` | `/reminders/create` | `vault`, `reminders` | Create a reminder in a project Markdown file (plaintext only) |
| `POST` | `/reminders/update` | `vault`, `reminders` | Update or move a reminder (plaintext only) |
| `POST` | `/reminders/set-completed` | `vault`, `reminders` | Toggle reminder completion (plaintext only) |
| `DELETE` | `/reminders/delete` | `vault`, `reminders` | Delete a reminder from Markdown (plaintext only) |
| `POST` | `/reminders/reorder` | `vault`, `reminders` | Reorder reminders inside a project file (plaintext only) |
| `GET`, `POST`, `PUT` | `/reminders/notification-policy` | `vault` | Read, initialize, or explicitly update shared notification policy |
| `POST` | `/notifications/reminders-enrollment-token` | `vault` | Create one-time browser and install tokens for a reminders web app link |
| `POST` | `/notifications/subscribe` | `vault`, `reminders` | Save a push subscription |
| `DELETE` | `/notifications/subscribe` | `vault`, `reminders` | Remove a push subscription |
| `GET` | `/notifications/subscriptions` | `vault` | List push subscriptions |
| `POST` | `/notifications/test` | `vault` | Send a test push notification |

### Reading endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/reading/policy` | `vault` | Read the Reading folder, extraction state and generation |
| `POST` | `/reading/policy` | `vault` | Set the Reading folder and extraction state `{ folderPath, enabled, revision }` |
| `GET` | `/reading/session` | `vault`, `reminders` | Return the credential's `{ id, folderPath, generation, expiresAt, day }` for the Reading app |
| `GET` | `/reading/items?section=&cursor=` | `vault`, `reminders` | One page of the library, or encrypted cards |
| `GET` | `/reading/changes?since=` | `vault`, `reminders` | What changed in the library since a revision |
| `GET` | `/reading/tags` | `vault`, `reminders` | List library tags, optionally for one section with counts |
| `GET` | `/reading/taken?path=…` | `vault`, `reminders` | Which of up to 20 server paths are taken, for naming encrypted notes (encrypted vaults only) |
| `GET` | `/reading/item` | `vault`, `reminders` | Read one indexed note or queued capture (plaintext only) |
| `GET` | `/reading/file?path=…` | `vault`, `reminders` | Read one image file in the Reading folder (plaintext only) |
| `POST` | `/reading/capture` | `vault`, `reminders`, `reading_capture` | Save a link `{ url, title?, fetchArticle?, operationId }` (plaintext only) |
| `POST` | `/reading/update` | `vault`, `reminders` | Change a note's status, favorite, tags or highlights against its `before` values (plaintext only) |
| `POST` | `/reading/retry` | `vault`, `reminders` | Retry article extraction for a note (plaintext only) |
| `POST` | `/reading/delete` | `vault`, `reminders` | Delete a note and its images (plaintext only) |
| `POST` | `/reading/shortcut-pairing` | `vault`, `reminders` | Issue a Save to Crate pairing code |
| `POST` | `/reading/shortcut/v1/prepare` | `reading_capture` | Prepare a Shortcut save and return its launch URL |
| `POST` | `/reading/shortcut/v1/exchange` | Grant | Redeem a Shortcut pairing code for a capture token |
| `POST` | `/reading/handoff` | Grant | Redeem a prepared save through `X-Crate-Capture` (plaintext only) |

### Encryption endpoints

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/encryption` | `vault`, `reminders` | Public encryption configuration and encrypted recovery bundle |
| `POST` | `/encryption/metadata` | `vault` | Descriptors for up to 1,000 listed revisions |
| `GET` | `/encryption/deletion-precondition?path=…&revision=…` | `vault` | Resolve an accepted encrypted deletion |
| `GET`, `POST` | `/encryption/reset?id=<id>` | `vault` | Start, advance or read a destructive encryption reset |
| `GET`, `POST` | `/encryption/pairing` | `vault`, `reminders` | Encrypted web app approval |
| `GET` | `/reminders/encrypted-files` | `vault`, `reminders` | Encrypted reminder folder inventory or delta |
| `GET` | `/reminders/encrypted-file` | `vault`, `reminders` | One encrypted reminder note at a revision |
| `POST` | `/reminders/encrypted-files/download` | `vault`, `reminders` | Up to 50 encrypted reminder notes |
| `POST` | `/reminders/encrypted-commit` | `vault`, `reminders` | Commit encrypted reminder note changes |
| `GET` | `/reading/encryption` | `vault`, `reminders` | Encryption configuration after validating Reading enrollment |
| `GET` | `/reading/encrypted-files` | `vault`, `reminders` | Encrypted Reading folder inventory or delta |
| `GET` | `/reading/encrypted-file` | `vault`, `reminders` | One encrypted Reading file at a revision |
| `POST` | `/reading/encrypted-files/download` | `vault`, `reminders` | Up to 50 encrypted Reading notes |
| `POST` | `/reading/encrypted-commit` | `vault`, `reminders` | Commit encrypted Reading note changes |
| `POST` | `/reading/encrypted-extract` | `vault`, `reminders` | Download an article for the encrypted web app without storing it |

### Public and PWA endpoints

These routes are answered by `routes/public.ts` before authentication.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/crate` | Public service, version, protocol range, capability metadata, and `limits.maxFileBytes` |
| `GET` | `/` | Returns the same metadata as `/.well-known/crate` |
| `GET` | `/notifications` | Serves the reminders PWA HTML |
| `GET` | `/notifications/app.js` | Serves the bundled PWA client |
| `GET` | `/notifications/assets/<file>` | Serves a PWA client asset |
| `GET` | `/notifications/sw.js` | Serves the PWA service worker |
| `GET` | `/notifications/manifest.json` | Serves the PWA manifest |
| `GET` | `/notifications/version.json` | Returns the current PWA asset version |
| `GET` | `/notifications/crate-icon-192.png`, `/notifications/crate-icon-512.png`, `/notifications/crate-mark-256.png`, `/notifications/apple-touch-icon-180.png` | Serve the app icons and brand mark |
| `GET` | `/notifications/open-obsidian`, `/notifications/open-obsidian.js` | Serve the browser handoff page for opening Obsidian and its script |
| `GET` | `/notifications/pair`, `/notifications/pair.js` | Serve the device pairing page, which hands the code in its fragment to Obsidian, and its script |
| `GET` | `/notifications/save-reading`, `/notifications/save-reading.js` | Serve the live, uncached Save to Crate page that performs the Shortcut handoff, and its script |
| `POST` | `/notifications/share/reading` | Web share target fallback: before a service worker controls the PWA, returns a page that keeps the shared form (up to 16 KiB) and stores it locally |
| `GET` | `/notifications/vapid-public-key` | Returns the Web Push VAPID public key |
| `POST` | `/notifications/reminders-exchange` | Exchanges a one-time web enrollment token for a PWA auth token |
| `POST` | `/auth/device-pairing` | Redeems a one-use device pairing code for a vault device token |
| `GET` | `/shortcuts/development/`, `/shortcuts/development/Save%20to%20Crate.shortcut` | Development builds only: the Shortcut signed from the working tree; other builds return 404 |

## Sync requests and responses

### PUT /sync/upload

- Query: `?path=<url-encoded-path>`
- Headers: `X-File-Hash`, `X-File-Size`, `X-Crate-Expected-Hash`, `X-Crate-Upload-Operation`, `Content-Type`
- `X-Crate-Expected-Hash` is the 64-character remote hash observed while planning, or `absent` for a new path
- Body: raw binary, consumed incrementally with a hard cap at the server's file limit (25 MB by default, `limits.maxFileBytes` in `/.well-known/crate`); oversized declared or chunked requests stop before the remainder is buffered. A declared size over the limit answers `413` with code `file_too_large`, so clients settle a pending upload instead of retrying it
- Response: `{ success, path, hash, revision }`
- A stale expected hash returns `409` with `{ success: false, path, error, code: "version_conflict", currentHash }` and does not replace the committed object
- Persist the exact request and its server-dated operation ID before dispatch. Replaying it returns the original success or rejected precondition, including after deletion. Missing IDs receive 428; mismatched payloads receive 409 `operation_mismatch`; expired IDs without receipts receive 410 `operation_expired`. See [upload recovery](upload-recovery.md).

### GET /sync/download

- Query: `?path=<url-encoded-path>`
- Response headers: `Content-Type`, `Content-Length`, `X-File-Hash`, `X-Crate-Revision`
- Body: raw binary (streamed from R2)
- Self-hosted only: `Range: bytes=<start>-<end>` returns 206 with `Content-Range`; an end past the file is cut to it, and an empty file is returned whole. Clients fetch files over 25 MB in 32 MiB ranges and reject a range from another revision. A bad range answers 416.

### Chunked uploads (`/sync/upload-session`)

Self-hosted only. Plaintext attachments over 25 MB on a server that advertises `chunked-uploads-v1` (a raised limit) travel in parts, so no request carries more than 32 MiB (`UPLOAD_PART_BYTES`). Every step sends the upload's `X-Crate-Upload-Operation`; begin and complete carry the same `{ path, hash, size, contentType, expectedHash }`, which form the operation's request hash exactly as for `PUT /sync/upload`. A stored receipt answers either step of a retry. Encrypted vaults and Markdown notes are refused: they upload in one request, up to 128 MiB.

1. `POST ?action=begin` creates an R2 multipart upload under a fresh managed key and an upload lease, or resumes the operation's session. Returns `{ session: { partBytes } }`.
2. `PUT ?part=<n>` (1-based) sends exactly `partBytes`, or the remainder for the last part, and returns `{ etag }`. Resending a part replaces it.
3. `POST ?action=complete` with `parts: [{ partNumber, etag }]` combines the parts, hashes the stored object as a stream, deletes it on a size or hash mismatch (400), then publishes it with the same receipt, changelog and lease rules as a single upload.

Sessions live in R2 under `__crate__/upload-sessions/<operation>.json`. Maintenance aborts sessions older than the 24-hour lease; lease cleanup reclaims the key.

### POST /sync/batch-upload

```json
{
  "files": [
    {
      "operationId": "e1_<eight-digit-server-day>_<uuid>",
      "path": "notes/file.md",
      "content": "<base64>",
      "hash": "sha256...",
      "size": 1024,
      "contentType": "text/markdown",
      "expectedHash": "sha256..."
    }
  ]
}
```

Worker validates: max 32 files, total decoded content <= 10 MiB. Each file requires its own stable `operationId` with the same receipt and expiry rules as a single upload. Staging reads every receipt in one D1 query and each file commits in its own coordinator invocation, so a full batch stays within Workers Free D1 query limits even on stale-write cleanup paths.

Response: `{ success, results: [{ path, success, hash?, revision?, error?, code?, status?, currentHash? }] }`. A stale per-file write uses `code: "version_conflict"`, `status: 409`, and the current remote hash; storage failures use `code: "storage"` and `status: 503`.

### POST /sync/batch-download

Request: `{ paths: ["notes/file.md", ...] }` (max 50, no duplicates)

Response: `{ files: [{ path, content, hash, size, contentType, revision, error? }] }`

Content is base64-encoded. The Worker rejects a batch before reading R2 if D1 metadata shows that it exceeds 8 MB. The client batches only files smaller than 1 MB, validates the exact response path set, size, and SHA-256 hash, and falls back to individual streaming downloads when a batch is too large or unavailable.

### POST /sync/batch-delete

`{ files: [{ path, expectedHash, expectedRevision }, ...] }` (max 32, `BATCH_DELETE_MAX_FILES` in `src/protocol/sync-limits.ts`) -> `{ success, deleted: [...], errors?: [{ path, error, code?, status?, currentHash? }] }`

### POST /sync/batch-move

`{ moves: [{ from, to, expectedHash, expectedRevision }, ...] }` (max 32, `BATCH_MOVE_MAX_FILES`) -> `{ success, results: [{ from, to, success, hash?, revision?, error?, code?, status?, currentHash? }] }`, one result per move in request order.

A move gives the file's row its new path and keeps its storage key, revision and `live_from_seq`: nothing is uploaded, no copy is retained and the file count is unchanged. The changelog records a delete of `from` and a put of `to` with the same hash, the shape receivers already apply as a local move. The move also writes a `file_moves` row (stored key, sequence, old path), so checkpoints saved before the move list the copy at its old path, and `GET /sync/checkpoint-file` serves it there. Maintenance removes the row once no kept checkpoint precedes the move, at most 1,000 rows on the first pass of each episode (`FILE_MOVE_PRUNE_BATCH`), since finding them scans the log.

The route runs under the coordinator lock and is refused in an encrypted vault (428), whose paths are bound into ciphertext. Each move commits only if `from` still has the expected hash and revision. These cases fail with `409` and change nothing:

- `version_conflict`: the source changed, or the destination exists.
- `move_unsupported`, for the client to upload and delete instead:
  - either path is a reminder or Reading note, whose projection or index needs the bytes;
  - the destination's namespace is taken;
  - an upload lease or cleanup intent still names the key.
- `validation` (`400`): case or Unicode-only renames, and paths named twice in one batch.

A retry after a lost response finds the source gone and the destination holding the expected revision, and returns success without writing. Keys are never reused, so that revision proves the move committed. A move writes about four D1 rows per file and one more when its log row is pruned (`sync/batch-move.integration.ts` measures 129 and 32 for 32 files, against 292 and 33 for the same renames as uploads and deletes and their later expiry).

Uploads compare the observed D1 content hash. Deletes also compare the original opaque revision, rejecting same-content recreations. Reminder edits compare a semantic revision captured by the client, then apply file-level preconditions. D1 commits the file row, changelog, retention, operation receipt, and notification projection intent atomically; stale writers receive `409`.

### GET /sync/check

Query: `?since=<seq>`

Response: `{ lastSeq, hasChanges, cursorExpired?, storageId }`

`cursorExpired` is true when `since` points to a pruned changelog region, signaling the client should fall back to full sync.

`storageId` is the database's random storage identity (32 lowercase hex characters), kept in `maintenance_state` and created by the first check that finds none. A new server, or a restored server, reports a new one.

### GET /sync/changes

Query: `?since=<seq>`

Response: `{ changes: [...], lastSeq, hasMore, cursorExpired? }`

Paginated at 5000 entries, or 2000 in an encrypted vault, whose entries carry descriptors. Client loops until `hasMore` is false.

### GET /sync/manifest

The plugin requests pages of at most 2,000 entries. The first page establishes `snapshotSeq`; later pages reuse it, and the plugin replays the changelog after that sequence before accepting the manifest.

Response:
```json
{
  "version": 1,
  "files": {
    "path": { "hash": "...", "size": 1024, "modified": "datetime", "revision": "opaque-key" }
  },
  "lastSeq": 42,
  "snapshotSeq": 42,
  "hasMore": false,
  "nextCursor": "optional/last/path.md"
}
```

### POST /sync/metadata

Request: `{ paths: ["notes/file.md", ...] }` (max 50, no duplicates)

Response: `{ files: { "notes/file.md": { hash, size, modified } } }`. Missing paths are omitted. Queue conflict recovery uses this endpoint so a version race does not require loading the entire remote manifest.

### Sync read validation

Authoritative manifest, targeted metadata and changelog reads are validated at runtime, including required maps, version and cursor framing, path/hash/size/date fields and ordering. Missing or malformed state aborts synchronization before file changes. A valid empty map remains an explicit empty state. Known historical changelog entries may lack revisions; current file metadata must include one.

### Initial import

Only a server with no files, changelog, history or upload receipts can enter import mode: a plaintext vault before its first sync, or an encrypted one after the reset that turned encryption on. `POST /sync/import` starts the import, or returns the open one, as `{ import: { token, state } }`; repeated starts are read-only. Upload routes take the import token in `X-Crate-Import` and run in a transfer object: `POST /sync/import/upload` takes up to 32 base64 files within the batch upload limit, and `PUT /sync/import/upload?path=<path>` takes one binary file within the single-file limit. `POST /sync/import/prune` takes `{ token, files: [{ path, hash }] }` (up to 50) and removes those files. `POST /sync/import/complete` verifies the inventory page by page and seals it; see [initial import readiness](protocol.md#initial-import-readiness) and [the sync pipeline](sync-pipeline.md) for the client flow.

### POST /sync/import/readiness

Request: `{ token }`, using the completed initial-import token. Returns `{ ready }`,
optional `{ progress: { scanning, remainingFiles, remainingSchedules } }` (each count
stops at 1,000 so a poll reads a bounded number of rows), and an
`error` string when reminder setup needs attention. Source failures additionally
return `issues: [{ path, message, code?, line? }]` (up to 20 notes) and `moreIssues`.
These fields are additive; responses without source failures contain only `error`.
Paths identify vault notes; malformed description messages include a one-based
source line, also returned as `line`. `code` is one of the
[stable issue codes](protocol.md#initial-import-readiness) when the Worker recognizes
the failure. Repairing a note and syncing again resumes setup without repeating
completed file uploads. See [initial import readiness](protocol.md#initial-import-readiness).

### Retained file history pagination

`GET /sync/versions` returns `{ versions, hasMore, nextCursor? }`. `path` is an optional exact filename and `search` is an optional literal substring (ASCII case insensitive), including folder names. Results for one `path` sort by `(created_at, storage_key)` descending; without `path` they sort by when each copy was kept, descending, which is the same order except that a deleted file's copy sorts by its deletion. Each version's `expires_at` is when it was kept plus the current retention. `nextCursor` continues that ordering without offset shifts when newer rows arrive. A `search` reads at most 2,000 versions per request: a window with fewer matches than a page returns what it found, possibly none, with `hasMore` and a cursor after the window. Reuse the same search and path with the opaque cursor; a changed query or malformed cursor receives HTTP 400. Expired versions are omitted from every page. Replaced copies are coalesced at commit time: one is retained only if it was live for at least 10 minutes, was live when the latest shared checkpoint was created, or its path has no version retained in the last 10 minutes (60 minutes for files of 1 MiB or more); other replaced copies are queued for reference-aware cleanup in the same transaction. Deleted copies and the copy replaced by `POST /sync/restore-version` are always retained. See [remote recovery](sync-pipeline.md#error-recovery). The plugin’s **File history** view requests pages for one exact file path; search remains available in the API. In an encrypted vault, paths are keyed tags, so `path` names the file's server path and clients never send `search`. Restores retain their existing conditional-write and integrity checks.

### GET /sync/version-preview

Vault-authenticated, read-only access to one unexpired retained version. Query parameters `path` and `storageKey` must identify the same retained record. Returns integrity-verified binary content with `X-File-Hash`, `Content-Length`, and `Cache-Control: private, no-store`. Missing, expired, or mismatched entries return 404; versions larger than 256 KB return 413; missing or corrupt content returns 503. Arbitrary R2 keys are never served. No file, changelog, or retention state is modified.

File history decodes text locally and compares the saved version with a snapshot of the current local file. Binary/large files can still be restored without a preview.

The **History** view groups retained update/deletion versions by day, rather than presenting whole-vault snapshots or inferring restore events. **Files** reads the existing paginated manifest and replays subsequent changes to list current synced files, including those with no retained versions. Its current preview reads targeted metadata and downloads the remote copy only for text files up to 256 KB, verifying the size, hash and revision before display. It never substitutes unsynced local contents. The file list renders in batches of 200; **Refresh files** refreshes the remote inventory. Historical comparisons continue to use the local snapshot and never modify the sync manifest or queue.

### Shared history checkpoints

The server advertises `shared-history-checkpoints-v1`. A checkpoint is one D1 row naming a
changelog sequence; commits save one before their changes once the latest is ten minutes
old, and `POST /sync/checkpoints` saves the current state. Reads rebuild the inventory
from `files` and the versions kept since the checkpoint, streaming pages of 10,000 rows,
so the Worker never holds the whole document. A copy a server move took elsewhere since the
checkpoint is listed at its path then (`file_moves`). Expired IDs receive 410, and an unfinished
initial import or empty vault receives 409 from `POST`. All routes require vault
credentials and return private, non-cacheable responses. See
[the sync pipeline](sync-pipeline.md#returning-to-a-history-checkpoint) for retention,
thinning and restore validation.

### Changelog pruning

Activity schedules one cleanup alarm 24 hours later, which deletes entries older than 30 days (`CHANGELOG_RETENTION_DAYS`). Each pass deletes at most 5,000 entries from the start of the changelog and reads only those first 5,000 by sequence, so a long expired backlog costs the same per pass; the newest entry is always kept. Cleanup runs at most ten passes per activity-triggered episode. It can continue an advancing backlog or wait for a pending upload deadline; unconfirmed upload cleanup pauses after eight attempts. Expired retained versions are deleted 500 per pass, oldest first: the R2 objects, then their rows, so the expired row is the cleanup intent until both are gone. Copies that were never kept drain from the cleanup queue at the same rate. While either advances, passes continue every five seconds beyond the ten-pass limit, up to 200 passes (100,000 objects) per episode. Cleanup writes at most about 20,000 D1 rows per UTC day (`MAINTENANCE_DAILY_WRITE_BUDGET`), a fifth of the Free plan's daily allowance, with no cap on a self-hosted server; a backlog past it, or a D1 daily-limit error, resumes after 00:00 UTC. Failures are recorded for diagnostics.

When a client's `since` cursor points to pruned entries, the `cursorExpired` flag is returned so the plugin falls back to full sync.

### Path sanitization

`sanitizePath()` rejects null bytes, traversal, empty segments, backslashes, Windows-reserved names and characters, and trailing dots/spaces. A normalized unique D1 key additionally prevents case-insensitive and Unicode-normalizing collisions.

## Account and settings

### Page titles

`POST /links/title` is a read operation and does not require mutation protocol negotiation. Pasting a standalone web URL automatically uses it. It accepts public HTTP(S) DNS names on standard ports, excludes credentials and fragments, validates each redirect (maximum three), and reads at most 256 KiB of HTML within five seconds. It returns the HTML title as text with entities retained; clients decode entities as text. Missing titles, unsupported responses, and network failures return `title: null`. Invalid destinations return 400; the edge request limiter can return 429. No page scripts execute, no caller credentials are forwarded, and responses are not cached.

Self-hosted title requests use the native public-network binding, including every
redirect. A rejected connection returns `title: null` without retrying through
another transport. The local server also forwards global Worker fetches through
that binding; Miniflare's default outbound service is not the security boundary.
Hosted Workers retain `global_fetch_strictly_public`. URL validation alone does
not protect against a public-looking hostname resolving to a private address.

### DELETE /auth/tokens

Revoke a token by its ID, with the Shortcut capture credentials it paired.

Request: `{ id: "<uuid>" }`

Response: `{ success: true }`

### GET /auth/tokens

List all registered tokens (does not expose hashes). The current token is marked with `is_current`. Shortcut capture credentials have `device_id: null`.

Response: `{ tokens: [{ id, device_id, device_name, platform, created_at, last_seen_at, is_current }] }`

### DELETE /auth/session

Revokes the bearer token used for the request and the Shortcut capture credentials it paired. Crate calls this before clearing its local credential when the user disconnects the current device.

Response: `{ success: true }`

### GET /settings

Returns shared plugin preferences, stored in D1 with the server state (`server_state.settings`). Used by second devices to inherit settings during setup. In an encrypted vault the stored value is the encrypted settings record.

Response: `{ settings: { ignorePatterns, syncInterval, pushEnabled }, settingsVersion }`, or `{ settings: null, settingsVersion: null }` if none are stored.

Plugins use the device-local `automaticSync` preference for automatic triggers;
that preference is not part of this shared-settings contract.

### PUT /settings

Stores shared plugin preferences. The write replaces `settingsVersion` only if it still equals `expectedVersion`, and only while the vault's encryption state is the one the request was validated against.

Request: `{ settings: { ignorePatterns: [...], syncInterval: 300, pushEnabled: false }, expectedVersion }`

Response: `{ success: true, settingsVersion }`. A stale version returns `409` instead of overwriting another device's edit.

`expectedVersion: null` stores settings only when none exist. Connecting a Cloudflare device uses it to seed a fresh deployment with that device's preferences. A connecting device applies settings it reads and never writes over settings it could not read, including an encrypted vault's.

Closing Crate settings writes only the shared settings changed on this device since it last synced them. It merges those changes onto the server's settings as it last read or wrote them, reading first when it has not, and writes against that version. A newer version, or a setting both devices changed, loads the server's settings with a short notice instead of overwriting them. The plugin saves the server's settings as it last reconciled them in its plugin data (`sharedSettingsBase`, cleared when the server address changes), so a change that could not be saved is still written on a later close after a restart. The periodic refresh loads other devices' changes, keeps this device's unsaved ones, and waits while Crate settings are open.

### Shared feature policy

The server advertises `shared-features-v1`. `GET /features` returns
`{ reading: boolean, reminders: boolean, revision: string | null, readingImages?: "remote" }`. Vault,
Reading-library and reminders credentials can read; only vault credentials can
POST `{ feature: "reading" | "reminders", enabled: boolean, revision }` or
`{ readingImages: "save" | "remote", revision }`. A missing `readingImages` means `save`, which is
never stored, so older servers and clients agree on the default. Capture-only
credentials cannot access this policy. Stale writes return 409. Writes are
serialized through the projection coordinator, and a successful write wakes
background work; reads return the last committed policy without entering the
coordinator. Both features default on until explicitly changed.
`src/protocol/feature-policy.ts` defines and validates this response for the
Worker, plugin and PWA.

Paused feature APIs return 423 with `code: feature_paused`; sync and feature-policy
access remain available. Reading policy and capture operations cannot override
the shared pause. Push opt-in remains unchanged by reminder pause/resume. Queued
operations, saved content, library identity, and scoped credentials are retained.

### History retention

`GET /history-retention` returns `{ days }`, one of 7, 14, 30, 60 or 90, or also 180 or 365 on a self-hosted server (30 until changed).
Only vault credentials can read it or POST `{ days }` to change it; other values return
400. Writes run in the coordinator and store only the value in `server_state`; kept file
versions expire by the current value, so a change rewrites no history rows. See [history retention](sync-pipeline.md#history-retention).
`src/protocol/history-retention.ts` defines the values for the Worker and plugin.

## Reminders

Reminder handlers live in `src/cloudflare/worker/reminders/handlers/`. Mutations apply the shared Markdown command described in the [architecture](architecture.md#shared-reminder-rules).

### Reminder mutation responses

Create, update and set-completed respond with the saved reminder as `{ success: true, reminder }`. `reminder` has the fields of a listed reminder: `revision`, `id`, `content`, optional `description`, `dueDate` and `dueDatetime`, `priority`, `completed`, optional `completedAt`, `project`, optional `recurrence`, `filePath` and `lineNumber`. A retried operation returns its original response.

Mutation failures respond with `{ error }` and, where listed, a stable `code`. Nothing is written on any failure.

- `400` `invalid_reminder_input`, with the rejected `field`: invalid reminder fields. This includes a title containing Crate's `<!-- crate-id:`, `<!-- crate-rule:` or `<!-- crate-done:` comments, and a title that would not read back as the saved reminder, such as an undated title consisting only of a date or priority marker, or a date-only reminder whose title ends in a time that would join the written date (`Lunch at 1pm`). A date-only due is written as `Oct 30, 2026`, or as `2026-10-30` when only that form reads back. Clients should treat it as a definite rejection that needs a corrected request, not a retry.
- `400` without a code: route checks such as a missing `folderPath`, `id` or `filePath`, an invalid project on create, an invalid repeat, or unreadable `orderedIds` or `expectedOrder`.
- `404`: the reminder or project note no longer exists.
- `409` `version_conflict` for a stale `expectedRevision`; `reminder_markdown_context` for duplicate identities or Markdown that cannot be edited safely; `reminder_order_conflict` for a reorder the note cannot apply safely, such as one that includes completed or nested reminders; `duplicate_reminder_identity` when the identity occurs more than once in the reminders folder; `operation_mismatch` when an operation ID is reused for different changes. A create whose identity already exists, a changed project order and a concurrent note write return `409` without a code.
- `410` `operation_expired`: the operation ID is outside the retry window. See [retention](reminder-retention.md).
- `413`: a note the edit reads or writes is larger than 1 MiB. This applies to deletes and reorders too, because lists report such notes as issues instead of returning their reminders.
- `428`: a missing `operationId` or `expectedOrder`, or `revision_required` for a missing or malformed `expectedRevision`.

### GET /reminders/list

Query: `?folderPath=<reminders-folder>`

Reads synced Markdown reminder files from the configured folder and returns web-ready reminder records plus known projects. Conditional requests use an ETag that pairs a vault change token (changelog sequence, import and reset generations, folder and parser version) with the folder's file-metadata revision. An unchanged token answers 304 without listing the folder; an unchanged folder revision answers 304 with a refreshed ETag. On an ETag miss, D1-cached parses are reused by file hash, so only new or changed Markdown objects are fetched from R2 and parsed. Notification projection stores the parse of each committed plaintext note in the same cache, in its existing D1 batch, so a list after a sync from Obsidian rarely reads R2. The change state read also returns the changelog bounds a delta needs, and cache rows are read alongside the folder listing or the changed notes' rows.

Cold indexes are warmed in batches of at most 20 files and 2 MiB per request. While more files remain, the endpoint responds with `202` and `{ warming: true, remainingFiles }`; clients should repeat the request until it returns `200`. The web app repeats it after 200 ms while `remainingFiles` falls and waits for `Retry-After` when it does not, so the number of requests is unchanged. When more than one further batch remains, the Worker saves a warming cursor in `maintenance_state`, and each later warming request reads only the next unindexed notes after it instead of listing the folder and its cache rows again; with one batch or less left, the next request lists the folder once, indexes the rest and answers. Individual reminder Markdown files must be no larger than 1 MiB.

Response: `{ reminders: [...], projects: [...], issues: [...] }`. Each reminder includes its semantic `revision`. Oversized notes or cache records yield per-file issues while healthy reminders remain usable. A duplicate identity hides every copy, and each note holding one lists a conflict issue unless it has its own. Warming responses include `totalFiles` and `Retry-After: 1`.

Full responses and 304s include `X-Crate-Delta-Base`: a changelog position bound to the folder, parser version, initial import and reset generation. A client holding that revision may send it as `since`, with one `conflict=<path>` for each note its revision lists with a duplicate identity issue (at most 20, `MAX_DELTA_CONFLICT_NOTES`, adding at most 4,096 encoded characters, `MAX_DELTA_CONFLICT_QUERY_CHARS`): another note's change can resolve their duplicate, which only the client's revision shows. When the changelog can still prove every change since then, the response is `{ delta: true, changedPaths: [...], reminders: [...], changedProjects: [...], issues: [...] }`: the client replaces all reminders and issues from `changedPaths` with `reminders` and `issues` and keeps the rest. `changedPaths` holds the written, renamed or deleted notes, the named conflict notes, and the unchanged notes whose duplicates appeared, remain or resolved with them. Each note is one project, so the client also removes the projects of every changed path from its list and adds `changedProjects`, the projects of the changed paths that still exist. A pruned or imported changelog, more than 20,000 vault changes, a different view, or more than 20 conflict notes returns the full list instead; a client with longer conflict names reads the full list.

The Worker builds a delta from the `files` rows of the changed and named notes alone, without listing the folder, when the folder is the notification folder and its one-time source scan has finished, so its cost follows the changed notes rather than the folder's size. `reminder_sources` finds the other notes holding their identities and counts each identity's copies in the folder, so these notes get the reminders and issues a full list gives them; notes with an issue of their own count no copies. Such a delta's ETag carries a revision that never equals a folder content revision, so a later full request that sends it gets a full answer rather than a revision-based `304`. Otherwise, when these notes need more parsing than one warming batch, or when an identity's copies include a note with unverified sources that the delta does not show has an issue, it rebuilds the whole folder index and answers a delta from it, adding every note that currently lists a conflict.

### POST /reminders/create

Creates a reminder in the selected project Markdown file, creating that file if needed.

Request includes a versioned `operationId`, `folderPath`, `content`, optional `project`, `description`, `priority`, `dueDate`, `dueDatetime`, `recurrence`, and required `id` equal to `operationId`. Recurrence time fields include optional `second` (0–59) and `millisecond` (0–999), alongside `hour` and `minute`. Obtain the UTC operation day from server metadata and encode it as specified in the [retry policy](reminder-retention.md).

Response: `{ success: true, reminder }`

### POST /reminders/update

Updates an existing reminder by `id`. The request requires a versioned `operationId`, `expectedRevision`, `folderPath`, and the reminder's original `filePath`, plus any mutable reminder fields: `content`, `description`, `priority`, `project`, `dueDate`, `dueDatetime`, `recurrence`.

If `project` changes, the worker commits the source and destination Markdown files atomically with hash-based compare-and-swap checks.

Response: `{ success: true, reminder }`. After a move, `reminder.filePath` and `reminder.project` name the destination.

### POST /reminders/set-completed

Request: `{ operationId, expectedRevision, folderPath, filePath, id, completed, completedAt? }`. `completedAt` is required when `completed` is `true`: the UTC ISO instant the client completed the reminder, so a retried request writes the same note.

Response: `{ success: true, reminder }`. Completing a repeating reminder with later occurrences returns the next one, still open, with no `completedAt`. A completed reminder keeps its first completion time when completed again; reopening clears it.

### DELETE /reminders/delete

Request: `{ operationId, expectedRevision, folderPath, filePath, id }`

Response: `{ success: true, id }`

### POST /reminders/reorder

Request: `{ operationId, folderPath, project, orderedIds, expectedOrder }`. `expectedOrder` is the previously observed complete project order; a concurrent reorder or changed membership returns 409.

Response: `{ success: true }`

### GET / POST / PUT /reminders/notification-policy

Vault credentials only. GET reads the shared folder, IANA timezone, all-day time, enabled state, and revision. POST initializes only an absent policy. PUT changes it explicitly with `expectedRevision`; stale changes receive 409. Starting a client never overwrites another device's policy. A PUT that changes the folder moves reminders web app credentials, their push subscriptions and unused enrollment links from the previous folder to the new one in the same transaction. A Reminders credential that then names the previous folder receives `403` with `code: "reminders_folder_changed"` and its current `folderPath`; the web app switches to that folder.

Schedules derive from committed Markdown and the shared notification policy. File commits enqueue projection intent in the same D1 transaction. The Durable Object coordinator verifies and then projects at most eight files and 2 MiB of stored source (one note when it is larger) per alarm, wakes the notification dispatcher after releasing its lock when a schedule may have changed, fences stale work with file and job revisions, and rearms while work remains. See [notification processing](notification-processing.md).

## Notifications and PWA endpoints

### GET /notifications (public)

Serves the reminders PWA HTML page. The plugin generates short-lived links with query params such as `token`, `browserToken`, `folder`, `upcomingDays`, `allDayTime`, `project`, `tab`, and `reminderId`.

The `token` query parameter is a web enrollment token, not a sync bearer token.

### GET /notifications/app.js, /sw.js, /manifest.json, /version.json, /open-obsidian (public)

Serve the PWA client bundle, service worker, manifest, version metadata, icon, and Obsidian handoff page. Versioned static assets use long-lived cache headers when a `v` query param is present.

### GET /notifications/vapid-public-key (public)

Returns the VAPID public key, lazily generated and stored in D1.

Response: `{ publicKey: "base64url-encoded-key" }`

### POST /auth/device-pairing (public)

Servers advertising `device-pairing-v1` accept codes from **Add a device**. The issuing device generates a 256-bit code and writes its SHA-256 hash with the Cloudflare D1 API as a `device_pairing` row in `grants`, replacing any earlier unredeemed code. The row holds a token ID, a ten-minute expiry that D1 sets from its own clock, the current `server_state.reset_generation`, and the deployment metadata without deletion progress. The QR code encodes `/notifications/pair#<code>`; the page reads the fragment, which browsers never send, removes it from the address bar and opens `obsidian://crate-pair?server=<origin>&code=<code>`.

Request: `{ code, tokenHash, deviceId, deviceName, platform }`. The new device generates its token locally and sends only its hash.

One D1 batch creates a `vault` token with the row's token ID only while the exact unredeemed row exists and its reset generation is current, so concurrent redemptions create one token and an encryption reset voids earlier codes. The same batch removes a previous vault token with the same `deviceId`, with its push subscriptions and the Shortcut credentials it paired, and marks the row redeemed with the token hash. Retrying with the same `tokenHash` until expiry returns the same result, so a lost response is safe; any other request returns 410. The route has a per-minute action limit and returns `Cache-Control: no-store`.

Response: `{ tokenId, deployment }`.

### POST /notifications/reminders-exchange (public)

Consumes a one-time web enrollment token and creates a per-device PWA auth token in `auth_tokens` in one transaction. A failed transaction preserves the enrollment token. Concurrent exchanges can create only one session. A successful transaction whose response is lost still consumes the token; recovery requires a new enrollment link.

Request: `{ token, deviceName?, previousAuthToken? }`

When replacing a browser session, the optional previous reminder credential revokes that session and its push subscriptions, and moves the Shortcut capture credentials it paired to the new session, in the transaction that creates the replacement. Expired reminder credentials can be replaced; vault credentials cannot be revoked through this endpoint.

Response: `{ authToken }`

### POST /notifications/reminders-enrollment-token

Vault-token authenticated. Creates separate short-lived, one-time tokens for previewing a reminders app link in the browser and activating the installed app. Reminders web app tokens cannot mint replacement sessions. Keeping the install token unused by the browser prevents iOS from launching a Home Screen app with an already-consumed credential.

Response: `{ token, browserToken, expiresAt }`, where `token` is reserved for the installed app.

### POST /notifications/subscribe

Save a push subscription owned by the authenticated session. Public requests are rejected.

Request: `{ endpoint, keys: { p256dh, auth }, deviceName? }`

Response: `{ id, notificationsEnabled }`. Registration confirms the device's push
endpoint; `notificationsEnabled` separately confirms that the shared notification
policy and Reminders feature allow scheduling for its enrolled folder. Registering
a device does not enable a paused policy. Clients refresh this status on foreground
and must not infer that delivery is enabled from device registration alone.

### DELETE /notifications/subscribe

Authenticated. Remove a push subscription.

Request: `{ id }` or `{ endpoint }`

Response: `{ success: true }`

### GET /notifications/subscriptions

Authenticated. List all push subscriptions.

Response: `{ subscriptions: [{ id, device_name, created_at, disabled_at, last_error }] }`

### POST /notifications/test

Authenticated. Send a test push to all subscriptions.

Response: `{ sent, failed, pruned, quarantined, errors }`

## Reading

Encrypted vaults use the encrypted Reading routes instead; see [Encrypted Reading](#encrypted-reading).

### Reading index and item reads

The Reading index (`reading_items`) holds one row per Reading note in the Reading
folder. Every file commit, deletion, move, restore and initial import writes that
row and its search terms in the same D1 batch as the file, from the bytes it commits, so
page and item reads never re-check `files`, and `GET /reading/item` reads the note's R2
object by the revision its row names. Update and retry responses add
`article: { item, etag, markdownHash, markdown? }`: the committed item, its `GET /reading/item`
ETag and the SHA-256 of its article body. `markdown` is the new body, present only when the
change rewrote it (a text highlight adds `==` markers). A client keeps a saved body whose hash
matches under the new ETag, and an open reader shows the committed body without downloading
the article again. A replayed receipt omits `article`.

`GET /reading/item` answers an indexed note with an `ETag` derived from the index format,
Reading folder scope, item ID, path and the file revision its row names. A matching
`If-None-Match` returns 304 before R2 is read. A queued capture has no file revision and no
ETag. The web app sends the ETag of its offline copy and keeps that copy on 304.

Page and item reads authenticate in the public Worker and read the Reading policy, index row
and (for an item) its capture queue and index rows in one D1 batch, a single snapshot, so they
do not wait behind writes in the coordinator. While the index is complete, the public Worker
answers them itself; it forwards to the coordinator a read that must continue an index
rebuild, which writes.

### Reading index rebuilds

A new Reading folder or generation, an index format change, a restore or an index
whose bytes were unavailable at commit time rebuilds the index. The rebuild keeps every
row that still names its file's current revision: each step checks 500 rows, removes those
whose file is gone or outside the folder, then reads from R2 only the notes (up to 25 and
16 MB) whose row is missing or older. A new index format removes every row first. Steps stop
for the UTC day once they have written 50,000 rows and continue the next day. Reading list
and mutation requests return 503 until that rebuild finishes or while source bytes cannot
be verified. A temporary R2 failure keeps the rebuild position and does not permit capture
deduplication against an incomplete index. Background storage-failure retries use a
30-second delay; ordinary rebuild steps continue immediately. Verified malformed or oversized notes instead produce stable
source issues until the source changes.

### Reading library pages and cards

`GET /reading/items?section=&cursor=` (library credential) returns one page of up to 50 notes,
newest `saved_at` first. `section` is `inbox`, `archived`, `favorites`, `highlights` or `all`;
`id` finds one Reading ID. An unencrypted vault also takes `q` (each word of 3 or more letters
matches the start of a title word, a shorter one a whole word), `tag` and `url`, and answers
`{ items, issues, cursor, revision }`; the first unfiltered inbox page carries the capture queue and
issues. An encrypted vault takes up to 10 hashed `term` values, every one of which must match,
and answers `{ cards, cursor, revision }`: each card's server path, revision, hash, size, sealed `card`,
`stale` and the plaintext list `fields`. The cursor is opaque. `revision` is the library
revision, `<epoch>.<changed>`: `changed` is the changelog sequence of the last commit that
changed the Reading index, and `epoch` counts changes the changelog does not list (rebuild
steps, queued captures and policy edits). Terms live in `note_terms`, one per
title word, tag and link, keyed by saved date: a search walks its rarest term (by counts capped
at 50, then 500 for its first three terms, on the first page only: the cursor keeps the choice)
newest first and stops after a page. It checks the other terms by key lookups in
`note_terms` and, unencrypted, the title words on the notes that have every term. See [Reading search](reading-search.md).

`section=highlights` pages `highlight_index` instead: highlighted notes, newest highlight first.
There `q` (or the hashed `term` values) and `tag` match each note's highlight terms: the words of
its title, highlight text and highlight notes, and its tags. A filtered page scans at most 2,000
rows, so a page can come back short or empty with a `cursor` that continues the scan. Every page,
in any section, ends before its notes or cards pass 512 KB.

`GET /reading/tags` (library credential) lists every tag for the tags view, up to 5,000. An
unencrypted vault answers `{ tags }`, lowercased, stepping through the distinct `t:` terms with
one index seek each. An encrypted vault answers `{ sealed: [{ term, name }] }` from `reading_tags`,
each name sealed by a device for its hashed term; the device opens them.

`GET /reading/tags?section=inbox|favorites|archived|highlights` lists only the tags of notes in
that section, most used first, with each tag's note count: `{ tags, counts }` unencrypted (the two
arrays align), or `{ sealed: [{ term, name, count }] }` encrypted. Each commit keeps the counts in
`reading_tag_counts` by the difference it makes, so the list reads about two rows per tag at any
library size. Another section value receives HTTP 400.

`GET /reading/changes?since=<revision>` (library credential) answers what changed since a
revision `/reading/items` returned: `{ revision, items, issues, removed }` unencrypted, or
`{ revision, cards, removed }` encrypted. It reads the changelog entries after `since`, keeps those
in the Reading folder, and lists their notes and every note sharing their Reading IDs: listed ones
as items or cards, the other changed paths in `removed`. An unchanged library answers from the
index row the request reads anyway. Another epoch, a pruned changelog or more than 500 entries
answer `{ revision, reset: true }`, and the client reads its first page again.

In an encrypted vault, each Reading note's upload carries its card as the file's public data
(`{ kind: 'reading-card', version: 1, card, terms, fields, highlighted_at, highlight_terms, tag_names }`), from Obsidian's sync and the web
app's encrypted commits alike; the server validates it and lists the note from it in the commit's
batch. An upload without a card keeps the row's last card, marked `stale`. `GET /reading/taken?path=…`
(up to 20 server paths) tells a device which names are stored, for naming new notes.

### POST /reading/delete

`POST /reading/delete` accepts `{ id, before, markdownHash, operationId }` from a library credential.
`before` holds the `reading_status`, `favorite`, `tags` and `highlights` values the client
last saw, and `markdownHash` is the lowercase SHA-256 of the article body (the `markdown` of
`GET /reading/item`) its reader showed. Any mismatch, including notes added in Obsidian since,
returns 409 `reading_conflict` and leaves the note untouched. The web app offers delete only
once the article has loaded. The encrypted web app checks the same values before it commits. The
note is deleted as an ordinary sync deletion of that exact revision, keeping a `deleted`
file version, and the receipt commits in the same batch. Then the files in its image folder
(`<Reading folder>/attachments/<Reading ID>/`) are deleted at the revisions listed, in one more
batch; a failure there leaves them in place. Synced Obsidian devices move the
note to their trash. A note still in the capture queue has no file and returns 409.

### Reading highlights

Reading updates also accept optional `highlights` alongside their `before.highlights`
precondition. Each entry contains `start`, `end` (UTF-16 offsets in sanitized reader
text), and the exact `text`. Optional `id`, `createdAt`, `prefix`, `suffix`, and
`note` fields retain identity, context, and personal annotations. Optional
`codeAnchor: true` records exact code selections that cannot contain inline markers.
`textAnchor: true` preserves other source-sensitive selections, such as partial
autolinks, HTML, escaped table cells, literal `==`, and Obsidian constructs. The
writer recalculates both flags from the selected Markdown syntax. Limits are 100
entries, 4,000 characters per excerpt or note, 16,000 excerpt characters, and 48 KiB
of serialized highlight metadata. Update requests allow 256 KiB for the before
and after values, including JSON escaping. The existing mutation receipts and
conflict checks apply.

Highlight updates insert/remove `==` delimiters in the original Markdown body;
they never serialize the article back from HTML. `highlight_format: markdown-v1`
marks notes whose inline highlights are authoritative for prose and complete
inline code and complete autolinks. Partial or multiline inline code and code-block selections use
anchored metadata, preserving the code bytes. Code anchors can authorize only
matching code characters, never unmarked prose. A rebuildable projection
collects native markers, including changes made in Obsidian, and associates stored
metadata by text and surrounding context. Unmatched excerpts and orphaned personal annotations
remain in `highlight_recovery` and are visible in the article's Highlights view.
Unresolved code and text anchors also retain their excerpts for recovery. Text
anchors can paint exact, contextually resolved visible excerpts while leaving the
article source unchanged; native marker removal remains authoritative for entries
without these explicit fallback flags. The writer verifies rendered structure as
well as text and falls back to text annotations when new markers would alter it.
See [Reading highlights](reading-highlights.md).

### Reading images

While `readingImages` is `save`, server captures and article jobs download up to 10 `https`
images per article (PNG, JPEG, GIF, WebP or AVIF by their bytes, 5 MiB each, 20 MiB in all, one
redirect each) in the Reading alarm, and put them in R2 under one upload lease. The publication
sent to the coordinator carries only their object keys. Under the lock, each image still inside
the current folder's `attachments/<Reading ID>/` commits as a new file (or is kept when that exact
content is already live) before the note, which links only the committed ones; every other
image keeps its web link and its object is queued for cleanup.

#### Image limits

| Saved by | Images per article | Each | In all | Set in |
| --- | --- | --- | --- | --- |
| Obsidian | No count limit | 10 MiB | 40 MiB | `READING_IMAGE_LIMITS` in `src/reading/core/article-images.ts` |
| Server, plaintext vault | 10 | 5 MiB | 20 MiB | `WORKER_IMAGE_LIMITS` in `src/cloudflare/worker/reading/extraction/images.ts` |
| Server, encrypted vault | 10 | 2 MiB | 8 MiB | `ENCRYPTED_IMAGE_LIMITS` in the same file |

Obsidian downloads on the device, so only file size bounds it. The server limits come from the
Cloudflare Free plan:

- An invocation may make 50 subrequests. Fetches, R2 calls and D1 queries all count (a
  `db.batch()` counts once), and so does each redirect. Each image costs several (its fetch, any
  redirect and its R2 write), so one alarm run fits about 10 images next to the capture itself.
  `reading/image-budget.integration.ts` checks that the alarm run and the publication each stay
  within 50.
- A Worker isolate has 128 MiB of memory, which bounds the total held during a run.
- Each saved image writes about 3 D1 rows and reads about 45, against 100,000 rows written and
  5 million read per day.
- In an encrypted vault, `POST /reading/encrypted-extract` returns every image in one response and
  they commit beside the new note, under the 24 MiB encrypted commit limit. Images stop downloading
  16 seconds after the request arrives, so the article answers within the web app's 20 second wait;
  an unfinished image keeps its web link. **Try again** sends `images: false` and gets none.

The Paid plan allows 10,000 subrequests, but the limits stay the same on every plan. Saving more
on Free would need each group of images in its own invocation, for example a Durable Object
request per batch.

`GET /reading/file?path=…` (library credential, plaintext vaults) returns one image file inside
the Reading folder, typed by its name with `X-Content-Type-Options: nosniff` and a sandboxing
CSP. Other paths return 400.

### Reading capture handoffs

`POST /reading/shortcut/v1/prepare` accepts only capture credentials when the
Reading library is configured and available. Its five-minute launch URL
contains an opaque capability in the fragment. `POST /reading/handoff` redeems it
through `X-Crate-Capture`, using the same issuer-scope policy. Redemption checks
issuer revocation/expiry, capability expiry, the Reading folder generation, and
feature availability. Repeating a live capability reuses its exact operation ID;
it does not create another note. Revoking the issuer blocks even a committed
capability's subsequent replay.

### Native Shortcut compatibility

`POST /reading/shortcut/v1/prepare` accepts only capture credentials and
`{ url, title? }`. `POST /reading/shortcut/v1/exchange` redeems the same one-use
pairing code with `{ token }`. These routes do not require the app wire header.
`X-Crate-Shortcut-Revision` identifies the installed template; it defaults to 1.
The capture contract version is in the path. Metadata at `/.well-known/crate`
exposes `shortcut: { version, revision, minimumRevision }` and the
`reading-shortcut-transport-v1` capability.

Recognized native requests return `shortcut: { version, revision,
updateAvailable, downloadUrl }`. Preparation successes return the opaque launch
URL; failures return an error launch URL even for authentication, admission, or
compatibility rejection. Its fragment contains only allowlisted diagnostic
fields. Only the current contract's routes are admitted; other contract
versions receive 404. A template below the supported minimum revision receives
426 `shortcut_update_required`. The live, uncached save page performs the handoff
with the server's current app wire protocol.

Only the versioned shortcut routes bypass the general app protocol. Other routes enforce the normal protocol checks.

Encrypted vaults do not offer Save to Crate: the Shortcut's pairing, exchange and prepare routes
answer `409` with code `shortcut_encrypted_vault`.

See [shortcut maintenance](reading-shortcuts.md) for release and support rules.

### Reading shortcut pairing

The server advertises `reading-shortcut-pairing-v1`. `POST /reading/shortcut-pairing` requires an active Reading or vault credential and HTTPS. It returns `{ pairingCode, expiresAt }`, with a ten-minute, single-use secret in the code’s URL fragment. Only one outstanding code per issuer is retained. The browser cannot issue library or vault access through this route.

`POST /reading/shortcut/v1/exchange` accepts `{ token }` without a bearer credential. The Shortcut strips the fragment locally and sends it only in this body. Atomic redemption rechecks the issuer, policy, folder and generation and returns `{ endpoint, authorization }` for a new capture-only token. Its expiry is the earlier of 90 days and the issuer’s expiry. The token records its issuer in `auth_tokens.device_id`, so revoking the issuer revokes it too. Replacing a web app session with a fresh link moves it to the new session. Replay, expiry, issuer revocation or a changed policy generation returns 410. A lost reply requires a new code. Pairing creation requires the app protocol; exchange uses the independent shortcut contract. Both have separate per-minute action limits and return `Cache-Control: no-store`. Grant hashes are `reading_enrollment` rows in `grants` with scope `reading_capture:<issuer-id>`; normal library/install exchanges reject this scope.

### Article fetching permission

The server advertises `reading-fetching-consent-v1`. Reading libraries remain
accessible when article fetching is off. The `reading_policy.enabled` field
controls extraction only. A newly configured
plugin initializes extraction when Reading is enabled. A library capture with
`fetchArticle: true` also enables extraction as part of that explicit save.
Capture-only credentials cannot enable it. The plugin does not expose a separate
fetching switch.

With fetching off, new URL captures become bookmarks (`extraction_status: unavailable`),
existing articles remain readable and editable, and retries are rejected. In an
encrypted vault `/reading/encrypted-extract` refuses, so the web app saves a bookmark. Capture
requests may also supply `fetchArticle: false` to save a bookmark regardless of the
shared permission, including when an offline save is replayed later. Omitting the
field applies the shared permission.

## ReminderAlarm Durable Object

Exported class `ReminderAlarm` from the worker. Named instances of it run the coordinator, maintenance, Reading, transfer and notification dispatcher roles. The dispatcher keeps one alarm at the earliest scheduled reminder in `reminder_projections`. When it fires, it sends Web Push notifications for a bounded batch of due reminders to all subscribed devices via `web-push-browser` and records each delivered occurrence in its D1 row.

Requires a `durable_object_namespace` binding (`REMINDER_ALARMS`) and a declarative `exports.ReminderAlarm` entry with SQLite storage on deploy.

## D1 database schema

The complete current schema is [src/cloudflare/schema.sql](../src/cloudflare/schema.sql). It is hash-verified before provisioning. An empty database is initialized with `crate_schema` version 1; no migrations are registered. Unsupported schemas are rejected without modifying data. Worker requests never execute DDL.

The schema stores file metadata, changelog entries, retained versions, upload/deletion receipts and cleanup work; device credentials and one-time grants (`grants`: web enrollment links, Reading pairing codes and save links, device and app pairings); operation receipts of uploads, reminders and Reading (`operations`, with `operation_chunks` for large encrypted responses) and identity reservations; vault-wide state in one row (`server_state`: encryption, features, reset generation, changelog floor, initial import and shared settings); shared notification policy and projections, which carry the delivery schedule of each scheduled reminder; authenticated push subscriptions and request limits. Derived schedules are rebuilt from committed Markdown during an isolated restore.

Reminder mutations replay a matching operation receipt before rereading a moved or deleted source; a different payload under the same operation ID returns 409. Notification time comes from the saved server policy. Successful create/update/completion responses include the acknowledged `reminder` and its new revision.

## Bindings

Deployment builds the Worker's bindings in `src/cloudflare/deployment/worker-upload-payload.ts` from the names in `src/cloudflare/worker-runtime.json`; [architecture](architecture.md#worker-bindings) lists every binding.

## Encryption API

`GET /encryption` returns the public configuration (`vaultId`, `generation`, `mode`, vault `keyId`, `notificationKeyId`, the seal key's `keyId` and `publicKey`) and an encrypted recovery bundle to every vault and web app credential (not to Shortcut capture tokens); `/reading/encryption` does the same after validating Reading enrollment. The user’s recovery code decrypts the bundle locally and is never uploaded. Session route permissions remain scoped; sharing this ciphertext does not grant sync, settings or device-management access. Encrypted files must use the vault key (`scopeId: "vault"`). Any file may carry no scheduling metadata; a `.md` file may carry schedules whose notifications use `notificationKeyId`. For a Reminders credential in an encrypted vault, `GET /encryption` also returns `folderPath` (the enrolled folder's tag) and `folderLabel`; `/reading/encryption` adds the Reading folder's `folderLabel`. The web app opens the label with the vault key to recover the plaintext folder name.

Every file and folder name in an encrypted vault is a 26-character lowercase base32 tag, with `.md` kept for Markdown, so every `path` and `folderPath` the server sees is a tagged server path. Uploads and commits of encrypted content at a readable path return 428. `POST /reading/policy`, `POST` and `PUT /reminders/notification-policy`, and `POST /notifications/reminders-enrollment-token` require a tagged `folderPath` plus a `folderLabel` (the folder's plaintext path and tag encrypted under the vault key, at most 8,192 characters) and return 428 without them; a plaintext vault rejects `folderLabel`. The server stores the label in `maintenance_state` under `e2ee:folder:<tag>`, and policy reads return it as `folder_label` (Reading) or `folderLabel` (notifications). Maintenance deletes a label once no policy, credential, push subscription or enrollment link names its folder. There is no in-place conversion API: turning encryption on uses the [destructive reset](#destructive-encryption-reset).

In an encrypted vault, `/sync/manifest`, `/sync/metadata` and `/sync/changes` (on `put` entries) list each file's `descriptor` beside its `revision`, and `/sync/versions` lists it on each retained version. `POST /encryption/metadata` takes `{ "files": [{ "path", "revision" }] }`, up to 1,000 server paths with a revision each, and returns `{ "descriptors": { <revision>: descriptor } }`. Clients use it only for revisions listed without a descriptor, such as shared checkpoint entries. It reads the live file by portable path and, for a revision that is not live, the retained version by key: about two rows per revision. A revision that is neither live nor retained has no bytes left and is left out of the response; see [encryption](e2ee-implementation.md). `/encryption/deletion-precondition?path=…&revision=…` resolves an accepted encrypted deletion and includes the consumed revision's `descriptor`. Shared `/settings` becomes a conditional encrypted envelope endpoint.

Encrypted settings support all preferences accepted by the plaintext API's 1 MiB request limit. The envelope allowance is `ceil(1 MiB × 4 / 3) + 4096` characters for base64url and JWE overhead; encrypted settings requests allow another 4096 bytes for the JSON wrapper.

Scoped reminders use `GET /reminders/encrypted-files?folderPath=…&after=…&since=…`, `GET /reminders/encrypted-file?folderPath=…&path=…&revision=…`, `POST /reminders/encrypted-files/download` and `POST /reminders/encrypted-commit`. Every route checks a Reminders credential's enrolled folder.

The inventory lists 1,000 files per page in portable-path order as `{ files: [{ path, hash, size, revision, modified }], nextCursor, generation, changeToken, deltaBase }`; `after` is the previous page's opaque `nextCursor`. `changeToken` is a vault change token (see `sync/change-token.ts`) scoped to the folder tag and key generation, also sent as the `ETag`. A first-page request with `If-None-Match: "<changeToken>"` answers `304` from the vault change state alone, before reading the folder. With `since=<deltaBase>` it answers `{ delta: true, files, removed, generation, changeToken, deltaBase }`: the current entries of the folder notes written since that base and the paths no longer listed. It lists the whole folder instead when the changelog cannot prove the delta complete (pruned, reset, imported, from another folder or generation, or over 1,000 changed paths). The Worker reads each page's or delta's rows between two reads of the change state and answers `409` with `code: "inventory_changed"` when they differ, so every `200` is one snapshot and pages with the same `changeToken` belong together.

`POST /reminders/encrypted-files/download` accepts `{ folderPath, files: [{ path, revision }] }` with up to 50 notes and answers `{ files }` in request order. Each entry is `{ path, revision, hash, size, content }`, with the ciphertext as a UTF-8 string, or `{ path, revision, error, code }` with `code` `version_conflict` (the note has another revision now), `not_found`, `file_too_large` (over 4 MiB) or `unavailable`. Notes at their requested revisions may total at most 8 MB, or the request fails with `413`. It only reads, so it is not a mutation and needs no protocol check. Clients verify each note against the size and hash its inventory entry listed. Commits contain an operation ID, encrypted acknowledgment and one or two encrypted Markdown replacements with hash/revision preconditions. A commit may instead carry one new note in `files` and its source in `remove: [{ path, expectedHash, expectedRevision }]`; the Worker creates the note and deletes the source in one transaction, which renames a note. With an empty `files` list, `remove` alone deletes that exact revision. Whole-note bytes are encrypted on the client. Encrypted acknowledgments allow the JSON/base64 expansion of a 1 MiB reminder note (`ceil((6 MiB + 16 KiB) × 4 / 3) + 4096` characters); commit requests are capped at 24 MiB. Responses above 512 KiB are stored in bounded ciphertext chunks in `operation_chunks`, committed atomically with the receipt and file changes. Retries reconstruct the exact original response; missing chunks fail without replaying the mutation. Scheduled maintenance removes chunks in the same transaction as their expired receipt. Plaintext semantic mutation routes are unavailable after activation; `/links/title` stays available to clients with current encryption headers.

Uploads to an active encrypted vault validate both the encrypted content type and file envelope before registering an upload lease or writing to R2. Batches of new files (`bulkNewFiles`) and the initial import (`/sync/import*`) accept encrypted vaults too; each file's descriptor is read from its bytes before the commit. Single and batch uploads reject plaintext, malformed envelopes, and mismatched encryption keys with an encryption error; rejected batches stage no candidate files. Encryption identity and reset generation are rechecked transactionally at staging and publication.

Single and batch uploads stream through the existing eight-object transfer pool, where hashing, envelope validation and storage use the Durable Object CPU allowance. Each object processes one upload at a time. The public Worker checks authorization before forwarding; the transfer executor repeats authentication after queuing and captures current encryption/reset authority before reading the body. Markdown publication still uses the separate notification coordinator. This applies to hosted and self-hosted deployments without a new binding or schema migration.

Encrypted file transfers permit up to 38 MiB wire bytes for the default 25 MiB plaintext limit; a raised limit allows its base64url ciphertext plus 2 MiB of scheduling data and framing (`encryptedFileLimit`). Encrypted previews transfer ciphertext; the client applies the existing 256 KiB plaintext preview limit. Reminder clients enforce the existing 1 MiB plaintext note limit. See [encryption](e2ee-implementation.md) for metadata disclosure and recovery.

### Encrypted web app approval

Servers advertising `web-pairing-v1` expose non-cacheable `GET` and `POST`
`/encryption/pairing`. An active encrypted vault is required. This transfers
ciphertext to an already authenticated app; it never issues login credentials.

- `GET ?id=<request-id>` returns `{ requests }` for the requesting app or a vault
  device. A vault device may omit the ID to list pending requests other than its
  own. Other app credentials cannot inspect or cancel that request.
- `POST { action: "start", context, commitment }` creates an app request. Context
  contains `version: 1`, unique `id`, canonical `origin`, `vaultId` and
  `generation`. A vault device without keys, such as a newly paired one, may
  start a request too; Reading capture credentials cannot. No device can accept
  its own request. Approval transfers `{ bundle }`, the full vault key bundle.
- `accept` supplies `{ id, key }` from one vault device; `reveal` supplies the
  committed requester public key from the owning app. Public keys are raw P-256
  points encoded as base64url. `approve` supplies `{ id, payload }` from that
  same vault device after comparison. The server handles only encrypted packets.
- `cancel` closes a request; `finish` acknowledges durable key import from its
  owning app. Both discard the packet. POST responses return `{ request }`.

Records expire in five minutes, with three slots per app and 32 server-wide.
Cancelled slots count until expiry. Polling does not update these records;
repeated identical steps are idempotent. Conditional updates check the current
actor, owner, vault state and generation. Closed, expired, revoked or mismatched
requests cannot publish a new packet. See [the approval protocol](e2ee-implementation.md#app-approval-protocol)
for key derivation and comparison requirements.

### Destructive encryption reset

Servers advertise `e2ee-reset-v1`. The same reset turns encryption off or on. Vault-only `POST /encryption/reset?id=<unique-id>` starts it with `{ "confirmation": "delete-remote-data", "replacementToken": "<new 64-character lowercase hex token>" }`. On an encrypted vault the request needs current vault/generation headers and must not carry `encryption`. On a plaintext vault it turns encryption on and also takes `encryption`, the new public configuration with `mode: "active"`; an invalid configuration returns 400, and the server returns 409 without changing anything while saved links are still downloading (queued Reading captures) or an initial import is running. The client durably saves that identity and token before dispatch. The transaction switches encryption to `resetting`, replaces all credentials with the supplied vault token, removes enrollment grants/subscriptions, queues alarm cancellation, and invalidates upload leases. Upload staging/publication checks both the encryption identity and a persistent reset generation captured atomically at authentication. The reset generation survives encryption removal, fencing even plaintext requests delayed across encryption activation and reset. These checks apply to single, batch and bulk uploads without new client headers.

Using the replacement token, `GET /encryption/reset?id=…` reads the receipt and repeated `POST` requests with `{}` advance bounded alarm/object deletion. Responses contain `{ id, vaultId, generation, complete }`. Ordinary routes return 423 while resetting; revoked clients return 401. Completion atomically clears vault tables and encryption metadata, preserving infrastructure metadata, cleanup authority for late R2 writes and idempotent reset receipts; a reset that turns encryption on stores its configuration as active in the same transaction. Repeating a completed request only returns its receipt. The client then invalidates local sync checkpoints/journals, saves its replacement token and uploads its local vault: without encryption after removing its keys, or encrypted with the keys it saved before starting. External backups are not rewritten or erased.

### Encrypted Reading

Authenticated `GET /reading/encryption` returns the public configuration and, in an encrypted vault, the Reading folder's `folderLabel`. It and the public feature/session control-plane reads can bootstrap without encryption headers; content operations still require the current vault and generation.

`GET /reading/encrypted-files?folderPath=…&after=…&since=…`, `GET /reading/encrypted-file?folderPath=…&path=…&revision=…`, `POST /reading/encrypted-files/download` and `POST /reading/encrypted-commit` reuse the conditional encrypted-file protocol above. Inventory entries of both features also carry `modified`, the server's time of the file's last write, which the server already knows; the Reading app uses it to open the most recently changed notes of a library over its device limit. Reading authority additionally fixes the folder to the current Reading policy and rejects capture-only credentials. A Reading commit with `remove` renames a note, for example when **Try again** finds the title of a note that still has its link-based name. A commit with an empty `files` list and one `remove` deletes that exact note revision. `POST /reading/encrypted-extract` accepts `{ url }` from a library credential while encryption is active, downloads the page through the same public-only transport as server captures, and returns `{ article }` without storing the link or article. While `readingImages` is `save`, it also returns `images: [{ url, type, data }]`, base64 bytes of up to 10 images (2 MiB each, 8 MiB in all), stored nowhere. A Reading commit may then carry `attachments: [{ path, content }]`, up to 10 sealed non-note files beside exactly one new note: each commits as a new file before the note, an existing one is kept, and non-note files must have no public data. A delete commit (empty `files`, one `remove`) may carry `removeAttachments: [path]`, the tags of up to 30 non-note files the deleted note linked to; after the note's deletion commits they are deleted at their current revisions, and a failure leaves them in place. `GET /reading/encrypted-file` also returns non-note files in the Reading folder, up to the encrypted file limit. It runs outside the coordinator, in the stateless article extraction pool after the public Worker checks access, returns 422 when the download fails, 403 `reading_fetching_off` while article fetching is off, and 409 without encryption. It has its own limit of 30 requests per minute per credential and counts toward the Reading daily budget. Save to Crate is not offered: the Shortcut's routes answer 409 `shortcut_encrypted_vault` before reading the request body. The plaintext-only Reading routes (item, file, capture, update, retry, delete and handoff) and background extraction fail closed while any encryption state exists.

Reset clears Reading policy, sources, jobs, receipts, captures, enrollments and handoffs at both boundaries.

Encrypted browser wire attempts retain their generation and server path. Clients authenticate both the exact wire hash and the inner semantic acknowledgment before settling a save.
