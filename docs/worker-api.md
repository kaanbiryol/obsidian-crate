# Worker API

The worker is deployed via the Cloudflare API (not Wrangler). Source is embedded as a template string in `src/cloudflare/worker-template.ts` (plugin) and `packages/cli/src/worker-template.ts` (CLI). **Both must be kept in sync.**

## Authentication

All endpoints require `Authorization: Bearer <token>` header. The worker validates against its `AUTH_TOKEN` secret binding. CORS headers are included on all responses.

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

## D1 Database Schema

Two tables, created lazily via `initDb()`:

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
