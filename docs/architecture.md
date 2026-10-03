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
| **Cloudflare OAuth deployment** | Uses PKCE in Obsidian to provision the bundled Worker and schema; retains account authorization in secret storage for explicit management and usage requests |
| **Static GitHub Pages callback** | Removes OAuth parameters and hands the response to Obsidian; has no backend, analytics, or token exchange |
| **OS Keychain** | Stores auth tokens via Obsidian's `secretStorage` API |

## Worker Bindings

| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 Bucket | File storage |
| `DB` | D1 Database | Changelog, file manifest, authentication, subscriptions, and parsed reminder cache |
| `REMINDER_ALARMS` | Durable Object Namespace | Reminder alarm DOs |
| `NOTIFICATION_REQUEST_LIMITER` | Rate Limiting API | Limits unrecognized API credentials and sensitive actions per source before D1; verified sessions use a separate bounded sync budget |

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

Sync history checkpoint and restore policy lives in `sync/engine-history.ts`.
The engine retains cancellation, exclusive-operation checks and active-work tracking.
`sync/runtime-history-workflow.ts` keeps pause, persistence, application, sync,
verification and resumption together; the runtime supplies connection identity checks
and the ordinary sync-operation wrapper.

The PWA mounts one `PwaSyncProvider` under the application shell. It owns the
Reading and Reminders runtimes independently of their lazy screens, so pending work
resumes without visiting either section. Feature adapters retain their existing
queues, storage formats, API endpoints and confirmation rules. Pausing a feature
stops new sends and refreshes while retaining its local hydration, recovery state
and settings actions; already dispatched operations can still settle safely.

`pwa/connection/AppConnection.tsx` owns the app connection: enrollment, startup,
credential changes, service-worker registration and logout. Reading connects with
the existing app credential after enrollment completes. `AppConnectionGate` presents
one unlock/reconnect surface above the feature screens; a failure confined to one
feature still allows opening the other. Scope-specific encryption adapters share
verification and key-import policy through `connection/encryption.ts`, retaining
their local storage migration and cache responsibilities. Expired credentials are
matched against the current connection before suspension; expiry preserves drafts
and pending changes, while explicit logout clears both features' local data.
`reading/useReadingConnection.ts` handles Reading connection readiness, and
`reading/useReadingSession.ts` hydrates its articles, drafts and pending changes.
This shared lifecycle does not transfer browser storage into an installed iOS app.
Mobile enrollment links first show `connection/BrowserSetup`: **Continue to web**
opens the browser UI and remembers that preference; **Install Crate** reveals
platform instructions while feature screens stay unmounted. Enrollment and local
key import can finish behind this choice; imported keys survive page reloads.
Standalone launches bypass it. The preference contains no credentials
and does not replace the installed app's encryption unlock.

`pwa/sync/state.ts` derives the overall indicator and update readiness from both
runtime registrations. An uninitialized feature is unverified, while a hydrated
paused feature remains ready for settings and logout. Paused or disconnected
pending work still blocks updates. Both headers open the shared sync details;
refresh dispatches independently to enabled features, and logout clears both
private views while credential revocation and storage cleanup finish. Sync feedback
also lives above the feature screens, including remote logout warnings. The final
update path also rechecks durable queues, independently of the status model.

Reading's PWA adapter composes three hooks: `useReadingSession` owns enrollment,
session invalidation and durable hydration; `useReadingSync` owns refresh serialization,
retry scheduling and foreground/cross-tab refresh; `useReadingArticle` owns article loading,
browser history and stale navigation guards. The runtime provider owns feature composition and settings publication; the
application component owns article presentation and navigation. Durable Reading records are validated at the storage boundary
before the hooks publish them or the queue dispatches them. `reading/outbox.ts` owns
typed commands, exact dispatch bytes, dependent-edit ordering and retry eligibility;
automatic refreshes honor the persisted deadline and three-attempt budget, while an
explicit refresh can retry uncertain commands. Rejected commands remain for review.
The plugin's `reading/ui/useLocalReadingArticle.ts` owns reader navigation and
invalidates late reads on Back, a newer open, library replacement or unmount.

Reminder vault events are debounced by `reminders/services/vaultWatcher.ts`.
The reminder index serializes accepted scans without a second time-based filter.
Delete and rename events invalidate queued/in-flight scans for their paths; a full
scan re-reads its inventory if one of those events occurs before publication.
The same invalidation also stops the scanner's ID normalization, preventing a late
read from rewriting a note after it moves out of the reminder folder. This keeps
immediate index updates authoritative over older asynchronous reads.

