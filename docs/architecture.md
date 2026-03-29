# Architecture

## Overview

```
┌──────────────────────────────────────────────────────┐
│                   Obsidian Vault                      │
│                                                      │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ SyncRuntime   │  │ StatusBar │  │ Settings Tab │  │
│  │  -> Engine    │  │   (UI)    │  │    (UI)      │  │
│  └──────┬───────┘  └───────────┘  └──────────────┘  │
│         │                                            │
│  ┌──────┴───────┐  ┌────────────────────────────┐   │
│  │ SyncApiClient │  │ SecretStorageService       │   │
│  │   (HTTP)      │  │ (OS Keychain)              │   │
│  └──────┬───────┘  └────────────────────────────┘   │
└─────────┼───────────────────────────────────────────┘
          │ HTTPS (Bearer Token)
          v
┌──────────────────────────────────────────────────────┐
│              Cloudflare Worker                        │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ R2 Bucket│  │ D1 (SQL) │  │ AUTH_TOKEN Secret │   │
│  │ (files)  │  │(changelog│  │  (verification)   │   │
│  │          │  │ + files)  │  │                   │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**Design philosophy:** all sync intelligence (change detection, conflict resolution, batching) lives in the plugin. The worker is a thin storage proxy.

## Infrastructure Stack

| Service | Role |
|---|---|
| **Cloudflare Worker** | HTTPS API - receives uploads, serves downloads, manages changelog |
| **Cloudflare R2** | Object storage for vault file content |
| **Cloudflare D1** | SQLite database with changelog + files tables |
| **Cloudflare OAuth** | PKCE-based authentication for infrastructure setup |
| **OS Keychain** | Stores auth tokens via Obsidian's `secretStorage` API |

## Worker Bindings

| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 Bucket | File storage |
| `DB` | D1 Database | Changelog + file manifest |
| `AUTH_TOKEN` | Secret | Request authentication |
| `CF_ACCOUNT_ID` | Plain Text | Account ID (exposed via `/sync/config`) |
| `CF_WORKER_NAME` | Plain Text | Worker name (exposed via `/sync/config`) |
| `CF_BUCKET_NAME` | Plain Text | Bucket name (exposed via `/sync/config`) |
| `CF_DATABASE_ID` | Plain Text | Database UUID (exposed via `/sync/config`) |
| `REMINDER_ALARMS` | Durable Object Namespace | Reminder alarm DOs |

Optional: `CF_ANALYTICS_TOKEN` (secret, set up via plugin settings).

## Component Ownership

```
CratePlugin (main.ts)
  ├── SecretStorageService   - OS keychain wrapper
  ├── CloudflareSessionManager - OAuth PKCE flow, token refresh
  ├── CloudflareUsageService   - analytics via CF GraphQL API
  ├── CrateSettingTab          - settings UI (delegates to section modules)
  └── SyncRuntime (sync/runtime.ts) - lifecycle coordinator
        ├── SyncEngine (sync/engine.ts) - orchestrates sync operations
        │     uses: planner, transfer, queue, file-discovery, manifest
        ├── SyncApiClient (sync/api.ts) - HTTP calls to worker
        └── StatusBarManager (ui/status.ts) - status bar rendering
  ├── ReminderScanner (reminders/scanner.ts) - vault file scanner for reminder metadata
  ├── ReminderIndex (reminders/index.ts) - in-memory reminder index
  └── ReminderWriter (reminders/writer.ts) - markdown CRUD for reminder fields
```

## Authentication

### OAuth 2.0 (Desktop - Infrastructure Setup)

1. Plugin generates PKCE code verifier + challenge
2. Opens browser to `dash.cloudflare.com/oauth2/auth`
3. Local HTTP server on port 8976 at `/oauth/callback`
4. Exchanges authorization code for access token via PKCE
5. Fetches account ID from Cloudflare API

**Scopes:** `account:read`, `user:read`, `workers:write`, `workers_scripts:write`, `d1:write`, `offline_access`

Access tokens are short-lived. Refresh token stored in keychain; auto-refreshed when within 60s of expiry.

### Worker Authentication

Every request carries a Bearer token in `Authorization` header. Worker verifies against `AUTH_TOKEN` secret binding. Token is a 256-bit random hex string generated during setup.

## Secret Storage

Four keys stored in OS keychain via `SecretStorageService`:

| Key | Value |
|---|---|
| `crate-auth-token` | Bearer token for worker authentication |
| `crate-analytics-token` | Cloudflare Analytics API token (optional) |
| `crate-cloudflare-api-token` | Cloudflare API access token (from OAuth) |
| `crate-cloudflare-refresh-token` | OAuth refresh token |

**Convention:** Obsidian's `secretStorage` has no delete method. The plugin writes empty string to "delete" and treats empty strings as null on read.

**Type augmentation:** Obsidian's types package doesn't include `secretStorage`. The module augmentation (`declare module 'obsidian'`) lives in `src/secret-storage.ts`.

## Status Bar

| State | Icon | Text |
|---|---|---|
| Synced | ✓ | "Synced" |
| Pending | ◐ | "{N} pending" |
| Never synced | ○ | "Not synced" |
| Syncing | ↻ | "Syncing {current}/{total}" |
| Error | ⚠ | "Sync error" |
| Offline | ○ | "Offline" |

Styling driven by `data-status` attribute on the status bar element, which CSS selectors use for spin animation and color changes.

## Reminders and Notifications

The plugin scans vault files for reminder metadata, maintains an in-memory index, and syncs due dates to the worker. Notifications are delivered via Web Push:

1. Plugin schedules a reminder by POSTing due date to the worker
2. Worker creates a Durable Object alarm (`ReminderAlarm`) set to fire at the due time
3. When the alarm fires, the DO sends Web Push notifications to all subscribed devices (using `web-push-browser` library)
4. Cancelled or updated reminders delete the existing DO alarm and reschedule if needed
5. Users subscribe devices by opening `{workerUrl}/notifications#{authToken}` - a minimal PWA served by the worker
6. Push subscriptions are stored in D1; expired subscriptions (404/410) are pruned automatically
