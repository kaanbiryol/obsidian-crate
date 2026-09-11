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
│  │ (files)  │  │ metadata │  │ reminder alarms   │   │
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
| **Cloudflare D1** | SQLite database with sync metadata, auth tokens, push subscriptions, reminder alarm records, and parsed reminder caches |
| **Cloudflare OAuth deployment** | Uses PKCE in Obsidian to provision the build-time Worker and initial schema, then revokes the temporary token |
| **Static GitHub Pages callback** | Removes OAuth parameters and hands the response to Obsidian; has no backend, analytics, or token exchange |
| **OS Keychain** | Stores auth tokens via Obsidian's `secretStorage` API |

## Worker Bindings

| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 Bucket | File storage |
| `DB` | D1 Database | Changelog, file manifest, authentication, subscriptions, and parsed reminder cache |
| `REMINDER_ALARMS` | Durable Object Namespace | Reminder alarm DOs |
| `NOTIFICATION_REQUEST_LIMITER` | Rate Limiting API | Limits notification requests per source before D1; authenticated action/day budgets preserve management availability |

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
  ├── Reminder runtime (reminders/runtime.ts) - index/writer/repository/watcher setup
  ├── Reminder registrations (reminders/register-integrations.ts) - commands, code blocks, views
  ├── ReminderIndex (reminders/data/reminder-index/) - in-memory reminder index
  └── MarkdownWriter (reminders/data/markdown-writer/) - markdown CRUD for reminder lines
```

## Authentication

### Cloudflare deployment

1. The plugin creates a cryptographically random OAuth `state` and a fresh PKCE S256 verifier/challenge in memory.
2. Cloudflare redirects to `https://crate.kaanbiryol.com/oauth/callback/`. The static page immediately clears its query string and opens the `crate-cloudflare-oauth` Obsidian protocol.
3. The plugin verifies `state` before exchanging the authorization code. The access token is held only in a local stack frame.
4. The plugin discovers Crate Workers in the selected account. Joining a saved or discovered deployment registers this device without uploading code or changing schema. Creating a deployment initializes the current schema; explicit updates require its schema marker before uploading code; request cold starts never mutate the schema. Updates reject an authoritative remote version newer than the installed artifact.
5. The plugin generates a permanent device secret locally and writes only its hash and device metadata to the deployment's D1 database using the temporary Cloudflare authorization.
6. The OAuth token is revoked and discarded. Only non-secret resource identifiers remain in plugin settings for reconnects and updates.

### Device authorization

Cloudflare account authorization is the sole authority for adding a vault-sync device. A fresh device signs in through OAuth, discovers matching `crate-<deployment-id>` Workers and their D1/R2 bindings, and chooses a server only when the account contains more than one. Crate then inserts or rotates that device's hashed bearer token directly through the Cloudflare D1 API.

Disconnecting locally preserves non-secret deployment metadata so reconnecting the same vault converges on the same Worker.

### Worker Authentication

Authenticated requests carry a Bearer token in the `Authorization` header. The Worker hashes the bearer token and checks the `auth_tokens` D1 table. Missing or expired tokens are rejected, and D1 failures return `503` without falling back to a second credential system.

Push subscriptions are created with an authenticated session and record that session as their owner.

The reminders web app uses a separate short-lived web enrollment token in the `/notifications?token=...` link. The PWA exchanges it once at `POST /notifications/reminders-exchange` for a 90-day, reminder-only bearer token stored locally by the browser. The token is bound to the exact enrolled reminders folder. Route and folder authorization prevent that token from reading or mutating the vault sync API, shared settings, device list, push administration, or enrollment-token API, so it cannot renew itself. Open a fresh link from the plugin after the session expires.

## Secret Storage

The plugin stores two local values through `SecretStorageService`:

| Key | Value |
|---|---|
| `crate-auth-token` | Bearer token for worker authentication |
| `crate-device-id` | Local device identity; kept out of vault-synced settings |