The sync HTTP client binds compatibility checks, dispatch and response publication
to one connection generation. Replacing credentials or the lifecycle signal
invalidates older work, including mutations waiting on cached compatibility data.
Shared-feature operations also retain that identity across consecutive requests,
queued settings writes and backend/UI publication. Already dispatched Obsidian
requests remain non-cancellable; ordinary durable
operation reconciliation still handles uncertain remote writes.

## Authentication

### Cloudflare deployment

1. The plugin creates a cryptographically random OAuth `state` and a fresh PKCE S256 verifier/challenge in memory.
2. Cloudflare redirects to `https://crate.kaanbiryol.com/oauth/callback/`. The static page immediately clears its query string and opens the `crate-cloudflare-oauth` Obsidian protocol.
3. The plugin verifies `state` before exchanging the authorization code. The deployment service uses the exchanged tokens for the selected account operation.
4. The plugin discovers Crate Workers in the selected account. Joining a saved or discovered deployment registers this device without uploading code or changing schema. Creating a deployment initializes the current schema; explicit updates require its schema marker before uploading code; request cold starts never mutate the schema. Updates reject an authoritative remote version newer than the installed artifact.
5. The plugin generates a permanent device secret locally and writes only its hash and device metadata to the deployment's D1 database using the temporary Cloudflare authorization.
6. After a successful operation, `CloudflareUsageConnection` retains the access and refresh tokens in Obsidian secret storage, scoped to the Cloudflare account. Explicit usage, reconnect, update, reset, deletion and recovery operations reuse this login and renew it when needed. Failed operations with newly exchanged tokens revoke them; a failed operation using the saved login keeps that shared login. Plugin settings contain only non-secret deployment metadata and the cached usage snapshot. Revocation is available in Cloudflare.

Terminal Cloudflare deletion is implemented separately in `server-delete.ts`, with resource identity checks in `server-delete-ownership.ts` and settled-operation takeover in `server-delete-fence.ts`. It removes the selected Worker and its owned Durable Objects, then its entire R2 bucket and D1 database. A separate temporary cleanup Worker uses a hashed capability and only the selected R2 binding; it does not depend on application protocols, releases, schemas, or reset/rebuild rules. Non-secret deletion progress survives plugin reload.

### Device authorization

For Cloudflare deployments, Cloudflare account authorization is the authority for adding a vault-sync device. A fresh device signs in through OAuth and registers its hashed bearer token through the Cloudflare D1 API. For local servers, the operator issues a device token using the host CLI while the server is stopped. The plugin validates vault access and protocol compatibility before saving the connection. Both hosting modes use the same Worker authentication and revocation endpoints.

Disconnecting locally preserves non-secret deployment metadata so reconnecting the same vault converges on the same Worker.

### Worker Authentication

Authenticated requests carry a Bearer token in the `Authorization` header. The Worker hashes the bearer token and checks the `auth_tokens` D1 table. Missing or expired tokens are rejected, and D1 failures return `503` without falling back to a second credential system.

Push subscriptions are created with an authenticated session and record that session as their owner.

The reminders web app uses a separate short-lived web enrollment token in the `/notifications?token=...` link. The PWA exchanges it once at `POST /notifications/reminders-exchange` for a 90-day, reminder-only bearer token stored locally by the browser. The token is bound to the exact enrolled reminders folder. Route and folder authorization prevent that token from reading or mutating the vault sync API, shared settings, device list, push administration, or enrollment-token API, so it cannot renew itself. Open a fresh link from the plugin after the session expires.

## Desktop Reading capture

Desktop Obsidian saves a local bookmark before downloading its source through
`requestUrl`. `ReadingLibrary` serializes downloads separately from vault mutations,
so the user can keep reading or editing notes. An empty local bookmark is stored
as `unavailable`, preventing the Worker from independently extracting it while
normal sync runs; the reader shows an in-memory downloading state. A successful
download conditionally fills only that bookmark’s empty managed article block,
preserving current metadata and personal notes outside the block. Deleted, replaced,
modified article blocks, changed identities, duplicates, and stopped runtimes reject
late publication. A failed or interrupted download remains a retryable bookmark.

HTML extraction lives in `src/reading/extraction/` and is shared with the Worker.
It uses inert parsing and disables extractor network requests. Desktop capture
loads it on demand; all executable code is bundled with the plugin. Mobile plugin
captures and the PWA retain the durable server queue. Previously queued desktop
server captures still drain through their original path. See
[article fetching and CORS](reading-fetch-research.md) for transport limits and browser evidence.

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

