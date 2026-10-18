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

The same Worker can run locally through `scripts/local-server.mjs`, a thin entry
point into `packages/server/src/`. That directory owns the standalone CLI, HTTP
gateway, tunnels, pairing, backups, and runtime asset resolution. The packager
copies the complete source directory into the published package's `scripts/`
directory and marks its manifest to select shipped assets. Source execution
uses repository assets; installed execution uses only the package. Miniflare
provides D1, R2, and Durable Objects backed by a persistent data directory. A
Node HTTP listener forwards only application requests; Miniflare's own listener
stays on loopback. Schema and runtime compatibility are checked before Durable
Objects start. Local administration issues hashed per-device credentials
without Cloudflare OAuth. See [self-hosting](self-hosting.md).

`packages/server/src/local-server-lifecycle.mjs` owns ordered teardown for the CLI
and Quick Server. It drains the HTTP listener before closing the runtime, attempts
remaining cleanup after individual failures, and preserves startup errors alongside
cleanup errors. Runtime disposal still owns safe release of the data-directory lock.

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

`cloudflare/worker-upload-payload.ts` builds multipart metadata and module bytes for
normal, reset and deletion Workers. `cloudflare/cloudflare-api.ts` owns authenticated
transport, response handling and pagination. Binding and export policy belongs with
the payload builders, including preserved Durable Object namespaces during reset.

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
  ├── Sync status (plugin/sync-status.ts) - subscribes to runtime state and progress
  │     └── StatusBarManager (ui/status.ts) - status bar rendering
  ├── SyncRuntime (sync/runtime.ts) - lifecycle coordinator
        ├── SyncEngine (sync/engine.ts) - orchestrates sync operations
        │     uses: planner, transfer, queue, file-discovery, manifest
        │     owns: engine-file-operations - journaled uploads/restores and guarded deletes
        └── SyncApiClient (sync/api.ts) - HTTP calls to worker
  ├── Reminder runtime (reminders/runtime.ts) - index/writer/repository/watcher setup
  ├── Reminder registrations (reminders/register-integrations.ts) - commands, code blocks, views
  ├── ReminderIndex (reminders/data/reminder-index/) - in-memory reminder index
  └── MarkdownWriter (reminders/data/markdown-writer/) - markdown CRUD for reminder lines
