# Server release and upgrade contract

The current candidate uses server revision 9 and schema 2. The complete schema 2 is the pre-launch baseline with no registered migrations. See the checked [current contract](current-contract.md). Databases from the retired, pre-reset development sequence are unsupported: preserve their data with the matching old build before creating a fresh deployment. **Delete server and all data** is independent of these upgrade requirements: it destroys the entire selected database and bucket without migrating or interpreting their application data.

## Independent versions

`src/cloudflare/server-release.json` is shared by the plugin, Worker build and recovery tools:

- `revision` is the public server release number. Advance it exactly once from the last published release when server inputs change, and keep it fixed throughout development of that release. Never distribute different stable server artifacts under the same revision. The plugin package version can change independently.
- `schemaVersion` identifies the complete persisted database shape. Increment it for any change to `schema.sql`, including indexes. Never silently apply the fresh schema to an existing database.
- `minimumSchemaVersion` is the oldest supported database source, currently 2. Future released migration history remains immutable.
- `migrations` is an ordered, contiguous registry. It is empty for the pre-launch baseline. Once released, their IDs, SQL bytes and SHA-256 checksums are immutable.

The artifact fingerprint includes the Worker/PWA bundle, fresh schema and release manifest. Migration files are checked against manifest checksums at build time and again before execution. D1 stores the successfully deployed revision, fingerprint, schema version and schema hash in `crate_release`. An older revision, a different stable fingerprint at the same revision, or a changed schema hash at the same schema version is rejected before deployment. Development builds additionally store a fingerprint-bound identity in `maintenance_state`, in the same transaction as the verified release record.

Wire protocol ranges, capabilities, parser versions and browser/local storage envelopes remain separate compatibility contracts. A server revision does not establish API compatibility. Keep old writers only while they preserve current invariants, and preserve exact pending operation bodies and IDs.

## Installation and update

1. Check resource identities, the schema, migration history and the deployed release.
2. Acquire the durable deployment fence and repeat those checks. Never substitute an empty database or bucket for missing saved storage.
3. Initialize an empty database from `schema.sql`. An existing current database receives no DDL. For a supported older database, require a verified recovery checkpoint before applying its declared migrations.
4. Publish the Worker/PWA with the same database and bucket bindings, then configure its address and maintenance.
5. Read back the live artifact and bindings, query the database version, and probe the Worker metadata endpoint for the exact fingerprint, revision and schema version. The probe never sends the Cloudflare management token to the Worker.
6. Record the deployed release, persist successful verification and release the fence. Preserve file contents, hashes, revisions and local sync authority.

A failed check keeps writers fenced. **Check and recover update** resumes a confirmed or definitively rejected step with the exact same artifact, replacing ownership conditionally without an unlocked interval. Old updaters cannot advance once their ownership has been replaced. A definitively rejected Worker upload can also be replaced by a corrected build: recovery retains the fence, conditionally takes ownership, and reruns storage, schema and release checks before publication. Confirmed, settled or uncertain uploads still require their existing recovery paths. A first installation that has not yet created a Worker is recoverable too.

Acquiring or taking over the fence atomically records a confirmed acquisition checkpoint. Closing the app or losing the response immediately afterward remains recoverable, including repeated interruptions during recovery. The next provider mutation must first conditionally advance that exact ownership record; recovering a paused acquisition prevents the old owner from dispatching it.

A definite Cloudflare rejection while acquiring ownership preserves the provider error, including D1 quota and permission failures. It does not imply an interrupted update: recovery can correctly report no held lock while the rejected write remains blocked. Timeouts, transport failures and server errors still require recovery because ownership may have been recorded.

When recovery cannot establish a safe checkpoint, the app offers **Check again** to perform a fresh check and **Cancel** to close the result. Diagnostics stay in the technical details disclosure. It does not ask users to attest provider quiescence or settle an uncertain upload through a checkbox; unresolved legacy operations retain the operator recovery workflow below.

New Worker uploads store a fresh random `uploadTag` in the durable checkpoint before dispatch, and send it as Cloudflare's `workers/tag` version annotation. Each tag is used for one request only; the transport must never retry that upload. **Check and recover update** can acknowledge a lost response when the live Worker has that exact tag, version, fingerprint, and original storage bindings. It conditionally changes only the inspected checkpoint to confirmed, retains the fence, and resumes the exact artifact through normal verification. A concurrent ownership change stops recovery. A crash during acknowledgment is recoverable on the next check.

A matching fingerprint without the unique tag is not sufficient. Legacy uploads, mismatched tags, unpublished requests, and a different installed artifact remain blocked. Hosted acceptance must test a published upload with a lost client response and verify that the live settings return its tag before distributing this flow. Cloudflare documents these [version annotations](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/).

