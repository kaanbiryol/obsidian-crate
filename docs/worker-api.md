# Worker API

Source lives in `src/cloudflare/worker/`; `scripts/build-worker.mjs` writes the deployable module to `.generated/cloudflare/worker.mjs`. The Vite production build embeds a compressed, hashed copy of that generated module for the in-plugin OAuth deployment.

Every mutation requires `X-Crate-Protocol: 3`; check `/.well-known/crate` before writing. Missing/incompatible protocols receive 428. POST metadata and batch-download requests are reads. See [the protocol contract](protocol.md) for retry, revision, migration, and notification guarantees. Responses carry `X-Crate-Request-Id` for diagnostics.

## Authentication

All non-public API endpoints require an `Authorization: Bearer <token>` header. Tokens have either `vault` or `reminders` scope, and may have an expiry. The Worker hashes the bearer token with SHA-256 and looks up the hash in the `auth_tokens` D1 table. Authentication fails closed with `503` when D1 is unavailable.

Vault device tokens are registered only through a temporary Cloudflare OAuth authorization; the Worker exposes no public or device-authorized vault-enrollment endpoint. PWA exchanges create 90-day `reminders` tokens bound to the enrolled folder. Unbound legacy sessions must enroll again. These tokens cannot call sync, settings, device-management, scheduled-reminder, or push-administration routes. Public compatibility, PWA assets, and reminder-enrollment endpoints are listed separately below. CORS headers are included on all JSON/API responses.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/crate` | Public service, version, protocol range, and capability metadata |
| `GET` | `/health` | Health check, returns `{ status, timestamp }` |
| `GET` | `/sync/check?since=<seq>` | Lightweight check: are there changes since this sequence? |
| `GET` | `/sync/changes?since=<seq>` | Paginated changelog entries (limit 5000 per page) |
| `GET` | `/sync/manifest?limit=<n>&after=<path>&snapshotSeq=<seq>` | Stable, cursor-paginated remote manifest |
| `POST` | `/sync/metadata` | Fetch current metadata for up to 50 selected paths |
| `PUT` | `/sync/upload?path=<path>` | Upload one conditionally-versioned file (binary body, max 25 MB) |
| `GET` | `/sync/download?path=<path>` | Download single file (streaming from R2) |
| `POST` | `/sync/delete` | Delete single file with expected hash and revision |
| `POST` | `/sync/batch-upload` | Batch upload `{ files: [...] }` (max 5 files, 10 MiB total) |
| `POST` | `/sync/batch-download` | Batch download `{ paths: [...] }` (max 50 paths and 8 MB decoded) |
| `POST` | `/sync/batch-delete` | Conditional batch delete `{ files: [...] }` (max 6 files) |
| `GET` | `/sync/versions?path=<path>` | List unexpired recoverable file versions |
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
| `POST` | `/reminders/schedule` | Retired; returns 410 |
| `DELETE` | `/reminders/cancel` | Retired; returns 410 |
| `GET` | `/reminders/scheduled` | List scheduled reminders from D1 |
| `POST` | `/notifications/enrollment-token` | Create a one-time push subscription token |
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
| `POST` | `/notifications/subscribe` | Saves a push subscription when `X-Crate-Enrollment-Token` is present |

## Request/Response Details

### PUT /sync/upload

- Query: `?path=<url-encoded-path>`
- Headers: `X-File-Hash`, `X-File-Size`, `X-Crate-Expected-Hash`, `Content-Type`
- `X-Crate-Expected-Hash` is the 64-character remote hash observed while planning, or `absent` for a new path
- Body: raw binary, consumed incrementally with a hard 25 MB cap; oversized declared or chunked requests stop before the remainder is buffered
- Response: `{ success, path, hash, revision }`
- A stale expected hash returns `409` with `{ success: false, path, error, code: "version_conflict", currentHash }` and does not replace the committed object

### GET /sync/download

- Query: `?path=<url-encoded-path>`
- Response headers: `Content-Type`, `Content-Length`, `X-File-Hash`, `X-Crate-Revision`
- Body: raw binary (streamed from R2)

### POST /sync/batch-upload

```json
{
  "files": [
    {
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

Worker validates: max 5 files, total decoded content <= 10 MiB. Mutation batches are deliberately smaller than download batches to stay within Workers Free D1 query limits even on stale-write cleanup paths.

Response: `{ success, results: [{ path, success, hash?, revision?, error?, code?, status?, currentHash? }] }`. A stale per-file write uses `code: "version_conflict"`, `status: 409`, and the current remote hash; storage failures use `code: "storage"` and `status: 503`.

### POST /sync/batch-download

Request: `{ paths: ["notes/file.md", ...] }` (max 50, no duplicates)

Response: `{ files: [{ path, content, hash, size, contentType, revision, error? }] }`

Content is base64-encoded. The Worker rejects a batch before reading R2 if D1 metadata shows that it exceeds 8 MB. The client batches only files smaller than 1 MB, validates the exact response path set, size, and SHA-256 hash, and falls back to individual streaming downloads when a batch is too large or unavailable.

### POST /sync/delete / batch-delete

Single: `{ path: "notes/file.md", expectedHash: "sha256...", expectedRevision: "opaque-key" }` -> `{ success, path }`

Batch: `{ files: [{ path, expectedHash, expectedRevision }, ...] }` (max 6) -> `{ success, deleted: [...], errors?: [{ path, error, code?, status?, currentHash? }] }`

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

Request includes a UUID `operationId`, `folderPath`, `content`, optional `project`, `description`, `priority`, `dueDate`, `dueDatetime`, `recurrence`, `allDayNotificationTime`, and optional client-provided `id`.

Response: `{ success: true, notificationWarning? }`

### POST /reminders/update

Updates an existing reminder by `id`. The request requires a UUID `operationId`, `expectedRevision`, `folderPath`, and the reminder's original `filePath`, plus any mutable reminder fields: `content`, `description`, `priority`, `project`, `dueDate`, `dueDatetime`, `recurrence`, and `allDayNotificationTime`.

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

### POST /reminders/schedule and DELETE /reminders/cancel

Both return 410. Schedules derive from committed Markdown and the shared notification policy. File commits enqueue projection intent in the same D1 transaction. The Durable Object coordinator drains at most three files and five outbox jobs per alarm, fences stale work with file/policy/job revisions, and rearms while work remains. Maintenance recovers missed wakeups.

### GET /reminders/scheduled

List all currently scheduled reminders.

Response: `{ scheduled: [{ reminder_id, content, project, due_datetime, created_at }] }`

## Notifications and PWA Endpoints

### GET /notifications (public)

Serves the reminders PWA HTML page. The plugin generates short-lived links with query params such as `token`, `folder`, `upcomingDays`, `allDayTime`, `project`, `tab`, and `reminderId`.

The `token` query parameter is a web enrollment token, not a sync bearer token.

### GET /notifications/app.js, /sw.js, /manifest.json, /version.json, /icon.svg, /open-obsidian (public)

Serve the PWA client bundle, service worker, manifest, version metadata, icon, and Obsidian handoff page. Versioned static assets use long-lived cache headers when a `v` query param is present.

### GET /notifications/vapid-public-key (public)

Returns the VAPID public key, lazily generated and stored in D1.

Response: `{ publicKey: "base64url-encoded-key" }`

### POST /notifications/reminders-exchange (public)

Consumes a one-time web enrollment token and creates a per-device PWA auth token in `auth_tokens`.

Request: `{ token, deviceName? }`

Response: `{ authToken }`

### POST /notifications/enrollment-token

Authenticated. Creates a short-lived, one-time token used only to save a push subscription without exposing the PWA bearer token to the subscription URL flow.

Response: `{ token, expiresAt }`

### POST /notifications/reminders-enrollment-token

Vault-token authenticated. Creates separate short-lived, one-time tokens for previewing a reminders app link in the browser and activating the installed app. Reminders web app tokens cannot mint replacement sessions. Keeping the install token unused by the browser prevents iOS from launching a Home Screen app with an already-consumed credential.

Response: `{ token, browserToken, expiresAt }`, where `token` is reserved for the installed app.

### POST /notifications/subscribe

Save a push subscription. This endpoint can be called as an authenticated request, or publicly when the `X-Crate-Enrollment-Token` header contains a valid one-time push enrollment token.

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

Exported class `ReminderAlarm` from the worker. Each reminder gets its own DO instance keyed by `reminderId`. When the alarm fires, the DO sends Web Push notifications to all subscribed devices via `web-push-browser`, then deletes itself from D1.

Requires a `durable_object_namespace` binding (`REMINDER_ALARMS`) and a declarative `exports.ReminderAlarm` entry with SQLite storage on deploy.

## D1 Database Schema

Fourteen tables are initialized from `src/cloudflare/schema.sql` before the Worker is uploaded. Future upgrades are recorded in `d1_migrations`, checked statement-by-statement, and applied before the new Worker bundle:

### d1_migrations

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

Tracks the initial schema baseline and each later ordered SQL upgrade.

### changelog

```sql
CREATE TABLE IF NOT EXISTS changelog (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,
  action     TEXT NOT NULL,        -- 'put' or 'delete'
  hash       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Every upload or deletion inserts a row. `seq` is the cursor for incremental sync.

### files

```sql
CREATE TABLE IF NOT EXISTS files (
  path     TEXT PRIMARY KEY,
  portable_path TEXT NOT NULL,
  hash     TEXT NOT NULL DEFAULT '',
  size     INTEGER NOT NULL DEFAULT 0,
  modified TEXT NOT NULL DEFAULT (datetime('now')),
  storage_key TEXT NOT NULL
);
```

D1-backed remote manifest. `portable_path` is a unique normalized key that prevents case and Unicode collisions across supported filesystems. Rows are updated atomically with changelog entries via `db.batch()`. `storage_key` points at the committed R2 blob for the path, so D1 is the visibility boundary.

### reminder_file_cache

```sql
CREATE TABLE IF NOT EXISTS reminder_file_cache (
  folder_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  reminders_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (folder_path, file_path)
);
```

Stores parsed reminder records for each Markdown file and reminders-folder context. Cache entries are accepted only when both the file hash and parser version match. Writes are conditional on the current `files` row, preventing a stale parse from replacing data for a newer committed file.

### auth_tokens

```sql
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  device_name TEXT,
  platform TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  scope TEXT NOT NULL DEFAULT 'vault' CHECK (scope IN ('vault', 'reminders')),
  expires_at INTEGER
);
```

Per-device auth tokens. Token hashes are SHA-256 hex of the bearer token. Vault device tokens have `vault` scope and no default expiry. Reminders PWA tokens have `reminders` scope and expire after 90 days. Device metadata is updated when a plugin instance comes online, and `last_seen_at` is refreshed periodically while that token is actively used.

### scheduled_reminders

```sql
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  reminder_id TEXT PRIMARY KEY,
  schedule_token TEXT NOT NULL,
  content TEXT NOT NULL,
  project TEXT,
  due_datetime TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Stores derived alarm metadata. The server projection/outbox updates these rows using schedule-token preconditions. Delivery waits until the source projection is current; clients cannot schedule alarms directly.

### vapid_keys

```sql
CREATE TABLE IF NOT EXISTS vapid_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Single-row table storing the VAPID ECDSA P-256 key pair (base64url-encoded). Lazily generated on first push subscription.

### push_subscriptions

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT,
  last_error TEXT
);
```

Web Push subscriptions. Expired subscriptions (404/410) are pruned, transient statuses retry with bounded alarm backoff, and permanent failures are quarantined with their last error instead of retrying forever.

### push_enrollment_tokens

```sql
CREATE TABLE IF NOT EXISTS push_enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One-time, short-lived tokens that allow `POST /notifications/subscribe` without exposing a long-lived bearer token in the subscription flow.

### web_enrollment_tokens

```sql
CREATE TABLE IF NOT EXISTS web_enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One-time, short-lived tokens embedded in reminders PWA setup links. Each link contains separate browser and install tokens. `POST /notifications/reminders-exchange` consumes one token and creates a scoped, expiring PWA auth token that cannot access vault sync APIs.

### object_cleanup_queue

```sql
CREATE TABLE IF NOT EXISTS object_cleanup_queue (
  storage_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Retry queue for R2 objects whose best-effort deletion failed after their D1 metadata mutation committed.

### file_versions, notification_jobs, and maintenance_state

`file_versions` retains replaced and deleted objects for 30 days and supports integrity-checked recovery. `notification_jobs` is a durable schedule/cancel outbox generated from committed Markdown, including vault sync writes. Failed Durable Object calls retry with a token identifying the intended schedule. `maintenance_state` stores the R2 sweep cursor plus the last maintenance run and error for diagnostics.

### Protocol 3 schema additions

The SQL excerpts above describe the main tables; the complete schema and ordered migrations in `src/cloudflare/` are authoritative. Protocol 3 adds:

- `reminder_operations` and `reminder_identities` for transactional retry receipts and permanently reserved creation IDs.
- `changelog.revision` for opaque file incarnations.
- `notification_policy`, `notification_projection_jobs`, and `reminder_projections` for server-owned schedules and commit fencing.
- Folder bindings in `auth_tokens` and `web_enrollment_tokens`; owner/folder fields and unique endpoints in `push_subscriptions`.
- `request_rate_limits` for atomic per-address/route budgets.

Reminder mutations replay a matching operation receipt before rereading a moved or deleted source; a different payload under the same operation ID returns 409. Notification time comes from the saved server policy; the legacy `allDayNotificationTime` mutation field cannot replace it. Successful create/update/completion responses include the acknowledged `reminder` and its new revision.

Subscriptions are limited to 20 total and five per owner. Logout/expiry removes owned subscriptions. Endpoint hosts must match supported push providers, redirects are rejected, and network calls have ten-second deadlines. Notification writes return 429 with `Retry-After` when their per-address/route budget is exhausted.

## R2 Key Convention

Committed file blobs are stored under `__crate__/files/<hash>/<uuid>` and referenced through the required `files.storage_key`. D1 is required for every sync transfer; the Worker returns `503` instead of accepting an untracked R2 mutation when the database binding is unavailable.

The 15-minute maintenance trigger expires retained versions, drains object cleanup and notification jobs, prunes expired tokens and changelog rows, and incrementally sweeps unreferenced managed R2 objects older than 24 hours. The OAuth provisioner applies the initial schema and configures that trigger before enabling the Worker; request cold starts do not execute schema DDL.

## Path Sanitization

`sanitizePath()` rejects null bytes, traversal, empty segments, backslashes, Windows-reserved names and characters, and trailing dots/spaces. A normalized unique D1 key additionally prevents case-insensitive and Unicode-normalizing collisions.

## Changelog Pruning

The 15-minute maintenance Cron Trigger deletes entries older than 30 days (`CHANGELOG_RETENTION_DAYS`). Failures are non-fatal and retried on the next scheduled run.

When a client's `since` cursor points to pruned entries, the `cursorExpired` flag is returned so the plugin falls back to full sync.

## Bindings Table

See `docs/architecture.md` for the full bindings table. When adding new bindings, update the Worker upload metadata in `src/cloudflare/cloudflare-api.ts` and the deployment flow in `src/cloudflare/provisioner.ts`.
