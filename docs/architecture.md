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
│  │ R2 Bucket│  │ D1 (SQL) │  │ Durable Objects   │   │
│  │ (files)  │  │ metadata │  │ setup + reminders │   │
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
| **Cloudflare OAuth deployment** | Uses PKCE in Obsidian to provision build-time Worker and migration artifacts, then revokes the temporary token |
| **Static GitHub Pages callback** | Removes OAuth parameters and hands the response to Obsidian; has no backend, analytics, or token exchange |
| **OS Keychain** | Stores auth tokens via Obsidian's `secretStorage` API |

## Worker Bindings

| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 Bucket | File storage |
| `DB` | D1 Database | Changelog + file manifest |
| `REMINDER_ALARMS` | Durable Object Namespace | Reminder alarm DOs |
| `SETUP` | Durable Object Namespace | Atomic initial claim and one-time device enrollment state |

An optional legacy `AUTH_TOKEN` binding is still accepted as an authentication fallback, but new deployments use only per-device D1 tokens.

## Component Ownership

```
CratePlugin (src/plugin/CratePlugin.ts)
  ├── SecretStorageService   - OS keychain wrapper
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

### Cloudflare deployment

1. The plugin creates a cryptographically random OAuth `state` and a fresh PKCE S256 verifier/challenge in memory.
2. Cloudflare redirects to `https://crate.kaanbiryol.com/oauth/callback/`. The static page immediately clears its query string and opens the `crate-cloudflare-oauth` Obsidian protocol.
3. The plugin verifies `state` before exchanging the authorization code. The access token is held only in a local stack frame.
4. The plugin uses the selected account to create or reuse D1 and R2, apply hash-tracked SQL migrations, upload the embedded Worker with declarative Durable Object bindings, and enable workers.dev.
5. The token is revoked and discarded before the Worker claim page opens. Only non-secret resource identifiers remain in plugin settings for retries and updates.

### First-device setup

1. Cloudflare deploys the Worker and provisions its R2, D1, and Durable Object bindings from `wrangler.jsonc`.
2. The browser claim page generates a 256-bit enrollment token locally and sends only its SHA-256 hash to the `SetupCoordinator` Durable Object.
3. The Durable Object serializes claim requests. A pending initial claim expires after 10 minutes; if no device was registered, the deployment becomes claimable again.
4. Obsidian receives the short-lived token through the `crate-setup` protocol, validates the server metadata and `enrollment-v1` capability, then generates a different permanent device secret locally.
5. `POST /setup/enroll` consumes the one-time enrollment token and stores only the permanent device secret's hash in D1.

### Worker Authentication

Authenticated requests carry a Bearer token in the `Authorization` header. The Worker hashes the bearer token and checks the `auth_tokens` D1 table. If no D1 token matches, it can fall back to a timing-safe comparison against an optional legacy `AUTH_TOKEN` secret binding.

An authenticated device creates additional-device links by registering a new short-lived enrollment hash at `POST /auth/enrollment`. Creating a replacement link invalidates the previous pending link. Permanent device secrets never appear in setup URLs.

Push-notification device enrollment is intentionally narrower: the plugin mints a short-lived, one-time push enrollment token from the worker and the notification PWA uses that scoped token only for `POST /notifications/subscribe`.

The reminders web app uses a separate short-lived web enrollment token in the `/notifications?token=...` link. The PWA exchanges it once at `POST /notifications/reminders-exchange` for its own per-device bearer token, stored locally by the browser.

## Secret Storage

The plugin stores two local values through `SecretStorageService`:

| Key | Value |
|---|---|
| `crate-auth-token` | Bearer token for worker authentication |
| `crate-device-id` | Local device identity; kept out of vault-synced settings |

**Convention:** Obsidian's `secretStorage` has no delete method. The plugin writes empty string to "delete" and treats empty strings as null on read.

**Type augmentation:** Obsidian's types package doesn't include `secretStorage`. The module augmentation (`declare module 'obsidian'`) lives in `src/plugin/secret-storage.ts`.

## Worker and PWA build

The Worker source lives in `src/cloudflare/worker/`. `scripts/build-worker.mjs` builds the PWA client first, injects that bundle into the Worker build, and writes the deployable module to `.generated/cloudflare/worker.mjs`.

The Worker remains an independently deployable build product, but the production plugin also includes a gzip-compressed copy of `.generated/cloudflare/worker.mjs` and every ordered SQL file in `migrations/`. The Vite artifact plugin computes SHA-256 hashes at build time; Obsidian verifies them after decompression before deployment. No Worker code or migration is fetched from the network at runtime.

`npm run release:check` enforces Worker and combined-plugin size budgets and checks that both the OAuth entry point and documented GitHub deploy fallback remain present.

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
