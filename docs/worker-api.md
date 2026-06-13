# Worker API

The Worker is deployed via the Cloudflare API (not Wrangler). Source lives in `src/cloudflare/worker/`; `scripts/build-worker.mjs` bundles it and `vite.config.mts` injects the generated script into `src/cloudflare/worker-template.ts`.

## Authentication

All non-public API endpoints require an `Authorization: Bearer <token>` header. The Worker validates the token in two steps:

1. Hash the bearer token with SHA-256 and look up the hash in the `auth_tokens` D1 table
2. If not found, fall back to timing-safe comparison against the `AUTH_TOKEN` secret binding

This allows multiple devices to have independent tokens stored in D1, while maintaining backward compatibility with the single-token binding. Public PWA assets and enrollment-exchange endpoints are listed separately below. CORS headers are included on all JSON/API responses.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check, returns `{ status, timestamp }` |
| `GET` | `/sync/check?since=<seq>` | Lightweight check: are there changes since this sequence? |
| `GET` | `/sync/changes?since=<seq>` | Paginated changelog entries (limit 5000 per page) |
| `GET` | `/sync/manifest` | Full remote manifest (gzip-compressed if accepted) |
| `PUT` | `/sync/upload?path=<path>` | Upload single file (binary body, streaming to R2) |
| `GET` | `/sync/download?path=<path>` | Download single file (streaming from R2) |
| `POST` | `/sync/delete` | Delete single file `{ path }` |
| `POST` | `/sync/batch-upload` | Batch upload `{ files: [...] }` (max 50 files, 10 MB total) |
| `POST` | `/sync/batch-download` | Batch download `{ paths: [...] }` (max 50 paths) |
| `POST` | `/sync/batch-delete` | Batch delete `{ paths: [...] }` (max 50 paths) |
| `GET` | `/sync/config` | Returns `{ accountId, workerName, bucketName, databaseId }` |
| `POST` | `/auth/tokens` | Register or refresh a per-device auth token `{ token_hash, device_id?, device_name?, platform? }` |
| `DELETE` | `/auth/tokens` | Revoke an auth token `{ id }` |
| `GET` | `/auth/tokens` | List all registered auth tokens |
| `GET` | `/settings` | Get shared settings from R2 |
| `PUT` | `/settings` | Store shared settings to R2 |
| `GET` | `/reminders/list?folderPath=<path>` | List reminders and projects from synced Markdown files |
| `POST` | `/reminders/create` | Create a reminder in a project Markdown file |
| `POST` | `/reminders/update` | Update or move a reminder |
| `POST` | `/reminders/set-completed` | Toggle reminder completion |
| `DELETE` | `/reminders/delete` | Delete a reminder from Markdown |
| `POST` | `/reminders/reorder` | Reorder reminders inside a project file |
| `POST` | `/reminders/schedule` | Schedule a DO alarm for a reminder |
| `DELETE` | `/reminders/cancel` | Cancel a DO alarm |
| `GET` | `/reminders/scheduled` | List scheduled reminders from D1 |
| `POST` | `/notifications/enrollment-token` | Create a one-time push subscription token |
| `POST` | `/notifications/reminders-enrollment-token` | Create a one-time reminders web app token |
| `POST` | `/notifications/subscribe` | Save a push subscription |
| `DELETE` | `/notifications/subscribe` | Remove a push subscription |
| `GET` | `/notifications/subscriptions` | List push subscriptions |
| `POST` | `/notifications/test` | Send a test push notification |

## Public PWA Endpoints

| Method | Path | Purpose |
|---|---|---|
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
- Headers: `X-File-Hash`, `X-File-Size`, `Content-Type`
- Body: raw binary (streamed directly to R2, zero memory buffering)
- Response: `{ success, path, hash }`

### GET /sync/download

