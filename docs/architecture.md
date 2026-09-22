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

The plugin and PWA share React components and use the same React/React DOM runtime.
Vite uses `@vitejs/plugin-react` for the plugin and visual gallery; the PWA uses
esbuild with the React JSX runtime. Browser test harnesses use these same packages.
Obsidian mounts reminder views inside Shadow DOM, so editor selection and event
handling are tested there as well as in the PWA's document.

## Infrastructure Stack

The same Worker can run locally through `scripts/local-server.mjs`. Miniflare
provides D1, R2, and Durable Objects backed by a persistent data directory. A
Node HTTP listener forwards only application requests; Miniflare's own listener
stays on loopback. Schema and runtime compatibility are checked before Durable
Objects start. Local administration issues hashed per-device credentials
without Cloudflare OAuth. See [self-hosting](self-hosting.md).

`Dockerfile` packages that same standalone runtime and a pinned tunnel connector.
`compose.yaml` owns container lifecycle and the persistent `/data` volume. Its
entrypoint holds a kernel lease across the CLI and its children, allowing crash
recovery without two containers opening the database. Application behavior stays
in the shared Worker and local launcher.

The local gateway also owns single-use device pairing and an instance-specific
public readiness probe. Pairing administration uses a private local socket and
secret; only redemption is exposed through the tunnel. Verified backup/restore
operates on stopped storage and validates checksums, compatibility, and the
restored database before publishing its metadata. These features do not add
enrollment endpoints or migration behavior to Cloudflare-hosted Workers.

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

For Cloudflare deployments, Cloudflare account authorization is the authority for adding a vault-sync device. A fresh device signs in through OAuth and registers its hashed bearer token through the Cloudflare D1 API. For local servers, the operator issues a device token using the host CLI while the server is stopped. The plugin validates vault access and protocol compatibility before saving the connection. Both hosting modes use the same Worker authentication and revocation endpoints.

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

The Worker is a separate build product. The production plugin includes gzip-compressed copies of `.generated/cloudflare/worker.mjs` and `src/cloudflare/schema.sql`. The Vite artifact plugin computes SHA-256 hashes at build time; Obsidian verifies them after decompression before deployment. No Worker code or schema is fetched from the network at runtime. The first-release schema records version 1 in `crate_schema`. Provisioning initializes empty databases and leaves current databases unchanged. Future upgrades use the explicit manifest and checkpoint boundary in [server upgrades](server-upgrades.md). Unsupported schemas are rejected without modification. See the [compatibility matrix](compatibility.md).

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

`reminderSchedule.ts` resolves schedule spans for both editors. Highlighting, draft metadata and saving consume the same result type: a Chrono date or a recurrence rule from the shared repeat grammar. They do not identify a phrase and then reinterpret it with a separate parser. Timezone suffixes use Chrono's abbreviations and offsets; IANA names use the platform timezone database. Recurrence calculations use `@internationalized/date`. Named zones follow daylight-saving changes, while explicit offsets stay fixed. Editors display non-local recurrence zones and retain them through title, priority, project and repeat-picker edits.

The repeat grammar owns the cadence, weekday lists/ranges and monthly day. `reminderTime.ts` delegates the following time phrase to Chrono, retaining its complete span and time precision, so forms such as `every Monday at 9 in the morning` stay recurring. A bare `Monday 9` does not imply a time when Chrono leaves the number as text. Seconds, fractional seconds and timestamps follow Chrono's recognition. Repeat time ranges still cannot fit the single-time recurrence rule. Calendar dates following a repeat remain separate schedules, subject to the last-schedule rule.

One-off calendar recognition also belongs to Chrono. Dates, times and timestamps are not prevalidated or partially masked: when Chrono returns no match, the full phrase remains title text. Durable reads use the same recognition and require recognized schedules to be absolute.

Sync deletes require both the acknowledged content hash and opaque file revision. Recreating the same bytes produces a new revision, so an old delete cannot remove the new file. Missing revisions require reconciliation. Local remote-deletion application always uses vault trash so bytes written after the hash check remain recoverable. Supported text updates use Obsidian's atomic process API. Existing binary files are preserved and incoming bytes saved as conflict copies for explicit review because Obsidian exposes no atomic binary compare-and-swap.

See [the protocol contract](protocol.md) and [backup and recovery](recovery.md).