A timed-out provider request remains uncertain. Do not infer completion from elapsed time or from a matching annotation. After an operator has stopped old deployment clients and established that all in-flight requests have settled, `scripts/crate-deployment-fence.py settle ... --confirm-quiescent` marks only the inspected owner as settled while retaining the fence. Then use **Check and recover update**. The script refuses to release an update that still needs verification.

## Adding migrations

Add a reviewed SQL file under `src/cloudflare/migrations/` and a manifest entry with `id`, `from`, `to`, `file` and `checksum`. Each step advances one schema version. The fresh schema sets both `version` and `created_version` to its current version. Receipt validation starts at `created_version`, so a fresh install of a future schema does not pretend to have executed historical migrations. The SQL must not contain transaction control or modify `crate_schema`, `crate_migrations` or deployment ownership. The runner supplies a source-version precondition, completion receipt and final schema marker in the same D1 transaction. A failed transaction changes none of them. The [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) batches semicolon-separated statements; [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) roll back the sequence on failure. On retry, inspect the committed version and receipts and skip completed steps.

The provisioner creates and verifies a paired D1/R2 checkpoint before applying a registered migration. Database write guards remain active until the new deployment is verified, and the original checkpoint is retained across retries. Self-hosted updates require a stopped server and a verified backup through the explicit upgrade command. Recovery uses the same manifest and SQL against an isolated copy and preserves the original archive bytes. See the [Reading testing guide](read-it-later-testing.md) for commands.

For a large data copy, storage replacement, or Durable Object architecture change, add a dedicated resumable workflow with persisted progress. Do not put an unbounded copy in a single SQL step. Introduce the destination, backfill in bounded batches, verify references/counts/content hashes, switch access under the fence, then retire old structures in a later release. Decide explicitly whether writers can continue during backfill. Preserve R2 object references and retry receipts; a metadata redesign should not require client re-upload.

Keep a forward-fix path. Rolling Worker code back does not restore D1/R2 data. Historical recovery uses a matching paired archive in isolated resources and must account for writes after that archive.

## Release evidence

`npm run check` includes the server revision gate. `npm run check:server-revision` runs it independently. Local checks and CI compare the complete server input graph with the latest reachable published GitHub release (including published prereleases), ignoring drafts. GitHub CLI access and full Git/tag history are required. Release runs exclude the tag being packaged. The committed `scripts/server-release-policy.json` pins the pre-launch source baseline and initial public revision 8. Later published releases define the baseline for subsequent candidates. All development releases at or before that baseline are retired. The unpublished baseline may discard development migration entries; after publication, migration immutability and schema/revision checks apply normally. Keep the baseline fixed after launch. Repositories without an explicit baseline use their earliest manifest commit before first publication. `--base <git-ref>` explicitly overrides baseline selection for audits.

A changed server requires exactly the next public revision; skipped numbers, decreases, schema edits without a schema version increase, and edits/removal of released migrations fail. Worker, PWA, provisioner, shared UI, Sass, build configuration and dependency-lock inputs are covered. Plugin package version and descriptive metadata changes alone do not require a server revision.

## Testing development deployments

Choose the next public revision once in `src/cloudflare/server-release.json`. Build for your specific Cloudflare test Worker:

```sh
CRATE_DEV_WORKER=crate-0123456789abcdef npm run build:dev
```

Replace the example name with your development Worker's name. To save it for future builds, add `CRATE_DEV_WORKER=crate-0123456789abcdef` (with your actual Worker name) to the ignored `.env.development.local` file. `npm run dev`, `npm run build:dev`, and `npm run build:worker:dev` read this setting; a shell value takes precedence. The watcher rebuilds when environment files change. The existing development-vault configuration controls where the plugin is copied. Reload the plugin and open Crate settings. The update notice automatically compares the live build when needed, then offers **Update server**. **Check for updates** remains available to retry an unsuccessful check. The bundled and live version displays include labels such as `3-dev.1` and `3-dev.2`.

The ignored root file `server-development.local.json` holds a readable version such as `{ "version": "1-dev.2" }`. Each development Worker build increments it automatically; it can also be edited locally without committing it. A new public revision starts its own development sequence at 1. Stable builds leave this file untouched. Keep it across builds, including when cleaning `.generated/`. If it is lost or you change computers, set its version to at least the last deployed development build for the current public revision before rebuilding. Concurrent builds should use separate checkouts. A reused number with different bytes and older build numbers are rejected.

Development artifacts are restricted to the exact Worker named at build time. For other Workers, settings explain that the bundled development build cannot update that server and offer no update or retry action; startup does not advertise it as an available update. The first development build must target a revision newer than the installed stable release. Successive development builds can replace each other within that revision; `npm run build` produces a stable build that can replace the development build at the same revision. Once stable is installed, start development of the next revision. Stable plugin/server packaging and release verification reject development artifacts.