**Convention:** Obsidian's `secretStorage` has no delete method. The plugin writes empty string to "delete" and treats empty strings as null on read.

The service uses Obsidian's official `App.secretStorage` type and scopes the sync bearer token by Worker URL so credentials cannot leak between deployments.

## Worker and PWA build

The browser-facing PWA source lives in `src/pwa/`, while its Worker-served HTML, styles, install assets, and service worker live in `src/cloudflare/worker/pwa/`. `scripts/build-worker.mjs` builds the PWA client first, injects that bundle into the Worker build, and writes the deployable module to `.generated/cloudflare/worker.mjs`.

The Obsidian plugin and PWA own separate application shells so viewport, navigation, safe-area, and modal behavior can follow each host. They share reminder panels, cards, and view-model logic rather than sharing host chrome. Both hosts compile the same semantic theme tokens and reminder-card styles; see [Shared plugin and PWA UI](ui-styling.md) for ownership and validation.

The Worker is a separate build product. The production plugin includes gzip-compressed copies of `.generated/cloudflare/worker.mjs` and `src/cloudflare/schema.sql`. The Vite artifact plugin computes SHA-256 hashes at build time; Obsidian verifies them after decompression before deployment. No Worker code or schema is fetched from the network at runtime. The schema records version 5 in `crate_schema`. Provisioning initializes empty databases and upgrades schemas 2/3/4 additively, preserving vault data. Unsupported schemas are rejected without modification. See the [compatibility matrix](compatibility.md).

`npm run release:check` enforces Worker and combined-plugin size budgets and checks that the OAuth entry point remains present.

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

The plugin scans local Markdown for its UI. The server derives notification schedules from committed Markdown, using one shared folder, timezone, all-day time, and enabled flag in `notification_policy`. Startup only initializes an absent policy. Explicit settings edits compare the captured policy revision before updating it.

1. Every Markdown commit records source identities and durable occurrence observations; commits and deletions record a projection job in the same D1 transaction as the file metadata and changelog.
2. A reserved coordinator Durable Object wakes after successful mutations. Scheduled maintenance recovers missed wakeups. Each alarm processes at most three source files and five notification jobs, then rearms while work remains.
3. Projection reads and verifies the current immutable R2 object. A conditional D1 batch replaces reminder projections and outbox jobs only while the file revision, policy revision, and projection job token still match.
4. Each projection publishes its expected notification token and policy revision. The outbox job token becomes the alarm's stable schedule token. Delivery requires all of these to match the current source and policy, closing the gap between projection and outbox application. A durable completed-occurrence receipt prevents accepted-command replay from notifying again; recipient progress survives updates to the same due time.
5. Web app enrollment produces a folder-bound 90-day session. The authenticated session owns its push subscriptions. Logout captures its revocation request before clearing local state. Recipient selection independently checks expiry and folder authority. Every subscription has a recorded owner.
6. Push delivery allows known browser push provider hosts, rejects redirects, and has a ten-second network deadline. Expired subscriptions are pruned and permanent failures quarantined. Exhausted reminder deliveries retain a D1 failure record visible in diagnostics; rescheduling to a future occurrence starts a new attempt.

Reminder editing uses semantic revisions captured when the form opens, plus file compare-and-swap at commit. Web mutations require an operation UUID; the transaction persists a request hash and response receipt alongside the file update. Retrying a committed request replays its result. Creation IDs remain reserved after deletion. Timed reminders persist UTC instants; recurrence metadata retains timezone, count, end date, and completion progress in a Markdown comment tied to the visible rule.

Sync deletes require both the acknowledged content hash and opaque file revision. Recreating the same bytes produces a new revision, so an old delete cannot remove the new file. Missing revisions require reconciliation. Local remote-deletion application always uses vault trash so bytes written after the hash check remain recoverable. Supported text updates use Obsidian's atomic process API. Existing binary files are preserved and incoming bytes saved as conflict copies for explicit review because Obsidian exposes no atomic binary compare-and-swap.

See [the protocol contract](protocol.md) and [backup and recovery](recovery.md).
