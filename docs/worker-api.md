# Worker API

Source lives in `src/cloudflare/worker/`; `scripts/build-worker.mjs` writes the deployable module to `.generated/cloudflare/worker.mjs`. The Vite production build embeds a compressed, hashed copy of that generated module for the in-plugin OAuth deployment.

Every mutation requires `X-Crate-Protocol: 7`; check `/.well-known/crate` before writing. Missing/incompatible protocols receive 428. POST metadata and batch-download requests are reads. See [the protocol contract](protocol.md) for retry, revision, storage, and notification guarantees. Responses carry `X-Crate-Request-Id` for diagnostics.

## Authentication

All non-public API endpoints require an `Authorization: Bearer <token>` header. Tokens have `vault`, `reminders`, `reading`, or `reading_capture` scope, and may have an expiry. Reading grants are also bound to the active Reading policy generation. The Worker hashes the bearer token with SHA-256 and looks up the hash in the `auth_tokens` D1 table. Authentication fails closed with `503` when D1 is unavailable.

Vault device tokens are registered only through a temporary Cloudflare OAuth authorization; the Worker exposes no public or device-authorized vault-enrollment endpoint. PWA exchanges create 90-day `reminders` tokens bound to the enrolled folder. These tokens cannot call sync, settings, device-management or push-administration routes. Public compatibility, PWA assets, and reminder-enrollment endpoints are listed separately below. CORS headers are included on all JSON/API responses.