Development updates retain schema checks, migration receipts, verified backups when required, deployment ownership, exact-artifact recovery and live verification. Do not edit migrations already applied to a database you retain. Protocol, parser and stored-format versions remain independent of the development counter. This workflow targets plugin-managed Cloudflare deployments; the self-hosted storage compatibility contract is unchanged.

For each schema change, freeze a real source-schema fixture and test every supported source through the current registry. Test rollback inside a step, interruption between steps, repeat application, missing/edited receipts, two competing updaters, same-version stale builds, live verification failure and exact-artifact recovery. Assert that unchanged file contents and operation identities survive. Use realistic large-vault fixtures for backfills. Run hosted acceptance with the exact distributable artifacts before release; local D1 runtime tests alone cannot establish hosted rollout behavior.

## Experimental cloud safety compatibility

Revision 59 preserves the experimental `CloudSafety` SQLite namespace as an inactive
export, including in the reset Worker. No application binding calls it and it does
not schedule alarms or modify its stored ledger. This permits updates from the
experimental safety build without deleting its namespace. Cloud safety enforcement
is not enabled by this compatibility export.

## Saved revision in plugin settings

The plugin saves `cloudflareDeployment.lastKnownRevision` in its local settings
only after a verified deployment, completed recovery, or successful live version
check. The startup notice uses the saved artifact fingerprint to suggest reviewing
an update. If a cached live check or the connected server's saved revision is newer
than the plugin's bundled revision, it explains that updating the server requires
a newer plugin build instead. Settings show the required server revision and keep
server downgrades blocked. In settings, the update row automatically checks the
server when its saved revision is missing or equal to the bundled revision. Successful checks
populate the saved revision; opening the separate server details alone does not
start a request. Cached revisions
are informational; deployment verification and update authorization still inspect
the live server.

Settings distinguish a newer revision from a fingerprint mismatch. A recent live
result is reused for 30 seconds for the same client, server address and deployment
identity, so reopening settings does not require another check. Failed checks
offer a manual retry. Matching stable revision numbers
with different builds require a higher server revision. For a development server,
a live check can enable a newer development build or promotion to stable within
the same revision; the database and deployment fence recheck eligibility before
publication. Cached revision numbers alone cannot authorize that replacement.
Matching live artifacts still route to publication recovery when saved deployment
metadata has not been confirmed.

## Revision 2: optional local features and full article saves

Reading and Reminders start enabled in the plugin; explicit disabled preferences
are preserved. Their switches stop local scanning without changing other devices.
Reading saves request full article extraction. A library client's explicit full
article save also enables extraction on servers with a legacy disabled policy.
Capture-only Shortcut credentials cannot change that policy. Existing article
access and legacy bookmark-only capture requests remain supported. No schema
migration is needed.

## Revision 3: shared feature pause/resume

`shared-features-v1` adds a server-authoritative policy independent of push and
article-extraction preferences. Both features default on. The policy is stored in
`maintenance_state` under `crate_feature_policy`; no schema migration is needed.
Plugin switches require this capability and do not pretend an older server was
paused. Local enabled flags cache the server state rather than overwriting it.

Pausing stops server APIs and background work without deleting sources, indexes,
credentials, or queued work. Reading checks before fetching and publication;
reminder alarms retain their occurrence and recipient progress without polling
while paused. Resume queues existing schedules with the same identity, preserves
completed deliveries, and wakes pending projections and extraction. Notification
retry-age limits remain in effect; a pause does not make old notifications valid
indefinitely. Requests already sent to websites or push providers cannot be recalled.

## Revision 4: stable shortcut capture and diagnostics

`reading-shortcut-transport-v1` separates native capture requests from the app
wire protocol. The Worker retains narrow adapters for the released preparation
headers 1 and 11, so existing paired shortcuts resume saving after the server
update. No schema migration or new library credential is required.

Template revision 2 uses the versioned capture API and presents a public fallback
when no usable launch URL is returned. The live save page provides update,
reconnect, and retry guidance, copyable private-data-free diagnostics, and a
GitHub issue draft. It reports success only after the durable handoff receipt.
Publish the fallback page before distributing the new template and update the
Worker before encouraging its installation. See [shortcut maintenance](reading-shortcuts.md).

## In-app checkpoint restore

In-app and Python recovery share table-reset, maintenance-marker and history-retention
rules in `src/cloudflare/restore/restore-policy.json`. Both run the fixture in
`tests/fixtures/recovery/` to verify that credentials and source operation markers
are discarded while queued captures and operation receipts survive. Each adapter
keeps its own schema migration and destination publication workflow.

The in-app restore adapter supports source schema 2 into the current
schema-2 database. Schema 2 adds only the durable Reading capture queue, so restore
preserves queued captures (including their retry state and notes) alongside the
Reading policy and generation. Schema-1 archives are unsupported. Credentials and derived extraction jobs are still reset, and migration
receipts are validated before creating destination resources. Future target
schemas remain blocked until their recovery adapter is implemented.