- Query: `?path=<url-encoded-path>`
- Response headers: `Content-Type`, `Content-Length`, `X-File-Hash`
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
      "contentType": "text/markdown"
    }
  ]
}
```

Worker validates: max 50 files, total decoded content <= 10 MB.

Response: `{ success, results: [{ path, success, hash?, error? }] }`

### POST /sync/batch-download

Request: `{ paths: ["notes/file.md", ...] }` (max 50)

Response: `{ files: [{ path, content, hash, size, contentType, error? }] }`

Content is base64-encoded.

### POST /sync/delete / batch-delete

Single: `{ path: "notes/file.md" }` -> `{ success, path }`

Batch: `{ paths: [...] }` (max 50) -> `{ success, deleted: [...] }`

### GET /sync/check

Query: `?since=<seq>`

Response: `{ lastSeq, hasChanges, cursorExpired? }`

`cursorExpired` is true when `since` points to a pruned changelog region, signaling the client should fall back to full sync.

### GET /sync/changes

Query: `?since=<seq>`

Response: `{ changes: [...], lastSeq, hasMore, cursorExpired? }`

Paginated at 5000 entries. Client loops until `hasMore` is false.

### GET /sync/manifest

Response (gzip-compressed when `Accept-Encoding: gzip`):
```json
{
  "version": 1,
  "files": {
    "path": { "hash": "...", "size": 1024, "modified": "datetime" }
  },
  "lastSeq": 42
}
```

### POST /auth/tokens

Register or refresh a per-device auth token. The token hash (SHA-256 hex) is stored in D1 - the plaintext token is never persisted.

Request: `{ token_hash: "<sha256-hex>", device_id?: "device-abc123", device_name?: "Mac (abc1)", platform?: "macos" }`

Response: `{ id: "<uuid>" }`

### DELETE /auth/tokens

Revoke a token by its ID.

Request: `{ id: "<uuid>" }`

Response: `{ success: true }`

### GET /auth/tokens

List all registered tokens (does not expose hashes). The current token is marked with `is_current`.

Response: `{ tokens: [{ id, device_id, device_name, platform, created_at, last_seen_at, is_current }] }`

### GET /settings

Returns shared plugin preferences stored in R2 as `__crate__/settings.json`. Used by second devices to inherit settings during setup.

Response: `{ settings: { ignorePatterns, syncOnStartup, syncOnResume, syncInterval, showStatusBar, pushEnabled } }` or `{ settings: null }` if not yet stored or corrupt.

### PUT /settings

Stores shared plugin preferences to R2.

Request: `{ settings: { ignorePatterns: [...], syncOnStartup: true, syncOnResume: true, syncInterval: 300, showStatusBar: true, pushEnabled: false } }`

Response: `{ success: true }`

### GET /reminders/list

Query: `?folderPath=<reminders-folder>`

Reads synced Markdown reminder files from the configured folder and returns web-ready reminder records plus known projects.

Response: `{ reminders: [...], projects: [...] }`

### POST /reminders/create

Creates a reminder in the selected project Markdown file, creating that file if needed.

Request includes `folderPath`, `content`, optional `project`, `description`, `priority`, `dueDate`, `dueDatetime`, `recurrence`, `allDayNotificationTime`, and optional client-provided `id`.

Response: `{ success: true, notificationWarning? }`

### POST /reminders/update

Updates an existing reminder by `id`. The request includes `folderPath` and any mutable reminder fields: `content`, `description`, `priority`, `project`, `dueDate`, `dueDatetime`, `recurrence`, and `allDayNotificationTime`.

If `project` changes, the worker removes the reminder from the old project file and creates it in the new project file.

Response: `{ success: true, notificationWarning? }`

### POST /reminders/set-completed

Request: `{ folderPath, id, completed, allDayNotificationTime? }`

Response: `{ success: true, notificationWarning? }`

### DELETE /reminders/delete

Request: `{ folderPath, id, allDayNotificationTime? }`

Response: `{ success: true, notificationWarning? }`

### POST /reminders/reorder

Request: `{ folderPath, project, orderedIds }`

Response: `{ success: true }`

### POST /reminders/schedule

Schedule a Durable Object alarm for a reminder. Creates or updates the alarm and stores metadata in D1.

Request:
```json
{
  "reminderId": "unique-id",
  "content": "Reminder text",
  "project": "optional project name",
  "dueDatetime": "2026-03-22T14:00:00Z",
  "priority": 3
}
```

`project` and `priority` are optional.

Response: `{ success: true }`

### DELETE /reminders/cancel

Cancel a scheduled reminder's DO alarm and remove from D1.

Request: `{ "reminderId": "unique-id" }`

Response: `{ success: true }`

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

Authenticated. Creates a short-lived, one-time token used in `/notifications?token=...` reminders app links.

Response: `{ token, expiresAt }`

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

Requires a `durable_object_namespace` binding (`REMINDER_ALARMS`) and migration metadata on deploy.

## D1 Database Schema

Eight tables, created lazily via `initDb()`:

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
  hash     TEXT NOT NULL DEFAULT '',
  size     INTEGER NOT NULL DEFAULT 0,
  modified TEXT NOT NULL DEFAULT (datetime('now')),
  storage_key TEXT
);
```

D1-backed remote manifest. Updated atomically with changelog entries via `db.batch()`. `storage_key` points at the committed R2 blob for the path, so D1 is the visibility boundary even if best-effort R2 cleanup later fails.

### auth_tokens

```sql
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  device_name TEXT,
  platform TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
```

Per-device auth tokens. Token hashes are SHA-256 hex of the bearer token. Used for multi-device support - each device gets its own token that can be independently revoked. Device metadata is updated when a plugin instance comes online, and `last_seen_at` is refreshed periodically while that token is actively used.

### scheduled_reminders

```sql
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  reminder_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  project TEXT,
  due_datetime TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Stores metadata for scheduled reminder alarms. Rows are inserted on `POST /reminders/schedule` and deleted when the DO alarm fires or `DELETE /reminders/cancel` is called.

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Web Push subscriptions. Each subscribed device gets a row. Expired subscriptions (404/410 on push send) are automatically pruned.

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

One-time, short-lived tokens embedded in reminders PWA setup links. `POST /notifications/reminders-exchange` consumes one token and creates a per-device auth token.

## R2 Key Convention

With D1 enabled, committed file blobs are stored under `__crate__/files/<hash>/<uuid>` and referenced through `files.storage_key`. Legacy rows without `storage_key` still fall back to `files/<vault-path>`. When D1 is unavailable entirely, uploads/downloads continue to use the legacy `files/<vault-path>` layout.

## Path Sanitization

`sanitizePath()` rejects null bytes, resolves `..` and `.` segments, strips empty segments. Returns null for invalid paths.

## Changelog Pruning

5% random chance after each write operation. Deletes entries older than 30 days (`CHANGELOG_RETENTION_DAYS`). Non-fatal - errors are silently caught.

When a client's `since` cursor points to pruned entries, the `cursorExpired` flag is returned so the plugin falls back to full sync.

## Bindings Table

See `docs/architecture.md` for the full bindings table. When adding new bindings, update `src/cloudflare/api-deploy.ts` in both `deployWorker()` metadata and `redeployWorker()` `keep_bindings`.
