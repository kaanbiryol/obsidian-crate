# Deploying and operating the server

Crate deploys its Cloudflare server from inside Obsidian with OAuth Authorization Code + PKCE. The callback at `crate.kaanbiryol.com` is a static GitHub Pages handoff; it does not exchange tokens or provision infrastructure.

## One-time GitHub Pages setup

The site in `site/` is independent of the `kaanbiryol.com` blog repository. The Pages workflow in `.github/workflows/pages.yml` publishes only this repository's `site/` directory.

1. In the `obsidian-crate` repository, open **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Run **Deploy GitHub Pages** or merge a `site/` change into `master` and wait for the workflow to finish.
4. In **Settings → Pages → Custom domain**, enter `crate.kaanbiryol.com` and save it.
5. In the authoritative DNS zone for `kaanbiryol.com`, create exactly this record:

   | Type | Name | Target | Proxy |
   |---|---|---|---|
   | `CNAME` | `crate` | `kaanbiryol.github.io` | DNS only initially |

   Do not point the record at the repository name and do not change the apex records used by the existing blog.
6. After GitHub finishes its DNS and certificate checks, enable **Enforce HTTPS** in **Settings → Pages**.
7. Confirm that both `https://crate.kaanbiryol.com/` and `https://crate.kaanbiryol.com/oauth/callback/` load directly over HTTPS.

GitHub recommends configuring the custom domain in the repository before changing DNS. The committed `site/CNAME` is a redundant declaration of the same custom domain; the Actions workflow otherwise deploys a completely static artifact.

## One-time Cloudflare OAuth client setup

Cloudflare's current public-client process requires domain ownership verification for the OAuth **Client URL**. A DNS name cannot have both a CNAME and a TXT record, so using `crate.kaanbiryol.com` as the Client URL would conflict with the GitHub Pages CNAME. Use the apex publisher domain for the Client URL and keep the Pages subdomain as the redirect URI.

In the Cloudflare dashboard, select the account that will own the OAuth client, then open **Manage Account → OAuth clients → Create client**. Enter:

| Field | Exact value |
|---|---|
| Client name | `Crate` |
| Response type | `code` |
| Grant type | `authorization_code` and `refresh_token` |
| Token authentication method | `none` |
| Redirect URL | `https://crate.kaanbiryol.com/oauth/callback/` |
| Client URL | `https://kaanbiryol.com` |
| Logo URL | `https://crate.kaanbiryol.com/assets/logo.png` |
| Privacy policy URL | `https://crate.kaanbiryol.com/privacy/` |
| Terms URL | Leave empty |
| Allowed CORS origins | Leave empty |
| Post-logout redirect URLs | Leave empty |

Enable the `refresh_token` grant so the setup login can renew usage access; Cloudflare adds the `offline_access` protocol scope automatically. Do not enable `openid`, Implicit, or any client-secret authentication method. Crate is a desktop public client and uses a fresh PKCE S256 verifier for each authorization.

Select these five scopes in the dashboard. Keep all five scopes required. Both deployment and usage explicitly request all five; both also request `offline_access`. Retained usage credentials therefore include server management permissions as well as analytics access. The usage panel uses those credentials only to retrieve usage and renew access.

| Cloudflare scope label | OAuth scope ID | Why Crate needs it |
|---|---|---|
| Workers Scripts Write (shown as **Workers Scripts Edit** in some dashboard accounts) | `workers-scripts.write` | Upload the Worker module, declare Durable Object bindings, configure the account workers.dev subdomain, and enable the script endpoint |
| D1 Write (may be shown as **D1 Edit**) | `d1.write` | Find/create the D1 database and initialize its schema |
| Workers R2 Storage Write (may be shown as **Workers R2 Storage Edit**) | `workers-r2.write` | Find/create the R2 bucket |
| Memberships Read | `memberships.read` | Call `GET /memberships` to discover the account ID selected during consent |
| Account Analytics Read | `account-analytics.read` | Read account-wide Workers, D1, and R2 usage |