Self-hosted installations additionally have a Node gateway, outside the Worker:
`GET /__crate/ready` returns a per-process readiness identifier, and
`POST /__crate/pair` exchanges `{ code }` for `{ authToken }`. Pairing codes have
256 bits of randomness, expire after ten minutes, and are claimed once before
credential creation. Only a local authenticated administration socket can issue
codes; this socket is never forwarded through the public tunnel. The gateway
does not enable device registration on Cloudflare-hosted Workers. Existing vault
tokens and scoped PWA enrollment keep their current behavior.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/crate` | Public service, version, protocol range, and capability metadata |
| `GET` | `/health` | Health check, returns `{ status, timestamp }` |
| `POST` | `/links/title` | Authenticated page-title lookup `{ url }`, returns `{ title: string \| null }`; allowed for vault and reminder tokens |
| `GET` | `/sync/check?since=<seq>` | Lightweight check: are there changes since this sequence? |
| `GET` | `/sync/changes?since=<seq>` | Paginated changelog entries (limit 5000 per page) |
| `GET` | `/sync/manifest?limit=<n>&after=<path>&snapshotSeq=<seq>` | Stable, cursor-paginated remote manifest |
| `POST` | `/sync/metadata` | Fetch current metadata for up to 50 selected paths |
| `PUT` | `/sync/upload?path=<path>` | Upload one conditionally-versioned file (binary body, max 25 MB) |
| `GET` | `/sync/download?path=<path>` | Download single file (streaming from R2) |
| `POST` | `/sync/delete` | Delete single file with expected hash and revision |
| `POST` | `/sync/batch-upload` | Batch upload `{ files: [...] }` (max 3 files, 10 MiB total) |
| `POST` | `/sync/batch-download` | Batch download `{ paths: [...] }` (max 50 paths and 8 MB decoded) |
| `POST` | `/sync/batch-delete` | Conditional batch delete `{ files: [...] }` (max 4 files) |
| `GET` | `/sync/checkpoints` | List up to 20 unexpired shared checkpoints |
| `POST` | `/sync/checkpoints` | Capture the authoritative server inventory; unchanged generations reuse their checkpoint |
| `GET` | `/sync/checkpoint?id=<id>` | Read the complete inventory of a live shared checkpoint |
| `GET` | `/sync/checkpoint-file?id=<id>&path=<path>&revision=<revision>` | Stream an exact current/retained file revision while the checkpoint remains live; vault scope only |
| `GET` | `/sync/versions?path=<path>&search=<text>&cursor=<cursor>` | Page through unexpired recoverable file versions (100 per page) |
| `POST` | `/sync/restore-version` | Restore a retained version with expected-hash compare-and-swap |
| `GET` | `/diagnostics` | Backend counts, delivery failures, queue pressure, and scheduled-maintenance state |
| `DELETE` | `/auth/tokens` | Revoke an auth token `{ id }` |
| `GET` | `/auth/tokens` | List all registered auth tokens |
| `DELETE` | `/auth/session` | Atomically revoke the current bearer token and its owned push subscriptions |
| `GET` | `/settings` | Get shared settings from R2 |
| `PUT` | `/settings` | Store shared settings to R2 |
| `GET` | `/reminders/list?folderPath=<path>` | List reminders and projects from synced Markdown files |
| `POST` | `/reminders/create` | Create a reminder in a project Markdown file |
| `POST` | `/reminders/update` | Update or move a reminder |
| `POST` | `/reminders/set-completed` | Toggle reminder completion |
| `DELETE` | `/reminders/delete` | Delete a reminder from Markdown |
| `POST` | `/reminders/reorder` | Reorder reminders inside a project file |
| `GET`, `POST`, `PUT` | `/reminders/notification-policy` | Read, initialize, or explicitly update shared notification policy (vault scope) |
| `POST` | `/notifications/reminders-enrollment-token` | Create one-time browser and install tokens for a reminders web app link (vault tokens only) |
| `POST` | `/notifications/subscribe` | Save a push subscription |
| `DELETE` | `/notifications/subscribe` | Remove a push subscription |
| `GET` | `/notifications/subscriptions` | List push subscriptions |
| `POST` | `/notifications/test` | Send a test push notification |

## Public and PWA Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Returns public service, version, protocol range, and capability metadata |
| `GET` | `/notifications` | Serves the reminders PWA HTML |
| `GET` | `/notifications/app.js` | Serves the bundled PWA client |
| `GET` | `/notifications/sw.js` | Serves the PWA service worker |
| `GET` | `/notifications/manifest.json` | Serves the PWA manifest |
| `GET` | `/notifications/version.json` | Returns the current PWA asset version |
| `GET` | `/notifications/icon.svg` | Serves the PWA icon |
| `GET` | `/notifications/open-obsidian` | Serves the browser handoff page for opening Obsidian |
| `GET` | `/notifications/vapid-public-key` | Returns the Web Push VAPID public key |
| `POST` | `/notifications/reminders-exchange` | Exchanges a one-time web enrollment token for a PWA auth token |

## Request/Response Details

### Page titles

`POST /links/title` is a read operation and does not require mutation protocol negotiation. Pasting a standalone web URL automatically uses it. It accepts public HTTP(S) DNS names on standard ports, excludes credentials and fragments, validates each redirect (maximum three), and reads at most 256 KiB of HTML within five seconds. It returns the HTML title as text with entities retained; clients decode entities as text. Missing titles, unsupported responses, and network failures return `title: null`. Invalid destinations return 400; the edge request limiter can return 429. No page scripts execute, no caller credentials are forwarded, and responses are not cached. Older servers return an error and clients retain the URL label.

### PUT /sync/upload

- Query: `?path=<url-encoded-path>`
- Headers: `X-File-Hash`, `X-File-Size`, `X-Crate-Expected-Hash`, `X-Crate-Upload-Operation`, `Content-Type`
- `X-Crate-Expected-Hash` is the 64-character remote hash observed while planning, or `absent` for a new path
- Body: raw binary, consumed incrementally with a hard 25 MB cap; oversized declared or chunked requests stop before the remainder is buffered
- Response: `{ success, path, hash, revision }`
- A stale expected hash returns `409` with `{ success: false, path, error, code: "version_conflict", currentHash }` and does not replace the committed object
- Persist the exact request and its server-dated operation ID before dispatch. Replaying it returns the original success or rejected precondition, including after deletion. Missing IDs receive 428; mismatched payloads receive 409 `operation_mismatch`; expired IDs without receipts receive 410 `operation_expired`. See [upload recovery](upload-recovery.md).

### GET /sync/download

- Query: `?path=<url-encoded-path>`
- Response headers: `Content-Type`, `Content-Length`, `X-File-Hash`, `X-Crate-Revision`
- Body: raw binary (streamed from R2)

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

Worker validates: max 3 files, total decoded content <= 10 MiB. Each file requires its own stable `operationId` with the same receipt and expiry rules as a single upload. Mutation batches are deliberately smaller than download batches to stay within Workers Free D1 query limits even on stale-write cleanup paths.

Response: `{ success, results: [{ path, success, hash?, revision?, error?, code?, status?, currentHash? }] }`. A stale per-file write uses `code: "version_conflict"`, `status: 409`, and the current remote hash; storage failures use `code: "storage"` and `status: 503`.

### POST /sync/batch-download

Request: `{ paths: ["notes/file.md", ...] }` (max 50, no duplicates)

Response: `{ files: [{ path, content, hash, size, contentType, revision, error? }] }`

Content is base64-encoded. The Worker rejects a batch before reading R2 if D1 metadata shows that it exceeds 8 MB. The client batches only files smaller than 1 MB, validates the exact response path set, size, and SHA-256 hash, and falls back to individual streaming downloads when a batch is too large or unavailable.

### POST /sync/delete / batch-delete

Single: `{ path: "notes/file.md", expectedHash: "sha256...", expectedRevision: "opaque-key" }` -> `{ success, path }`

Batch: `{ files: [{ path, expectedHash, expectedRevision }, ...] }` (max 4) -> `{ success, deleted: [...], errors?: [{ path, error, code?, status?, currentHash? }] }`

Uploads compare the observed D1 content hash. Deletes also compare the original opaque revision, rejecting same-content recreations. Reminder edits compare a semantic revision captured by the client, then apply file-level preconditions. D1 commits the file row, changelog, retention, operation receipt, and notification projection intent atomically; stale writers receive `409`.

### GET /sync/check

Query: `?since=<seq>`

Response: `{ lastSeq, hasChanges, cursorExpired? }`

`cursorExpired` is true when `since` points to a pruned changelog region, signaling the client should fall back to full sync.

### GET /sync/changes

Query: `?since=<seq>`

Response: `{ changes: [...], lastSeq, hasMore, cursorExpired? }`

Paginated at 5000 entries. Client loops until `hasMore` is false.

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

### DELETE /auth/tokens

Revoke a token by its ID.

Request: `{ id: "<uuid>" }`

Response: `{ success: true }`

### GET /auth/tokens

List all registered tokens (does not expose hashes). The current token is marked with `is_current`.

Response: `{ tokens: [{ id, device_id, device_name, platform, created_at, last_seen_at, is_current }] }`

### DELETE /auth/session

Revokes the bearer token used for the request. Crate calls this before clearing its local credential when the user disconnects the current device.

Response: `{ success: true }`

### GET /settings

Returns shared plugin preferences stored in R2 as `__crate__/settings.json`. Used by second devices to inherit settings during setup.

Response: `{ settings: { ignorePatterns, syncOnStartup, syncOnResume, syncInterval, showStatusBar, pushEnabled }, settingsVersion }` or `{ settings: null, settingsVersion }` if not yet stored or corrupt.

### PUT /settings

Stores shared plugin preferences to R2.

Request: `{ settings: { ignorePatterns: [...], syncOnStartup: true, syncOnResume: true, syncInterval: 300, showStatusBar: true, pushEnabled: false }, expectedVersion }`

Response: `{ success: true, settingsVersion }`. A stale version returns `409` instead of overwriting another device's edit.

### GET /reminders/list

Query: `?folderPath=<reminders-folder>`

Reads synced Markdown reminder files from the configured folder and returns web-ready reminder records plus known projects. Conditional requests use an ETag derived from file metadata and the reminder parser version. On an ETag miss, D1-cached parses are reused by file hash, so only new or changed Markdown objects are fetched from R2 and parsed.

Cold indexes are warmed in batches of at most 20 files and 2 MiB per request. While more files remain, the endpoint responds with `202` and `{ warming: true, remainingFiles }`; clients should repeat the request until it returns `200`. Individual reminder Markdown files must be no larger than 1 MiB.

Response: `{ reminders: [...], projects: [...], issues: [...] }`. Each reminder includes its semantic `revision`. Oversized notes or cache records yield per-file issues while healthy reminders remain usable; responses with issues omit ETag. Warming responses include `totalFiles` and `Retry-After: 1`.

### POST /reminders/create

Creates a reminder in the selected project Markdown file, creating that file if needed.

Request includes a versioned `operationId`, `folderPath`, `content`, optional `project`, `description`, `priority`, `dueDate`, `dueDatetime`, `recurrence`, and required `id` equal to `operationId`. Recurrence time fields include optional `second` (0–59) and `millisecond` (0–999), alongside `hour` and `minute`. Obtain the UTC operation day from server metadata and encode it as specified in the [retry policy](reminder-retention.md).

Response: `{ success: true, notificationWarning? }`

### POST /reminders/update

Updates an existing reminder by `id`. The request requires a versioned `operationId`, `expectedRevision`, `folderPath`, and the reminder's original `filePath`, plus any mutable reminder fields: `content`, `description`, `priority`, `project`, `dueDate`, `dueDatetime`, `recurrence`.

If `project` changes, the worker commits the source and destination Markdown files atomically with hash-based compare-and-swap checks.

Response: `{ success: true, notificationWarning? }`

### POST /reminders/set-completed

Request: `{ operationId, expectedRevision, folderPath, filePath, id, completed }`

Response: `{ success: true, notificationWarning? }`

### DELETE /reminders/delete

Request: `{ operationId, expectedRevision, folderPath, filePath, id }`

Response: `{ success: true, notificationWarning? }`

### POST /reminders/reorder

Request: `{ operationId, folderPath, project, orderedIds, expectedOrder }`. `expectedOrder` is the previously observed complete project order; a concurrent reorder or changed membership returns 409.

Response: `{ success: true }`

### GET / POST / PUT /reminders/notification-policy

Vault credentials only. GET reads the shared folder, IANA timezone, all-day time, enabled state, and revision. POST initializes only an absent policy. PUT changes it explicitly with `expectedRevision`; stale changes receive 409. Starting a client never overwrites another device's policy.

Schedules derive from committed Markdown and the shared notification policy. File commits enqueue projection intent in the same D1 transaction. The Durable Object coordinator drains at most three files and five outbox jobs per alarm, fences stale work with file/policy/job revisions, and rearms while work remains. Maintenance recovers missed wakeups.

## Notifications and PWA Endpoints

### GET /notifications (public)

Serves the reminders PWA HTML page. The plugin generates short-lived links with query params such as `token`, `browserToken`, `folder`, `upcomingDays`, `allDayTime`, `project`, `tab`, and `reminderId`.

The `token` query parameter is a web enrollment token, not a sync bearer token.

### GET /notifications/app.js, /sw.js, /manifest.json, /version.json, /icon.svg, /open-obsidian (public)

Serve the PWA client bundle, service worker, manifest, version metadata, icon, and Obsidian handoff page. Versioned static assets use long-lived cache headers when a `v` query param is present.

### GET /notifications/vapid-public-key (public)

Returns the VAPID public key, lazily generated and stored in D1.

Response: `{ publicKey: "base64url-encoded-key" }`

### POST /notifications/reminders-exchange (public)

Consumes a one-time web enrollment token and creates a per-device PWA auth token in `auth_tokens` in one transaction. A failed transaction preserves the enrollment token. Concurrent exchanges can create only one session. A successful transaction whose response is lost still consumes the token; recovery requires a new enrollment link.

Request: `{ token, deviceName?, previousAuthToken? }`

When replacing a browser session, the optional previous reminder credential revokes that session and its push subscriptions in the transaction that creates the replacement. Expired reminder credentials can be replaced; vault credentials cannot be revoked through this endpoint.

Response: `{ authToken }`

### POST /notifications/reminders-enrollment-token

Vault-token authenticated. Creates separate short-lived, one-time tokens for previewing a reminders app link in the browser and activating the installed app. Reminders web app tokens cannot mint replacement sessions. Keeping the install token unused by the browser prevents iOS from launching a Home Screen app with an already-consumed credential.

Response: `{ token, browserToken, expiresAt }`, where `token` is reserved for the installed app.

### POST /notifications/subscribe

Save a push subscription owned by the authenticated session. Public requests are rejected.

Request: `{ endpoint, keys: { p256dh, auth }, deviceName? }`

Response: `{ id }`

### DELETE /notifications/subscribe

Authenticated. Remove a push subscription.

Request: `{ id }`

Response: `{ success: true }`

### GET /notifications/subscriptions

Authenticated. List all push subscriptions.

Response: `{ subscriptions: [{ id, device_name, created_at }] }`

### POST /notifications/test

Authenticated. Send a test push to all subscriptions.

Response: `{ sent, failed, pruned, errors }`

## ReminderAlarm Durable Object

Exported class `ReminderAlarm` from the worker. Each reminder gets its own DO instance keyed by `reminderId`. When the alarm fires, the DO sends Web Push notifications to all subscribed devices via `web-push-browser`, then clears the completed schedule from D1 while retaining its occurrence receipt in Durable Object storage.

Requires a `durable_object_namespace` binding (`REMINDER_ALARMS`) and a declarative `exports.ReminderAlarm` entry with SQLite storage on deploy.

## D1 database schema

The complete current schema is [src/cloudflare/schema.sql](../src/cloudflare/schema.sql). It is hash-verified before provisioning. An empty database is initialized with `crate_schema` version 5; schemas 2/3/4 upgrade additively during provisioning. Unsupported schemas are rejected without modifying data. Worker requests never execute DDL.

The schema stores file metadata, changelog entries, retained versions, upload/deletion receipts and cleanup work; device credentials and folder-bound web enrollment tokens; reminder receipts and identity reservations; shared notification policy, projections, and delivery jobs; authenticated push subscriptions and request limits. Derived schedules are rebuilt from committed Markdown during an isolated restore.

Reminder mutations replay a matching operation receipt before rereading a moved or deleted source; a different payload under the same operation ID returns 409. Notification time comes from the saved server policy. Successful create/update/completion responses include the acknowledged `reminder` and its new revision.

## Path Sanitization

`sanitizePath()` rejects null bytes, traversal, empty segments, backslashes, Windows-reserved names and characters, and trailing dots/spaces. A normalized unique D1 key additionally prevents case-insensitive and Unicode-normalizing collisions.

## Changelog Pruning

Activity schedules one cleanup alarm 24 hours later, which deletes entries older than 30 days (`CHANGELOG_RETENTION_DAYS`). Cleanup runs at most ten passes per activity-triggered episode. It can continue an advancing backlog or wait for a pending upload deadline; unconfirmed upload cleanup pauses after eight attempts. Failures are recorded for diagnostics.

When a client's `since` cursor points to pruned entries, the `cursorExpired` flag is returned so the plugin falls back to full sync.

## Bindings Table

See `docs/architecture.md` for the full bindings table. When adding new bindings, update the Worker upload metadata in `src/cloudflare/cloudflare-api.ts` and the deployment flow in `src/cloudflare/provisioner.ts`.

### Retained file history pagination

`GET /sync/versions` returns `{ versions, hasMore, nextCursor? }`. `path` is an optional exact filename and `search` is an optional literal substring (ASCII case insensitive), including folder names. Results sort by `(created_at, storage_key)` descending, and `nextCursor` continues that ordering without offset shifts when newer rows arrive. Reuse the same search and path with the opaque cursor; a changed query or malformed cursor receives HTTP 400. Expired versions are omitted from every page. The plugin’s **File history** view requests pages for one exact file path; search remains available in the API. Older Workers lacking pagination must be updated before this client will present their history as complete. Restores retain their existing conditional-write and integrity checks.

Authoritative manifest, targeted metadata and changelog reads are validated at runtime, including required maps, version and cursor framing, path/hash/size/date fields and ordering. Missing or malformed state aborts synchronization before file changes. A valid empty map remains an explicit empty state. Known historical changelog entries may lack revisions; current file metadata must include one.

### GET /sync/version-preview

Vault-authenticated, read-only access to one unexpired retained version. Query parameters `path` and `storageKey` must identify the same retained record. Returns integrity-verified binary content with `X-File-Hash`, `Content-Length`, and `Cache-Control: private, no-store`. Missing, expired, or mismatched entries return 404; versions larger than 256 KB return 413; missing or corrupt content returns 503. Arbitrary R2 keys are never served. No file, changelog, or retention state is modified.

File history decodes text locally and compares the saved version with a snapshot of the current local file. Binary/large files can still be restored without a preview. Older servers may not support previews; browsing and existing durable restore operations remain available. Deploy server revision 46 or later to enable previews.

The **History** view groups retained update/deletion versions by day, rather than presenting whole-vault snapshots or inferring restore events. **Files** reads the existing paginated manifest and replays subsequent changes to list current synced files, including those with no retained versions. Its current preview reads targeted metadata and downloads the remote copy only for text files up to 256 KB, verifying the size, hash and revision before display. It never substitutes unsynced local contents. The file list renders in batches of 200; **Refresh files** refreshes the remote inventory. Historical comparisons continue to use the local snapshot and never modify the sync manifest or queue.

### Shared history checkpoints

Protocol 11 advertises `shared-history-checkpoints-v1`; safe ordinary protocol-7
writes remain supported. Checkpoints store metadata in R2, not extra copies of vault
files. Creation snapshots the complete server inventory, not a client-supplied list.
The 20-entry index uses conditional ETags, and stale inventory captures receive 409.
Expired or evicted IDs receive 410. Captures are bounded to 20,000 files and 8 MiB of
metadata (413 beyond that limit), and in-progress initial imports receive 409.
All routes require vault credentials and return private, non-cacheable responses.
See [the sync pipeline](sync-pipeline.md#returning-to-a-history-checkpoint) for
retention, cleanup, restore validation, and older-server behavior.

### Reading shortcut pairing

Server revision 67 advertises `reading-shortcut-pairing-v1`. `POST /reading/shortcut-pairing` requires an active Reading or vault credential and HTTPS. It returns `{ pairingCode, expiresAt }`, with a ten-minute, single-use secret in the code’s URL fragment. Only one outstanding code per issuer is retained. The browser cannot issue library or vault access through this route.

`POST /reading/shortcut-exchange` accepts `{ token }` without a bearer credential. The Shortcut strips the fragment locally and sends it only in this body. Atomic redemption rechecks the issuer, policy, folder and generation and returns `{ endpoint, authorization }` for a new capture-only token. Its expiry is the earlier of 90 days and the issuer’s expiry. Replay, expiry, issuer revocation or a changed policy generation returns 410. A lost reply requires a new code. Both routes require the normal mutation protocol header, have separate per-minute action limits, and return `Cache-Control: no-store`. Grant hashes use existing `reading_enrollments` rows with scope `reading_capture:<issuer-id>`; normal library/install exchanges reject this scope.