```

Sync history checkpoint and restore policy lives in `sync/engine-history.ts`.
`sync/manifest-checkpoint.ts` owns checkpoint parsing, encoding and recovery
equivalence. `LocalManifest` retains generation selection, file I/O and ordered
saves. Its baseline readers expose readonly views with stable entry identities;
mutations replace entries through the manifest so revision tracking and checks
across asynchronous reads agree. Diagnostics remain outside recovery equivalence.
Pending previews, discard preparation and post-sync baseline verification live in
`sync/engine-pending-changes.ts`; `SyncQueueController` owns pending revisions and
accepted flush batches. Each batch captures its revision snapshot and releases its
in-flight paths once before publishing idle/error. Result recording can overlap a
later transfer without an older finalizer clearing that transfer's pending work.
Discard keeps baseline persistence and queue settlement in one ordered operation.
`sync/pending-change.ts` owns the operation/path representation used by the queue,
reconciliation, discard and Activity selection. Deletion keys use a marker that
cannot occur in a valid sync path; a file named `delete:note.md` remains an ordinary
upload. These keys are volatile and are rebuilt from local files at startup, so
the representation does not change checkpoints or the wire protocol.
The engine retains cancellation, exclusive-operation checks and active-work tracking,
including local and shared checkpoint saves. Shutdown drains those writes; the runtime
only attaches a completed checkpoint while its originating engine is still current.
Sync results carry an explicit completed, cancelled or failed outcome. Cancellation
retains transfer counts and diagnostics, but does not publish a successful sync,
history checkpoint or error notice. Result aggregation and finalization preserve
cancellation rather than inferring completion from an empty error list.
Queue revision tracking and settlement snapshots are required dependencies, so
settling an earlier upload cannot silently bypass the guard for a newer local edit.
`sync/runtime-history-workflow.ts` keeps pause, persistence, application, sync,
verification and resumption together; the runtime supplies connection identity checks
and the ordinary sync-operation wrapper.

`sync/preview-format.ts` owns text decoding, binary control-character rejection and
the 256 KB preview limit. Each preview loader retains its storage access and integrity
checks. File history hides the UTF-8 BOM for display; pending diffs, restore comparisons
and conflict review preserve it. Conflict review retains its separate 1 MB edit limit.

`sync/engine-file-operations.ts` binds durable uploads, restores and rename deletion
guards to one engine's manifest and Markdown cache. Planners, transfers and the queue
receive this required handle. Creating it does not change the raw endpoint methods
on `SyncApiClient`; the client retains HTTP, protocol and encryption concerns.
Restore writes participate in engine shutdown draining, and the runtime only finishes
a restore after successful reconciliation by the same engine.

`sync/transfer-upload.ts` and `sync/transfer-delete.ts` own ordinary transfer
execution across sync modes. Automatic queue adapters retain revision settlement
and retry scheduling while delegating batching, concurrency, acknowledgements and
manifest updates to these executors. `sync/delete-batches.ts` bounds deletion
requests and drains accepted siblings on cancellation. Sync modes supply their
planning and conflict-reconciliation policy.

`sync/engine-exclusion-cleanup.ts` binds a cleanup review to its original paths,
hashes, revisions and exclusions. The engine retains exclusive mutation admission
and lifetime checks; the runtime rejects reviews from a replaced engine. Execution
cannot add newly discovered remote files to an already reviewed deletion set.
Acknowledged deletions are saved before cancellation is reported.

Engine shutdown also drains accepted conflict mutations, background recovery and
Markdown-cache work before a replacement engine can load their files. The conflict
store closes after its producers settle, finishes queued writes, and rejects new
mutations; serialization within one store alone cannot protect replacement stores.

`sync/planner-incremental.ts` owns incremental phase ordering, progress, manifest
saves and cursor advancement. `incremental-changelog.ts` reads a deduplicated
snapshot without changing the saved cursor. `incremental-remote-reconciliation.ts`
checks current local bytes and applies guarded local deletes together; it returns
newly discovered local edits rather than mutating the scan inventory.
`incremental-local-deletes.ts` applies remote deletes after the preceding phases
succeed. These helpers do not own engine cancellation or runtime lifecycle state.

`reminders/data/reminder-index/index.ts` owns reminder record changes, including
file renames. Its `lookup-store.ts` maintains derived lookup maps: the owner removes
old keys before changing records, then adds the updated records before notifying
subscribers. Scan failure retains the last published records and lookups together.

`reminders/core/reminderDescription.ts` owns description encoding and attached comment
parsing. `markdownReminderFile.ts` retains reminder lookup, guarded replacement,
deletion and reordering. Parser errors carry a stable category and source line through
the plugin scanner and index to presentation; the original reason remains available
for logs and callers without structured diagnostics.

`reminders/core/reminderMutationPlan.ts` normalizes create/update inputs for the
plugin repository, shared file commands and Worker routes. Its update contract
belongs to the domain; core code does not depend on the Obsidian writer interface.
Repository queries and optimistic fallback records remain in the data layer.

`cloudflare/worker/request-handler.ts` distinguishes public, coordinator and
transfer execution with a tagged argument. `request-guards.ts` owns stateless
protocol and encryption checks; the handler retains their ordering around
admission, authentication, scope authorization and route dispatch. Transfer
requests authenticate again after entering the queue. Coordinator execution
receives the Durable Object state and persists notification wakes before mutations.
The handler selects required `UploadCommitters` from that execution kind and passes
them through the routes. Worker `Env` contains bindings, not optional publication
callbacks. Upload handlers retain staging and validation; direct publication and
coordinator forwarding remain explicit choices without fallback defaults.
`UploadCommitInput` excludes local callback effects, and staged forwarding selects
explicit JSON metadata. Direct `commitStagedFile` callers retain transaction-local
effects for atomic domain receipts.

`cloudflare/worker/operation-expiry.ts` owns the shared retry floor used by
Reminders, Reading, uploads and encryption recovery. Its persisted
`reminder_operation_floor` key remains unchanged. `maintenance/operation-receipts.ts`
publishes that floor and prunes receipts in the same transaction, and coordinates
expired enrollment and pairing cleanup. Reminder-specific expiration copy and
occurrence retention stay with the reminder modules.

`cloudflare/worker/maintenance/object-cleanup.ts` owns reference-aware R2 deletion
and its retry queue. Scheduled drains report failures to maintenance diagnostics;
cleanup after a committed mutation remains best effort. Reference checks, object
deletion and queue settlement stay in one operation.

`sync/runtime-server-status.ts` owns version caching and delayed reachability
probes for manual sync. `SyncRuntime` supplies the current client and an idle-engine
guard, resets probes during lifecycle changes, and retains foreground sync policy.
Server observations cannot publish after a newer sync, shutdown or engine replacement.

`cloudflare/deployment-types.ts` defines authorization-independent deployment requests
and distinguishes a deleted server from a deployed server with a URL. OAuth sessions
contain a request; saved authorization runs that request directly.
`cloudflare/deployment-target.ts` owns account selection, discovery and server reuse
policy. The service owns authorization, cancellation, target verification and the
ordered provisioning workflow. `cloudflare/plugin-integration.ts` coordinates
the operation and device connection; `ui/cloudflare-operation-presentation.ts`
owns modal copy and recovery actions supplied by that coordinator.

`sync/runtime-connection-workflow.ts` owns connecting and disconnecting, including
validation, credential revocation, local state cleanup and settings persistence.
`sync/runtime-encryption-reset-workflow.ts` owns the durable remote reset, local
invalidation and upload sequence. `sync/runtime-address-workflow.ts` owns verified
encrypted connection and reset-address moves. `SyncRuntime` serializes these
configuration changes and supplies stop, drain, initialize and cancellation checks;
workflows do not calculate lifecycle generations or register events.
The configuration queue captures authority when accepting each operation and verifies
it before dispatch; workflows also check it after asynchronous work. Shutdown invalidates
queued resets, address changes, connection changes and encryption setup even when the
caller supplies no cancellation signal. `sync/connection-errors.ts` defines stable
codes for owned setup failures; settings presentation uses those codes to preserve
recovery guidance while redacting unknown transport failures.
`sync/engine-contexts.ts` binds planners and transfers directly to their dependencies.
The engine supplies live state, pending paths, lifecycle guards and reconciliation;
planner and transfer calls do not round-trip through engine forwarding methods.
The ordered completion of the initial configuration pull and reminder setup lives in `sync/initial-setup.ts`.
Planner cancellation checks, transfer baseline reads and workflow setup completion
are required context dependencies, including in test fixtures.
`sync/planner-types.ts` owns `FullSyncPlan`, shared by the planner and the workflow
that applies its result.

`ui/activity-modal.ts` owns the Activity view's subscriptions and rendering.
`ui/activity/shared-history-loader.ts` owns request coalescing and disposal for each
open view, keeping available history on failure and ignoring late responses after
close. `ui/activity/activity-status.ts` derives labels, indicators and button state
without manipulating the DOM. Conflict panel rendering stays with the modal.

`pwa/hooks/useFeatureNavigation.ts` owns feature and settings history, dock selection,
interruptible section transitions and focus restoration as one lifecycle.
`pwa/FeatureShell.tsx` composes providers and renders the retained feature panels.

`pwa/service-worker/runtime.ts` owns typed service-worker event handlers, including
offline shell caches, update activation, encrypted push and Reading shares. It is
compiled with WebWorker globals into a version-neutral bundle before the PWA asset
version is calculated. `cloudflare/worker/pwa/service-worker.ts` supplies the final
version and chunk URLs. The runtime bundle and its transitive inputs participate in
asset hashing and server revision checks; cache policy and browser message formats
remain owned by the runtime.

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
Connection boundaries publish typed issues from `connection/issues.ts`; recovery
screens choose cleanup, reconnect or retry actions from the issue kind, independently
of its display message.
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
runtime registrations. Each feature explicitly publishes the policy from
`pwa/sync/update-readiness.ts` and a synchronous guard for work awaiting durability.
Reading queues commands in its runtime, so waiting for Web Locks or IndexedDB blocks
updates before a pending record exists. Final update checks still reread durable
queues and drafts. An uninitialized feature is unverified, while a hydrated
paused feature remains ready for settings and logout. Paused or disconnected
pending work still blocks updates. Both headers open the shared sync details;
refresh dispatches independently to enabled features, and logout clears both
private views while credential revocation and storage cleanup finish. Sync feedback
also lives above the feature screens, including remote logout warnings. The final
update path also rechecks durable queues, independently of the status model.
Reminder command preparation publishes readiness changes and supplies a synchronous
guard before React commits. Activation and reload recheck that guard after
asynchronous storage reads, covering the interval before a command reaches its outbox.

Reading's PWA adapter separates durable state from its screen. `useReadingSession`
owns durable hydration and session-checked publication methods; app connection
hooks own enrollment and unlocking. `useReadingSync` owns refresh serialization,
retry scheduling and foreground/cross-tab refresh. Its serialized refresh includes
the connection check, queue drain and list load. Storage events are limited to
Reading credentials, shared authentication/logout and storage clears, so unrelated
preference or reminder edits do not fetch the Reading library. `useReadingMutations` owns capture,
metadata edits, extraction retries and synchronous update guards in the mounted
runtime, while `useReadingArticle` owns article loading, browser history and stale
navigation guards. The runtime provider composes these owners and publishes settings;
the application component owns presentation and invokes commands. Durable Reading records are validated at the storage boundary
before the hooks publish them or the queue dispatches them. `reading/outbox.ts` owns
typed commands, exact dispatch bytes, dependent-edit ordering and retry eligibility;
automatic refreshes honor the persisted deadline and three-attempt budget, while an
explicit refresh can retry uncertain commands. Rejected commands remain for review.
Settings deadlines and failure announcements use the same outbox policy: transient
errors remain visible, while toasts wait until automatic recovery stops or review
is required.
`pwa/reading/cache.ts` owns `commitReadingCache`, keeping uncertain-source
preservation, article pruning, encrypted records and list persistence in one guarded
transaction. `reading/database.ts` owns database lifetime and raw encrypted values;
`pwa/single-store-database.ts` shares bounded opening, schema validation and late
request fencing with the encryption databases. Reading retains its cached
connection, and each feature retains its own records and transactions.
`reading/session.ts` owns session authority. The storage facade exposes specific
draft, pending-command, share and immutable-attempt operations, keeping raw keys
inside persistence and migration code. Export and logout retain their recovery guards.
`pwa/reading/api.ts` retains pagination and response validation, including
`loadReadingArticle`. Network and cache reads share item/article validation in
`reading/record-validation.ts`; live articles must match the requested identity and
enrolled folder before the reader or offline cache receives them.
List pages are validated before accumulation. The loader rejects repeated cursors
and bounds page, item and issue counts before committing a complete cache revision;
rejected pagination leaves the prior cache and unsettled commands available.
The plugin's `reading/ui/useLocalReadingArticle.ts` owns reader navigation and
invalidates late reads on Back, a newer open, library replacement or unmount.
`reading/ui/useReadingReaderActions.ts` scopes mutation and sharing feedback to the
displayed article's lifetime. The two action channels remain independent; replacing
the article or unmounting prevents delayed errors, save completion, dialog closure
and clipboard feedback from affecting another reader. Host callbacks still own
metadata persistence, while `ReadingReader` retains content and navigation layout.

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

`reading/obsidian-vault.ts` binds snapshots to Obsidian file identities and owns
discovery, guarded reads/writes, and file-event revisions. `reading/runtime.ts`
owns configuration, policy refresh, scheduling and lifecycle cleanup.
`ReadingLibrary.close()` closes admission and drains its accepted mutation and
capture queues. Runtime shutdown waits for it alongside refreshes;
replacement libraries defer vault access until the previous runtime has drained.
`reading/core/mutation-policy.ts` shares edited-field preconditions and empty
capture checks across the library, encrypted client and plaintext Worker.
Transport authorization, extraction consent and atomic publication stay with
their respective hosts. Worker `reading/queries.ts` owns item/list queries and
payloads; its route admits reads only after authorization and complete projection.

Desktop Obsidian saves a local bookmark before downloading its source through
`requestUrl`. `ReadingLibrary` serializes downloads separately from vault mutations,
so the user can keep reading or editing notes. An empty local bookmark is stored
as `unavailable`, preventing the Worker from independently extracting it while
normal sync runs; the reader shows an in-memory downloading state. A successful
download conditionally fills only that bookmark’s empty managed article block,
preserving current metadata and personal notes outside the block. Deleted, replaced,
modified article blocks, changed identities, duplicates, and stopped runtimes reject
late publication. A failed or interrupted download remains a retryable bookmark.

`reading/core/article.ts` owns article block assembly and extracted metadata updates
for local downloads, new Worker captures and existing Worker notes. Each caller
selects its publication policy, preserving the differences in metadata ownership,
fallbacks and deferred transcripts. Source eligibility, revision checks, queue
leases and storage commits remain with the local library and Worker workflows.

HTML extraction lives in `src/reading/extraction/` and is shared with the Worker.
Generic article extraction uses inert parsing and disables extractor network requests.
The YouTube-specific enrichment adapter grants bundled Defuddle bounded access
to an allowlist of YouTube watch/player/caption endpoints; failed captions preserve
video metadata. Encrypted PWA captures leave missing transcripts pending for a
trusted Obsidian device. Plugin capture on desktop and mobile
loads it on demand; all executable code is bundled with the plugin. Unencrypted
PWA captures retain the durable server queue. Previously queued desktop
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

`plugin/settings-types.ts` separates persisted settings from the runtime device ID.
Loading initializes settings before hydrating that ID from secret storage. Queued
settings writes use `plugin/settings-persistence.ts` to publish only requested
normalized fields after saving; snapshot saves do not republish captured state.
The same module exposes a narrow synchronous sync-progress update with bounded,
immutable history. Sync retains cursor/checkpoint ordering and persists at operation
completion. This preserves newer progress during unrelated settings saves, the
hydrated device identity and the existing shared settings object.

`cloudflare/deployment-state.ts` validates persisted deployment, reset and deletion
state; plugin settings compose that domain normalizer. `cloudflare/restore/workflow.ts`
keeps restore checkpoint selection, destination creation and persist-before-remote
ordering together. `CloudflareDeploymentService` retains authorization, operation
exclusion, lifetime guards and guarded settings/transport access.

## Worker and PWA build

The browser-facing PWA source lives in `src/pwa/`, while its Worker-served HTML, styles, install assets, and service worker live in `src/cloudflare/worker/pwa/`. `scripts/build-worker.mjs` builds the PWA client first, injects that bundle into the Worker build, and writes the deployable module to `.generated/cloudflare/worker.mjs`.

The Obsidian plugin and PWA share dock presentation, the Today/Upcoming switcher, tab dissolves, and project push/pop transitions in `src/ui/shared/navigation/`, alongside reminder panels, cards, and view-model logic. Host adapters retain viewport, safe-area, modal, persistence, and history behavior. `PluginWorkspace` keeps visited Reminders and Reading screens mounted in the same Obsidian pane, reads local vault repositories, and stores dock choices in Obsidian device-local storage. Existing view types and commands remain supported. Reading runtime subscriptions replace or remove the mounted library when its configuration changes. Both hosts compile the same semantic theme tokens; see [Shared plugin and PWA UI](ui-styling.md) for ownership and validation.

Reading and Reminders share the feature-independent view header, navigation bar,
buttons, icon buttons, and modal header under `src/ui/shared/`. Feature adapters
provide destinations, actions, data, and lifecycle behavior. The PWA supplies its
dock with direct section switching through a Reading navigation adapter and its reminder shell;
feature switching and per-section state retention stay in the PWA feature shell. Reading owns its
article layout and typography, while common controls use the same host tokens.

`src/ui/plugin/` owns Obsidian modal shells, native modal controls and React
mounting into plugin Shadow DOM. Shared controls and PWA modules cannot import
these adapters. Reading highlight controls keep saving and copy/share feedback in
`ReadingHighlightActions`; `reading-highlight-interaction.ts` owns selection,
gesture listeners and cleanup, while `reading-highlight-geometry.ts` places the
overlay from measured rectangles.

Shared icons and reduced-motion preferences live in `src/ui/shared/`; the Obsidian
icon renderer lives in `src/ui/obsidian-icon/`. Reminder import paths re-export
these implementations for existing feature consumers.

`src/pwa/main.tsx` mounts the feature shell. `components/RemindersRuntime.tsx` composes
reminder data, session, outbox, and editor hooks independently of the lazy screen.
Its screen-facing contract groups connection, sync, mutations, editor, status and
presentation models. The always-mounted provider retains hydration, recovery and
update-readiness registration when the reminders screen is hidden.
`useReminderSync` owns the confirmed snapshot and exposes reads and explicit
commit/reset operations. Indexing progress is separate from failure state, so an
HTTP 202 preparation response remains a syncing status without recovery attention.
Outbox consumers cannot independently replace its refs or React state. `useReminderEditor`
owns editor presentation, synchronous tap opening, close transitions, recovered
drafts, and session reset. `useReminderEditorActions` owns edit eligibility and
save/delete completion: drafts and editors remain open until durable enqueue succeeds
in the current session. `useReminderMutations` prepares and queues commands and
exposes a synchronous preparation guard for updates, without controlling the editor.
`useReminderProjectNavigation` keeps browser history, project exit completion and
focus restoration together; `PwaRemindersAppShell` renders that navigation state.

`protocol/shared-settings.ts` defines and validates shared settings for both hosts.
`sync/shared-settings.ts` applies them to plugin settings. Production Worker modules
cannot import plugin or sync implementation modules; ESLint enforces this boundary.

`pwa/reminder-outbox.ts` owns automatic retry eligibility. Mount, foreground,
connectivity and timer wakeups honor the stored deadline and attempt budget.
Explicit retry and earlier-session recovery reset that budget while retaining the
operation identity and request bytes.
`PendingReminderChange` ties each command kind to its required fields, HTTP method
and endpoint. Storage validation remains the boundary for persisted records; the
type does not reconstruct saved commands or change their request bytes.

`pwa/reminder-outbox-events.ts` groups browser wakeups and cross-tab confirmation
listeners under one subscription lifetime. `useReminderOutbox` retains queue
initialization, recovery and session ownership; delayed work from a disposed
subscription cannot trigger a new refresh or error toast.

Plugin feature requests use `src/plugin/server-request.ts` for validated server
metadata and lifecycle/connection guards before dispatch and after responses.
Reading adds its own capability requirements; shared feature settings require
only their own capability.

`ReminderAlarm` retains the Durable Object class, storage identities, and mutation
lock. `coordinator-requests.ts` dispatches coordinator endpoints with that lock,
keeping upload preparation outside it. `coordinator-alarms.ts` dispatches Reading,
maintenance, and projection roles; reminder delivery stays in `ReminderAlarm`.

`sync-batch/upload-validation.ts` decodes and validates upload candidates and
request budgets before storage work. `sync-batch/upload.ts` retains receipt
checks, encryption validation, staging and the bulk/conditional commit paths.
Per-file validation errors retain the batch response's partial-success behavior.
Single and bulk notification-source publication share ID, due-key and occurrence
aggregation in `worker/reminder-source-summary.ts`. Their specialized SQL and
atomic file-publication transactions remain separate.

`worker/file-publication-statements.ts` constructs per-file changelog and retained
version statements. Single-file publication requires its committed revision;
atomic moves retain both revision conditions. Each writer still owns transaction
assembly, receipts, projection work and recovery; bulk publication keeps its
specialized SQL.

`cloudflare/worker/routes/policy.ts` declares API methods, paths, token scopes and
execution, notification wakeup and projection initialization requirements.
Admission, scope authorization and request dispatch consume that policy. The
request handler retains authentication and guard ordering, including public grant
redemption and upload reauthentication. Route handlers retain folder,
feature and encryption guards, while public assets and Shortcut compatibility
handling retain their existing admission behavior. Reading handoff redemption
checks issuer scopes against the preparation route's policy.

The Worker is a separate build product. The production plugin includes gzip-compressed copies of `.generated/cloudflare/worker.mjs` and `src/cloudflare/schema.sql`. The Vite artifact plugin computes SHA-256 hashes at build time; Obsidian verifies them after decompression before deployment. No Worker code or schema is fetched from the network at runtime. The current candidate initializes schema 1 in `crate_schema`; see the checked [current contract](current-contract.md). Provisioning initializes empty databases and leaves current databases unchanged. Future upgrades use the explicit manifest and checkpoint boundary in [server upgrades](server-upgrades.md). Unsupported schemas are rejected without modification. See the [compatibility matrix](compatibility.md).

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

`reminders/core/reminderDraft.ts` also owns reconciliation of parsed text with
the current draft. Both editors pass already-parsed metadata, preserving relative
dates across renders. The plugin retains implicit initial-date provenance; the PWA
retains explicit timezone defaults and converts canonical dates into local fields.

`reminders/core/reminderSubmission.ts` resolves the latest editor text into saved
reminder fields for both hosts, including recurrence removal before draft effects
settle and preservation of an unchanged occurrence's exact timestamp. Adapters
retain modal callbacks, split date/time inputs and API null/undefined encoding.
Index and shared views reuse calendar membership rules in `reminderDate.ts` and
`reminderSort.ts`; each index/repository query captures one time snapshot.

The repeat grammar owns the cadence, weekday lists/ranges and monthly day. `reminderTime.ts` delegates the following time phrase to Chrono, retaining its complete span and time precision, so forms such as `every Monday at 9 in the morning` stay recurring. A bare `Monday 9` does not imply a time when Chrono leaves the number as text. Seconds, fractional seconds and timestamps follow Chrono's recognition. Repeat time ranges still cannot fit the single-time recurrence rule. Calendar dates following a repeat remain separate schedules, subject to the last-schedule rule.

One-off calendar recognition also belongs to Chrono. Dates, times and timestamps are not prevalidated or partially masked: when Chrono returns no match, the full phrase remains title text. Durable reads use the same recognition and require recognized schedules to be absolute.

Sync deletes require both the acknowledged content hash and opaque file revision. Recreating the same bytes produces a new revision, so an old delete cannot remove the new file. Missing revisions require reconciliation. Local remote-deletion application always uses vault trash so bytes written after the hash check remain recoverable. Supported text updates use Obsidian's atomic process API. Existing binary files are preserved and incoming bytes saved as conflict copies for explicit review because Obsidian exposes no atomic binary compare-and-swap.

See [the protocol contract](protocol.md) and [backup and recovery](recovery.md).

Encrypted Reading uses the trusted plugin/PWA for decryption, indexing, extraction and Markdown edits. `reading/encrypted-api.ts` owns the conditional ciphertext transport; `pwa/connection/` owns app enrollment and shared verification, while `pwa/reading/encryption-session.ts` and `private-storage.ts` adapt that readiness to Reading's protected local storage. The Worker stores ciphertext and public scope/policy metadata; its plaintext Reading projector/extractor remains only for unencrypted vaults. See [Reading encryption](reading-e2ee-assessment.md).

`encryption/file-inventory.ts` validates shared encrypted inventory pages and bounds
traversal independently of file counts. Reading and Reminders retain their own file
limits, projections and sequence checks; each publishes its derived source cache
only after a complete, confirmed load.

`encryption/` owns key bundles, authenticated formats and identity comparison. Both browser enrollment flows use `pwa/encryption-scope.ts` to validate complete folder authority before persisting keys. `sync/encrypted-files.ts` translates verified private metadata into local sync identities and maintains a bounded cache of authenticated metadata. `plugin/encryption-folder-move-journal.ts` owns the durable move contract, exact setting destinations and guarded journal-head updates. `encryption-folder-move-workflow.ts` applies one persisted job, keeping target persistence, conversion, both settings saves, capture recovery and journal advancement ordered together. `encryption-folder-moves.ts` retains task deduplication, queue draining and feature restarts through `SyncRuntime`'s existing configuration serialization.

`sync/encryption-conversion.ts` owns conversion sequencing, progress, server
acknowledgments and activation. `encryption-conversion-content.ts` authenticates
original or interrupted file bytes and prepares encrypted receipts with their
existing folder audience. These transformations run without network or storage
access, so integrity failures and receipt isolation can be tested directly.

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