Cloudflare is transitioning permission labels from **Edit** to **Write**. Its current permissions reference lists **Workers Scripts Edit** as granting write access, so select the **Edit** entry when the dashboard does not show **Write**. OAuth scope names correspond to API-token permission names, and the scope ID returned by `GET /oauth/scopes` is the value used by the client. The IDs above are the dot-delimited IDs configured in Crate. Before promoting the client, confirm the five displayed labels and IDs against the authenticated `GET /oauth/scopes` response for the client-owner account; do not add broader account or zone scopes.

Create the client. It starts private, which means only members of its parent account can authorize it. Copy the **Client ID**; Crate neither needs nor accepts a client secret.

For public visibility:

1. Keep **Client URL** set to `https://kaanbiryol.com`.
2. Copy Cloudflare's exact verification value, including its `cloudflare_oauth_client_publisher=` prefix.
3. Add a DNS record at the apex:

   | Type | Name | Value |
   |---|---|---|
   | `TXT` | `@` | The exact value Cloudflare generated |

4. Wait for Cloudflare to mark the domain verified. It polls for up to two days; use **Restart verification** if that window expires.
5. After testing the private client, use its action menu to change visibility to **Public**. Cloudflare documents that this promotion is permanent.

The apex TXT record can coexist with the existing blog's apex web records and does not require a change to that blog repository. Do not add the verification TXT at `crate`; that owner name is already the GitHub Pages CNAME.

The public Client ID is embedded in the repository's build configuration, so a normal production build is sufficient:

```bash
npm run build
```

For private testing or a future client rotation, override the embedded ID for one build with `CRATE_CLOUDFLARE_OAUTH_CLIENT_ID=<32-character-client-id> npm run build`.

Official references:

- [Create a Cloudflare OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Integrate with Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare memberships API](https://developers.cloudflare.com/api/resources/memberships/methods/list/)
- [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

## OAuth connection and deployment

1. Enable R2 in the target Cloudflare account. Cloudflare may require accepting the R2 subscription before its API permits bucket creation.
2. Install the Client-ID-configured Crate build.
3. Open **Settings → Crate → Configuration** and select **Connect with Cloudflare**.
4. In Cloudflare, select exactly one account, review the five permissions, and authorize Crate.
5. Cloudflare returns to the static callback page. It removes the OAuth query from the browser URL immediately and opens `obsidian://crate-cloudflare-oauth`.
6. Crate verifies the random OAuth state before exchanging the code with its in-memory PKCE verifier.
7. Crate discovers existing `crate-<deployment-id>` Workers and their bindings. It reuses the only match automatically, asks the user to choose when several exist, or creates a new Worker, D1 database, R2 bucket, Durable Objects, and workers.dev endpoint when none exists. Joining an existing deployment does not upload code or change schema. Creation initializes the hash-verified current schema. Explicit updates verify the schema marker before installing the new Worker. A newer remote Worker is never downgraded.
8. Crate registers this device's hashed credential through the Cloudflare D1 API, then saves the OAuth access and refresh tokens in Obsidian secret storage for usage. Failed operations revoke and discard their tokens. Existing installations can reconnect once from the usage panel.
9. Connection does not transfer vault files. Open the command palette and select **Crate: Sync now** to sync this vault with the server.

If the Cloudflare API returns R2 error `10042`, Crate tells the user to activate the R2 subscription and try again. Resource names and Cloudflare IDs are saved without credentials, so retries converge on the same deployment. When the installed plugin contains different Worker, web app, or schema artifacts, **Update server** appears and reuses those same Worker, D1, R2, and Durable Object resources. It is hidden when the server already has the exact embedded artifact or was deployed by a newer plugin version.

Server updates use the saved Cloudflare login and renew it when needed. **Update server** opens Cloudflare authorization only when credentials are missing, revoked, cannot be renewed, or lack required permissions. Network and server errors are shown in Obsidian without starting another login. Reconnect, repair, reset, and deletion also reuse the saved login. Reset and deletion retain their destructive-action confirmations and resource checks. First-time setup and new devices sign in through Cloudflare.

Cloudflare account access is the source of truth for vault devices. The plugin never exposes a Worker claim page or a vault-device setup link. A device credential can be created or rotated only using valid Cloudflare authorization, either saved or newly obtained.

## Connecting another device

Install Crate on the other device, open **Settings → Crate → Configuration**, and select **Connect with Cloudflare**. Authorize the account that owns the vault's Crate server. When that account has multiple Crate servers, choose the matching Worker in Obsidian.

## Supported protocol and schema

Protocol 7 is required for writes. Both clients verify the server before mutations; the Worker rejects missing or incompatible protocol headers with 428. Only the current prerelease formats are supported.

Provisioning initializes empty databases from the hash-verified `src/cloudflare/schema.sql` at version 1. This is the first supported baseline; the historical experimental schema upgrades have been removed. Existing baseline databases receive no implicit DDL. Unsupported schemas and missing saved databases stop without replacing storage.

The ordered server revision and schema identity are recorded in D1 after live verification. Different artifacts sharing a server revision cannot replace each other. Updates preserve the database and bucket bindings, file references, history and receipts. The deployment fence stays held until the exact Worker, database version and metadata endpoint are verified.

**Check and recover update** resumes confirmed or definitively rejected steps with the exact artifact under new ownership. Uncertain provider requests remain blocked until their outcome is settled. Recovery archives preserve the baseline without rewriting their source. See the [server upgrade contract](server-upgrades.md) for future migrations, backup requirements and safe operator recovery, and the [compatibility matrix](compatibility.md) for client formats.

### Reminder parser upgrades

The reminder parser version controls both the disposable web list cache and a separate durable source verification record. After a semantic parser upgrade, an unchanged file's old source identities, queued notification commands, and installed alarms cannot authorize delivery until its current R2 revision has been parsed by the installed version. Reuploading unchanged bytes is unnecessary. The notification coordinator automatically walks Markdown paths in indexed pages of 100 and reparses at most two files and 2 MiB per invocation. Each invocation also projects at most one file. A separate invocation of the existing Durable Object class dispatches up to five alarm commands, giving scanning and dispatch separate D1 query budgets without another class migration. It persists progress, resumes after interruption, after a reminder folder is selected. It visits only that folder and its descendants. Authenticated access initializes this work once per parser version, and mutations arm processing before the write. Pending work continues through finite coordinator alarms; no recurring maintenance cron remains.

Verification updates source identities and projection jobs in one guarded D1 transaction. Existing occurrence first-observation timestamps are retained, so a genuine reminder first observed before its deadline remains eligible within the delivery window when revalidation finishes late. Confirmed code examples and other excluded Markdown contexts remove their obsolete projections and cancel their alarms. Unreadable bytes, unsupported metadata, and unresolved schedules remain quarantined, preserve prior identities, and authorize no derived cancellation or notification. Failed sources are retried after an hour or immediately when repaired file bytes commit. Duplicate identities remain quarantined until repaired.

**Run diagnostics** reports the source parser version, queued verification count, quarantined source count, and per-source projection issues. Counts cover discovered source rows while the bounded file scan is running. An isolated restore clears source verification records and rebuilds them from the restored R2 bytes. Do not restore an old parser build over a current deployment to bypass source issues; repair the source notes or use a forward update. Notifications already dispatched by the old Worker before the new build starts cannot be recalled.

## Concurrent updates, resets, and abandoned operations

Current Crate builds serialize updates, resets, and deletions using the reserved `crate_deployment_fence` row in the deployment's D1 `maintenance_state` table. Each attempt receives a fresh owner ID. Crate verifies the live Worker's database and bucket bindings, acquires the row atomically, then checks the remote build again before publishing. A completed intervening update stops an older attempt even when both builds have the same version number but different artifacts. The row contains operation identity and build information; it contains no OAuth credentials or vault content.

The fence covers schema changes, Worker publication, schedules, endpoint setup, and reset's destructive requests. A second operation stops before changing those resources. A new deployment first finds or creates its exact named database, saves the ID locally, and confirms that the name resolves to that single database. Initial creation relies on Cloudflare rejecting duplicate database names within the account: its [official Wrangler D1 client](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/create.ts) handles provider error `7502` as an existing database name. Only that definite conflict permits lookup after a failed create; a lost create response stops the attempt before publication. Discovery does not have to be immediately consistent: no visible matching database or multiple matching IDs stops provisioning. Empty databases may contain only the fence bootstrap table before schema initialization. Competing initial attempts use the same database once discoverable. A failed first attempt can leave this owned empty database or partially provisioned resources for a later retry; Crate does not delete them as rollback.

The fence has no timeout. For updates it is released only after live verification. A definite provider rejection is recorded so the exact build can resume safely. Reset/deletion fences may release after a settled failure before any uncertain request. A timeout, lost response, plugin shutdown, or other uncertain mutation outcome leaves the row held, because an already accepted Cloudflare request may still complete. Crate reports this state and directs the operator to the recovery tool below. Reset checkpoints remain saved. Once reset deletes the old database, its temporary Worker and matching reset checkpoint exclude other clients until the original reset rebuilds the server. Isolated backup restoration removes the archived fence row from the restored database.

For an interrupted **Delete server** operation, reconnect to the network and select **Crate settings → Advanced server actions → Resume server deletion**. After checking resource ownership and the exact retirement Worker, Crate can atomically replace a deletion lock at a confirmed acquisition/retirement/file/bucket deletion checkpoint, or at an interrupted `deleteR2Objects` step. A late file deletion is compatible with permanently removing that same server; Crate re-lists its bucket and never rebuilds these resources. Older `deleteR2Object` checkpoints remain supported. Each new owner receives a fresh cleanup credential, invalidating previous credentials for requests that have not already dispatched. The replacement uses the exact inspected row, so the previous client cannot checkpoint or dispatch another step. Uncertain Worker publication, bucket deletion, and reset operations still require review. Do not manually recreate resources under the deleted server’s old names.

This is coordination among current Crate clients, not a Cloudflare publication precondition. The [Worker upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) does not document a D1 owner token or `If-Match` publication condition. Older Crate builds and direct dashboard/API operations do not honor this fence. For future rollouts, stop incompatible update/reset clients and allow accepted provider requests to finish. Keep direct administration quiescent during a Crate deployment or reset. An old client or administrator with account write access can bypass this coordination.

To inspect a held operation, use Python 3 and a short-lived account-scoped token with D1 read/write permission. Supply the token through `CLOUDFLARE_API_TOKEN`, not a command-line argument. Obtain the account, database, and Worker identifiers from the saved deployment metadata or the Cloudflare dashboard:

```bash
python3 scripts/crate-deployment-fence.py inspect \
  --account <account-id> --database <database-id> --worker crate-<deployment-id>
```

If another device is still working, let it finish. For an abandoned operation, stop **every** deployment/reset client for this server and revoke the credentials they were using. Then establish that no already accepted or in-flight provider mutations can still complete: inspect the live Worker version, bindings, resource state, and provider activity; use Cloudflare support when an outstanding request's outcome cannot be established. Revoking a token or waiting a fixed interval alone does not cancel an already accepted request. Keep the fence held while that outcome is uncertain.

Only after establishing quiescence, inspect again. For a pending update use `settle` and then **Check and recover update** in its matching plugin build. For reset/deletion use `release`, with the exact owner shown by the tool:

```bash
python3 scripts/crate-deployment-fence.py release \
  --account <account-id> --database <database-id> --worker crate-<deployment-id> \
  --owner <inspected-owner-id> --confirm-quiescent
```

The conditional release cannot erase a replacement owner, but it cannot fence an old in-flight upload. The confirmation asserts that the operator resolved those requests; the script cannot prove it. Keep the original vault's reset checkpoint and select **Resume server deletion** after release (legacy rebuilds must be recovered using the version that started them). For an interrupted update, `release` refuses to discard pending verification. Use `settle` followed by **Check and recover update** instead. If the original database was successfully deleted, there is no fence left to clear: resume the saved reset/deletion checkpoint rather than creating a replacement lock in another database.

## Recovery and deletion

- If the browser handoff fails, select **Open Obsidian** on the callback page.
- If OAuth expires, return to Crate settings and start again. Authorization state and PKCE material are intentionally not recoverable after plugin reload.
- **Disconnect this device** clears the Worker URL and device secret but retains the non-secret deployment identity, allowing a later Cloudflare sign-in to reuse the same Worker. It never deletes Cloudflare resources.
- Replaced and deleted sync objects remain recoverable for 30 days under **Settings → Crate → Recovery and troubleshooting → File history**. Recovery verifies the retained bytes and refuses to overwrite a remote path that changed after the recovery screen was opened.
- **Run diagnostics** reports manifest access, pending backend queues, and the last scheduled-maintenance result. Use it after a server upgrade and before relying on a newly seeded vault.
- To destroy the server and synced data, explicitly delete its Worker, R2 bucket, D1 database, and Durable Object resources in the Cloudflare dashboard.

For paired D1/R2 backup verification and isolated restore commands, use [Backup and recovery](recovery.md).

## Delete a Crate server

**Settings → Crate → Advanced server actions → Delete server and all data** permanently removes this server and its remote data for all devices. Local vault files and other deployments are kept. The confirmation identifies the account, Worker, database, and file bucket. Crate reuses the saved Cloudflare login when available. Cancelling confirmation performs no deletion.

Deletion verifies exact deployment names and IDs, live Crate annotations and bindings, database tables, bucket creation identity, and ownership of the ReminderAlarm namespace. It checks other Workers for shared D1, R2, Durable Object, and service bindings. Unreadable ownership information, unexpected bindings or namespaces, newer server versions, unknown database tables, or unknown bucket objects stop deletion. It never searches by name prefix to choose resources to delete.

Before deletion, the entire bucket listing is inspected, including every page. Allowed objects are Crate's generated upload keys, `__crate__/settings.json`, and legacy or retained keys explicitly referenced by Crate's database. Arbitrary files placed in the bucket block deletion. Objects are checked again during deletion.

After verification, local sync disconnects and Crate saves a deletion checkpoint. It deploys a temporary Worker that returns HTTP 503 for normal sync and web routes and removes the ReminderAlarm namespace using Cloudflare's [deleted-class export](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class). Cloudflare rejects this operation if another Worker binds the namespace. Once the namespace is confirmed absent, Crate empties and deletes the verified R2 bucket, deletes the exact D1 database, and removes the temporary Worker. Other deployments are kept.

File cleanup uses the temporary Worker's authenticated bulk endpoint and [R2's native array delete](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2bucket-method-definitions), with at most 1,000 keys per request. A 7,992-object bucket needs eight deletion requests plus listing, verification and checkpoint calls. Crate verifies the helper is live at the account's workers.dev address before sending a batch. The client stays open and sends one bounded batch at a time; this is not an unattended background job.

The Cloudflare account token is never sent to the cleanup endpoint. Every fence owner generates an ephemeral 256-bit cleanup credential, held only in memory. D1 stores its SHA-256 hash and the hash of the exact authorized batch. The Worker checks that credential, reset identity, active fence step, exact batch, and object ownership, then rechecks the fence before calling R2. Ordinary vault credentials cannot authorize cleanup. Progress advances only after a verified response. A failed or lost response preserves the fence; permanent deletion resumes by listing remaining objects, while legacy rebuild recovery retains stricter rules because it recreates storage. An older retirement stub is upgraded under the fence without repeating the Durable Object class deletion.

Remote files, retained versions, recovery history, shared server settings, device registrations, subscriptions, and reminder state are erased. Local vault files are kept. To sync again, select **Connect with Cloudflare**, create a new server, then select **Crate: Sync now**. Reconnect other devices and set up web push again. Deletion does not recreate a server or upload local files. Independently exported backups, files cached on other devices, and Cloudflare-managed logs or retention are outside this deletion.

If a request or local save fails, use **Resume server deletion** under **Advanced server actions**. Keep this vault’s saved plugin settings. The checkpoint identifies the original resources, and regular connection and update actions remain blocked until deletion finishes. Do not manually change its Cloudflare resources or rename unrelated resources to bypass an ownership check.

The separate rebuild action has been removed. If an earlier version left an unfinished rebuild, complete recovery using that version before changing the connection. Crate preserves the checkpoint and blocks conflicting operations.

### Notification abuse limits

New deployments bind `NOTIFICATION_REQUEST_LIMITER` to Cloudflare's Rate Limiting API (60 notification writes per minute per source-address hash, Worker hostname and Cloudflare location). Unknown mutation routes return 404 before D1 or authentication. Invalid bearer credentials and expired/invalid enrollment grants cannot spend authenticated quotas. After authority verification, a D1 transaction charges both per-session/action and daily budgets only when both admit the request. Valid enrollment exchanges and authenticated management have separate 1,000-request UTC-day pools. A blocked action cannot exhaust another action's daily allowance. Anonymous traffic can still consume authentication reads and edge capacity, especially across many source addresses; these controls do not claim a global cap on anonymous D1 reads or total account cost. The binding is included in deployment ownership checks. Older/local configurations without the binding have only an isolate-local fallback and should be updated.

An older/local configuration without the binding uses a bounded per-isolate fallback. It is not a global abuse guarantee. Cloudflare's limiter is also location-scoped and eventually consistent; hosted request volume and ordinary Worker quotas still need monitoring. See the [official Rate Limiting API documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).


### Interrupted operation checkpoints

New deployment locks record the last server-change step and whether its response was confirmed. The inspection script displays these fields. A started step with no confirmation remains uncertain; the step record is evidence for recovery, not permission to release the lock automatically. Older locks have no step information.

File-upload recovery checkpoints confirmed receipts every 16 uploads and saves a partial group if recovery fails. Reopening after another interruption replays only the remaining uncheckpointed operations, using their original operation IDs.


### Recover an interrupted update in Crate

Select **Check and recover update** beside the update notice, or under **Server and usage → Interrupted server update**. Crate uses the saved Cloudflare login to inspect the live Worker, its storage bindings, and the operation record.

A confirmed, definitively rejected, or operator-settled update can resume with the exact artifact using an exact-value ownership replacement. Writes stay fenced throughout resumption and verification. The previous updater cannot send its next mutation after recovery wins that comparison. A checkpoint from before database/code changes can be safely released instead, after which the result dialog offers **Update server**.

When address activation is confirmed and the live Worker matches the saved update fingerprint, a newer plugin can finish verification without the old artifact. It conditionally takes ownership, checks the Worker and storage bindings, validates the supported database schema and migration history, and probes the public route for the saved fingerprint. It records the actual published revision, verifies completion, and releases the lock. It never uploads code in this path or downgrades a recorded release. Uncertain requests and incompatible schemas remain blocked. After successful verification, select **Update server** to install the current plugin's server build.

An unconfirmed address activation has a narrow recovery path: Crate reads Cloudflare's Worker subdomain settings and requires `enabled: true` and `previews_enabled: false` before taking ownership, then rechecks them and verifies the published build and database. Protocol 1 always requests those exact flags, so a delayed repeat cannot upload old code or alter vault data. The previous updater cannot advance after the ownership comparison changes. Recovery sends no activation request. Ordinary updates also read these settings and skip activation when they already match.

New uploads carry a unique request tag in both the saved checkpoint and Cloudflare's version metadata. If the upload succeeded but its response was lost, **Check and recover update** matches that tag, build and storage, confirms the exact checkpoint conditionally, and resumes verification inside Crate. It keeps sync locked until verification finishes; no dashboard action is needed for this case. Each upload dispatch must have a fresh tag and must not be retried by the transport.

Other unconfirmed requests, older uploads without a unique tag, reset/deletion, mismatched servers, and ownership changes remain blocked. The dialog explains the result and offers **Copy diagnostics**. These diagnostics contain server identifiers, build fingerprints, operation identifiers and step metadata, but no credentials or vault contents. They help support inspect the provider outcome; they do not prove an unconfirmed request has stopped.

Reminder folder changes save locally with a server-bound pending update before any
network request. Startup, reconnect, foreground sync and periodic checks retry it.
Only an explicit pending edit updates an existing server folder; ordinary policy
initialization cannot overwrite it. Acknowledging an older update cannot clear a
newer local edit.