The Obsidian plugin and PWA share dock presentation, the Today/Upcoming switcher, tab dissolves, and project push/pop transitions in `src/ui/shared/navigation/`, alongside reminder panels, cards, and view-model logic. Host adapters retain viewport, safe-area, modal, persistence, and history behavior. `PluginWorkspace` keeps visited Reminders and Reading screens mounted in the same Obsidian pane, reads local vault repositories, and stores dock choices in Obsidian device-local storage. Existing view types and commands remain supported. Reading runtime subscriptions replace or remove the mounted library when its configuration changes. Both hosts compile the same semantic theme tokens; see [Shared plugin and PWA UI](ui-styling.md) for ownership and validation.

Reading and Reminders share the feature-independent view header, navigation bar,
buttons, icon buttons, and modal header under `src/ui/shared/`. Feature adapters
provide destinations, actions, data, and lifecycle behavior. The PWA supplies its
dock with direct section switching through a Reading navigation adapter and its reminder shell;
feature switching and per-section state retention stay in the PWA feature shell. Reading owns its
article layout and typography, while common controls use the same host tokens.

Shared icons and reduced-motion preferences live in `src/ui/shared/`; the Obsidian
icon renderer lives in `src/ui/obsidian-icon/`. Reminder import paths re-export
these implementations for existing feature consumers.

`src/pwa/main.tsx` mounts the feature shell. `components/RemindersApp.tsx` composes
reminder data, session, outbox, and presentation hooks. `useReminderSync` owns the
confirmed snapshot and exposes reads and explicit commit/reset operations; outbox
consumers cannot independently replace its refs or React state. `useReminderEditor`
owns editor presentation, synchronous tap opening, close transitions, recovered
drafts, and session reset.

Plugin feature requests use `src/plugin/server-request.ts` for validated server
metadata and lifecycle/connection guards before dispatch and after responses.
Reading adds its own capability requirements; shared feature settings require
only their own capability.

`ReminderAlarm` retains the Durable Object class, storage identities, and mutation
lock. `coordinator-requests.ts` dispatches coordinator endpoints with that lock,
keeping upload preparation outside it. `coordinator-alarms.ts` dispatches Reading,
maintenance, and projection roles; reminder delivery stays in `ReminderAlarm`.

The Worker is a separate build product. The production plugin includes gzip-compressed copies of `.generated/cloudflare/worker.mjs` and `src/cloudflare/schema.sql`. The Vite artifact plugin computes SHA-256 hashes at build time; Obsidian verifies them after decompression before deployment. No Worker code or schema is fetched from the network at runtime. The current candidate initializes schema 2 in `crate_schema`; see the checked [current contract](current-contract.md). Provisioning initializes empty databases and leaves current databases unchanged. The registered schema-1 upgrade uses the explicit manifest and checkpoint boundary in [server upgrades](server-upgrades.md). Unsupported schemas are rejected without modification. See the [compatibility matrix](compatibility.md).

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

Encrypted Reading uses the trusted plugin/PWA for decryption, indexing, extraction and Markdown edits. `reading/encrypted-api.ts` owns the conditional ciphertext transport; `pwa/connection/` owns app enrollment and shared verification, while `pwa/reading/encryption-session.ts` and `private-storage.ts` adapt that readiness to Reading's protected local storage. The Worker stores ciphertext and public scope/policy metadata; its plaintext Reading projector/extractor remains only for unencrypted vaults. See [Reading encryption](reading-e2ee-assessment.md).

`encryption/` owns key bundles, authenticated formats and identity comparison. Both browser enrollment flows use `pwa/encryption-scope.ts` to validate complete folder authority before persisting keys. `sync/encrypted-files.ts` translates verified private metadata into local sync identities and maintains a bounded cache of authenticated metadata. `plugin/encryption-folder-move-journal.ts` owns the durable move contract and exact setting destinations; `encryption-folder-moves.ts` runs conversion and recovery through `SyncRuntime`'s existing configuration serialization.

Self-hosted encrypted address changes authenticate the server recovery bundle in `sync/encrypted-connection.ts`. A local `checkpointScope` associates the new transport URL with the existing disk authority so pending uploads, rename dependencies and local history survive tunnel changes. It is only retained for that URL, never shared as a preference, and cleared when resetting sync. The runtime owns connection switching and waits for journal I/O; neither the enrollment validator nor the connection verifier starts sync independently.

App key approval separates the cryptographic state machine (`encryption/pairing/`)
from the relay (`worker/encryption-pairing.ts`). `plugin/web-app-pairing.ts` captures
one unlocked vault connection and limits approved grants to the browser features;
`ui/settings/web-app-pairing-modal.ts` owns the human approval. The shared PWA
connection gate presents `AppPairing`; `pairing-client.ts` binds requests to the
current app session, and `web-app-unlock.ts` validates and persists grants while
preserving existing draft encryption secrets. Pairing polls exist only for open
screens, stop on close, and pause while hidden. They do not belong in startup or
normal sync loops.
