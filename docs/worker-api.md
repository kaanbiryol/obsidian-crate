# Worker API

The worker is deployed via the Cloudflare API (not Wrangler). Source is embedded as a template string in `src/cloudflare/worker-template.ts` (plugin) and `packages/cli/src/worker-template.ts` (CLI). **Both must be kept in sync.**

## Authentication

All endpoints require `Authorization: Bearer <token>` header. The worker validates the token in two steps:

1. Hash the bearer token with SHA-256 and look up the hash in the `auth_tokens` D1 table
2. If not found, fall back to timing-safe comparison against the `AUTH_TOKEN` secret binding

This allows multiple devices to have independent tokens stored in D1, while maintaining backward compatibility with the single-token binding. CORS headers are included on all responses.

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
| `POST` | `/auth/tokens` | Register a per-device auth token `{ token_hash, device_name? }` |
| `DELETE` | `/auth/tokens` | Revoke an auth token `{ id }` |
| `GET` | `/auth/tokens` | List all registered auth tokens |
| `GET` | `/settings` | Get shared settings from R2 |
| `PUT` | `/settings` | Store shared settings to R2 |
| `POST` | `/reminders/schedule` | Schedule a DO alarm for a reminder |
| `DELETE` | `/reminders/cancel` | Cancel a DO alarm |
| `GET` | `/reminders/scheduled` | List scheduled reminders from D1 |

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

Register a per-device auth token. The token hash (SHA-256 hex) is stored in D1 - the plaintext token is never persisted.

Request: `{ token_hash: "<sha256-hex>", device_name?: "optional label" }`

Response: `{ id: "<uuid>" }`

### DELETE /auth/tokens

Revoke a token by its ID.

Request: `{ id: "<uuid>" }`

Response: `{ success: true }`

### GET /auth/tokens

List all registered tokens (does not expose hashes).

Response: `{ tokens: [{ id, device_name, created_at }] }`

### GET /settings

Returns shared plugin preferences stored in R2 as `__crate__/settings.json`. Used by second devices to inherit settings during setup.

Response: `{ settings: { ignorePatterns, syncOnStartup, syncInterval, showStatusBar } }` or `{ settings: null }` if not yet stored.

### PUT /settings

Stores shared plugin preferences to R2.

Request: `{ settings: { ignorePatterns: [...], syncOnStartup: true, syncInterval: 300, showStatusBar: true } }`

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
  "ntfyTopic": "my-topic",
  "priority": 3
}
```

`project` and `priority` are optional. `priority` maps to ntfy.sh priority levels (1-5, default 3).

Response: `{ success: true }`

### DELETE /reminders/cancel

Cancel a scheduled reminder's DO alarm and remove from D1.

Request: `{ "reminderId": "unique-id" }`

Response: `{ success: true }`

### GET /reminders/scheduled

List all currently scheduled reminders.

Response: `{ scheduled: [{ reminder_id, content, project, due_datetime, ntfy_topic, created_at }] }`

## ReminderAlarm Durable Object

Exported class `ReminderAlarm` from the worker template. Each reminder gets its own DO instance keyed by `reminderId`. When the alarm fires, the DO POSTs to `ntfy.sh/{topic}` with the reminder content and priority, then deletes itself from D1.

Requires a `durable_object_namespace` binding (`REMINDER_ALARMS`) and migration metadata on deploy.

## D1 Database Schema

Four tables, created lazily via `initDb()`:

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
  modified TEXT NOT NULL DEFAULT (datetime('now'))
);
```

D1-backed remote manifest. Updated atomically with changelog entries via `db.batch()`.

### auth_tokens

```sql
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Per-device auth tokens. Token hashes are SHA-256 hex of the bearer token. Used for multi-device support - each device gets its own token that can be independently revoked.

### scheduled_reminders

```sql
CREATE TABLE IF NOT EXISTS scheduled_reminders (
  reminder_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  project TEXT,
  due_datetime TEXT NOT NULL,
  ntfy_topic TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Stores metadata for scheduled reminder alarms. Rows are inserted on `POST /reminders/schedule` and deleted when the DO alarm fires or `DELETE /reminders/cancel` is called.

## R2 Key Convention

All file objects stored under `files/` prefix: `files/<vault-path>`

## Path Sanitization

`sanitizePath()` rejects null bytes, resolves `..` and `.` segments, strips empty segments. Returns null for invalid paths.

## Changelog Pruning

5% random chance after each write operation. Deletes entries older than 30 days (`CHANGELOG_RETENTION_DAYS`). Non-fatal - errors are silently caught.

When a client's `since` cursor points to pruned entries, the `cursorExpired` flag is returned so the plugin falls back to full sync.

## Bindings Table

See `docs/architecture.md` for the full bindings table. When adding new bindings, update both:
1. `packages/cli/src/commands/init.ts` - `deployWorker()` (fresh installs)
2. `packages/cli/src/cloudflare/api.ts` - `redeployWorker()` `keep_bindings` (code-only redeploys)
