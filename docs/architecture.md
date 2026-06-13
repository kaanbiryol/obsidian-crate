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
│  │ R2 Bucket│  │ D1 (SQL) │  │ Auth Tokens       │   │
│  │ (files)  │  │ metadata │  │ + fallback secret  │   │
│  │          │  │ + tokens │  │                   │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**Design philosophy:** sync intelligence (change detection, conflict resolution, batching) lives in the plugin. The Worker stores files, exposes reminder web/PWA endpoints, and schedules push notifications, but does not decide sync plans.

## Infrastructure Stack

| Service | Role |
|---|---|
| **Cloudflare Worker** | HTTPS API - receives uploads, serves downloads, manages changelog, serves the reminders PWA |
| **Cloudflare R2** | Object storage for vault file content and shared settings |
| **Cloudflare D1** | SQLite database with sync metadata, auth tokens, push subscriptions, and reminder alarm records |
| **Cloudflare API token** | User-provided token for infrastructure setup and redeploys |
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

## Component Ownership

```
CratePlugin (src/plugin/CratePlugin.ts)
  ├── SecretStorageService   - OS keychain wrapper
  ├── CloudflareSessionManager - Cloudflare API token/account storage
  ├── CloudflareUsageService   - analytics via CF GraphQL API
  ├── CrateSettingTab          - settings UI (delegates to section modules)
  └── SyncRuntime (sync/runtime.ts) - lifecycle coordinator
        ├── SyncEngine (sync/engine.ts) - orchestrates sync operations
        │     uses: planner, transfer, queue, file-discovery, manifest
        ├── SyncApiClient (sync/api.ts) - HTTP calls to worker
        └── StatusBarManager (ui/status.ts) - status bar rendering
  ├── Reminder runtime (reminders/runtime.ts) - index/writer/storage/watcher setup
  ├── Reminder registrations (reminders/register-integrations.ts) - commands, code blocks, views
  ├── ReminderIndex (reminders/data/reminder-index/) - in-memory reminder index
  └── MarkdownWriter (reminders/data/markdown-writer/) - markdown CRUD for reminder lines
```

## Authentication

### Token-Based Setup

1. User creates a Cloudflare API token on the dashboard with permissions: Workers Scripts (Edit), Workers R2 Storage (Edit), D1 (Edit), Account Settings (Read)
2. Plugin verifies the token via `GET /user/tokens/verify`
3. Plugin lists accessible accounts via `GET /accounts`
4. User selects an account; credentials are saved (token in keychain, account ID in settings)

### Worker Authentication

Authenticated requests carry a Bearer token in the `Authorization` header. The Worker hashes the bearer token and checks the `auth_tokens` D1 table first. If no D1 token matches, it falls back to a timing-safe comparison against the `AUTH_TOKEN` secret binding for backward compatibility. The setup token is a 256-bit random hex string generated during infrastructure setup.

Push-notification device enrollment is intentionally narrower: the plugin mints a short-lived, one-time push enrollment token from the worker and the notification PWA uses that scoped token only for `POST /notifications/subscribe`.

The reminders web app uses a separate short-lived web enrollment token in the `/notifications?token=...` link. The PWA exchanges it once at `POST /notifications/reminders-exchange` for its own per-device bearer token, stored locally by the browser.

## Secret Storage

Two keys stored in OS keychain via `SecretStorageService`:

| Key | Value |
|---|---|
| `crate-auth-token` | Bearer token for worker authentication |
| `crate-cloudflare-api-token` | Cloudflare API token (user-created) |

**Convention:** Obsidian's `secretStorage` has no delete method. The plugin writes empty string to "delete" and treats empty strings as null on read.

**Type augmentation:** Obsidian's types package doesn't include `secretStorage`. The module augmentation (`declare module 'obsidian'`) lives in `src/plugin/secret-storage.ts`.

## Worker and PWA build

The Worker source lives in `src/cloudflare/worker/`. `scripts/build-worker.mjs` builds the PWA client first, injects that bundle into the Worker build, and writes generated artifacts under `.generated/cloudflare/`.

The Obsidian plugin bundle does not import generated TypeScript files. Instead, `vite.config.mts` reads `.generated/cloudflare/worker-script.json` and injects the Worker script into `src/cloudflare/worker-template.ts` through the `__CRATE_WORKER_SCRIPT__` build constant. Source modules have test-safe fallbacks so unit tests do not depend on ignored generated `.gen.ts` files.

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
5. Users open a short-lived `{workerUrl}/notifications?token=...` reminders app link generated by the authenticated plugin
6. The PWA exchanges that web enrollment token for a per-device bearer token, then requests a separate one-time push enrollment token when it subscribes for push
7. Push subscriptions are stored in D1; expired subscriptions (404/410) are pruned automatically
