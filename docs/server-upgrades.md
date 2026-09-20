# Server release and upgrade contract

The first supported database is schema 1, with the complete current file inventory, receipts, reminder state and indexes. There are no historical database migrations to run. Developer databases using previous experimental markers are unsupported; they are never reset or interpreted as empty by the updater.

## Independent versions

`src/cloudflare/server-release.json` is shared by the plugin, Worker build and recovery tools:

- `revision` is a monotonically increasing server release number. Increment it whenever the deployable Worker, PWA, provisioning configuration, schema or migration plan changes for distribution. Never distribute different server artifacts under the same revision. The plugin package version can change independently.
- `schemaVersion` identifies the complete persisted database shape. Increment it for any change to `schema.sql`, including indexes. Never silently apply the fresh schema to an existing database.
- `minimumSchemaVersion` is the oldest supported database source. Keep it at 1 while that baseline is supported. Retiring an old source version never deletes its migration history or invalidates databases already upgraded from it.
- `migrations` is an ordered, contiguous registry, currently empty. Once released, its IDs, SQL bytes and SHA-256 checksums are immutable.

The artifact fingerprint includes the Worker/PWA bundle, fresh schema and release manifest. Migration files are checked against manifest checksums at build time and again before execution. D1 stores the successfully deployed revision, fingerprint, schema version and schema hash in `crate_release`. An older revision, a different fingerprint at the same revision, or a changed schema hash at the same schema version is rejected before deployment.

Wire protocol ranges, capabilities, parser versions and browser/local storage envelopes remain separate compatibility contracts. A server revision does not establish API compatibility. Keep old writers only while they preserve current invariants, and preserve exact pending operation bodies and IDs.

## Installation and update

1. Check resource identities, the schema, migration history and the deployed release.
2. Acquire the durable deployment fence and repeat those checks. Never substitute an empty database or bucket for missing saved storage.
3. Initialize an empty database from `schema.sql`. An existing current database receives no DDL. For a future supported older database, require a verified recovery checkpoint before applying its declared migrations.
4. Publish the Worker/PWA with the same database and bucket bindings, then configure its address and maintenance.
5. Read back the live artifact and bindings, query the database version, and probe the Worker metadata endpoint for the exact fingerprint, revision and schema version. The probe never sends the Cloudflare management token to the Worker.
6. Record the deployed release, persist successful verification and release the fence. Preserve file contents, hashes, revisions and local sync authority.

A failed check keeps writers fenced. **Check and recover update** resumes a confirmed or definitively rejected step with the exact same artifact, replacing ownership conditionally without an unlocked interval. Old updaters cannot advance once their ownership has been replaced. A definitively rejected Worker upload can also be replaced by a corrected build: recovery retains the fence, conditionally takes ownership, and reruns storage, schema and release checks before publication. Confirmed, settled or uncertain uploads still require their existing recovery paths. A first installation that has not yet created a Worker is recoverable too.

Acquiring or taking over the fence atomically records a confirmed acquisition checkpoint. Closing the app or losing the response immediately afterward remains recoverable, including repeated interruptions during recovery. The next provider mutation must first conditionally advance that exact ownership record; recovering a paused acquisition prevents the old owner from dispatching it.

When recovery cannot establish a safe checkpoint, the app offers **Check again** to perform a fresh check and **Cancel** to close the result. Diagnostics stay in the technical details disclosure. It does not ask users to attest provider quiescence or settle an uncertain upload through a checkbox; unresolved legacy operations retain the operator recovery workflow below.

New Worker uploads store a fresh random `uploadTag` in the durable checkpoint before dispatch, and send it as Cloudflare's `workers/tag` version annotation. Each tag is used for one request only; the transport must never retry that upload. **Check and recover update** can acknowledge a lost response when the live Worker has that exact tag, version, fingerprint, and original storage bindings. It conditionally changes only the inspected checkpoint to confirmed, retains the fence, and resumes the exact artifact through normal verification. A concurrent ownership change stops recovery. A crash during acknowledgment is recoverable on the next check.

A matching fingerprint without the unique tag is not sufficient. Legacy uploads, mismatched tags, unpublished requests, and a different installed artifact remain blocked. Hosted acceptance must test a published upload with a lost client response and verify that the live settings return its tag before distributing this flow. Cloudflare documents these [version annotations](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/).

A timed-out provider request remains uncertain. Do not infer completion from elapsed time or from a matching annotation. After an operator has stopped old deployment clients and established that all in-flight requests have settled, `scripts/crate-deployment-fence.py settle ... --confirm-quiescent` marks only the inspected owner as settled while retaining the fence. Then use **Check and recover update**. The script refuses to release an update that still needs verification.

## Adding the first real migration

Add a reviewed SQL file under `src/cloudflare/migrations/` and a manifest entry with `id`, `from`, `to`, `file` and `checksum`. Each step advances one schema version. The fresh schema sets both `version` and `created_version` to its current version. Receipt validation starts at `created_version`, so a fresh install of a future schema does not pretend to have executed historical migrations. The SQL must not contain transaction control or modify `crate_schema`, `crate_migrations` or deployment ownership. The runner supplies a source-version precondition, completion receipt and final schema marker in the same D1 transaction. A failed transaction changes none of them. The [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) batches semicolon-separated statements; [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) roll back the sequence on failure. On retry, inspect the committed version and receipts and skip completed steps.

Before distributing that migration, wire the provisioner's `beforeDatabaseUpgrade` hook into a verified paired D1/R2 backup workflow. It runs with writes fenced and must retain the original checkpoint across retries. No automatic backup UI is claimed or needed for the empty registry today; a build with migration steps and no checkpoint integration refuses to migrate. Recovery uses the same manifest and SQL against an isolated copy and preserves the original archive bytes.

For a large data copy, storage replacement, or Durable Object architecture change, add a dedicated resumable workflow with persisted progress. Do not put an unbounded copy in a single SQL step. Introduce the destination, backfill in bounded batches, verify references/counts/content hashes, switch access under the fence, then retire old structures in a later release. Decide explicitly whether writers can continue during backfill. Preserve R2 object references and retry receipts; a metadata redesign should not require client re-upload.

Keep a forward-fix path. Rolling Worker code back does not restore D1/R2 data. Historical recovery uses a matching paired archive in isolated resources and must account for writes after that archive.

## Release evidence

`npm run check` includes the server revision gate. `npm run check:server-revision` runs it independently against uncommitted changes relative to `HEAD`; use `npm run check:server-revision -- --base <git-ref>` to check a complete branch or release. It rebuilds the server and follows the Worker, PWA, provisioner and build-script dependency graphs, including shared UI and transitive Sass imports. Database SQL, migration artifacts and compilation settings are included explicitly. Dependency-lock changes conservatively require a revision too; plugin package version and descriptive metadata changes alone do not.

CI selects the complete comparison automatically: the PR base, the previous push tip, or the default branch for a new branch. Tag and manual release checks compare with the previous reachable release tag, falling back to the parent commit for the first release. Both workflows fetch full Git history. Missing references fail the check. A baseline predating the first release manifest is treated as its initial introduction. Revision decreases, schema edits without a schema version increase, and edits or removal of released migrations also fail.

For each schema change, freeze a real source-schema fixture and test every supported source through the current registry. Test rollback inside a step, interruption between steps, repeat application, missing/edited receipts, two competing updaters, same-version stale builds, live verification failure and exact-artifact recovery. Assert that unchanged file contents and operation identities survive. Use realistic large-vault fixtures for backfills. Run hosted acceptance with the exact distributable artifacts before release; local D1 runtime tests alone cannot establish hosted rollout behavior.

## Experimental cloud safety compatibility

Revision 59 preserves the experimental `CloudSafety` SQLite namespace as an inactive
export, including in the reset Worker. No application binding calls it and it does
not schedule alarms or modify its stored ledger. This permits updates from the
experimental safety build without deleting its namespace. Cloud safety enforcement
is not enabled by this compatibility export.
