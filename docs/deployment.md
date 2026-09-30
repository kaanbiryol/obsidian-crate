# Deploying and operating the server

For persistent local D1, R2, and Durable Objects, follow [self-hosting](self-hosting.md).
The Cloudflare account, R2 activation and OAuth instructions below apply only
to Cloudflare-hosted deployments.

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

Enable the `refresh_token` grant so the setup login can renew usage access; Cloudflare adds the `offline_access` protocol scope automatically. Do not enable `openid`, Implicit, or any client-secret authentication method. Crate is a public client and uses a fresh PKCE S256 verifier for each authorization.

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

## Activate R2 before connecting

Crate currently requires an active R2 subscription in the Cloudflare account that owns the server. This is a one-time account setup, including when you intend to stay within the free allowance. Cloudflare requires a valid payment method during checkout. Enter payment details only in Cloudflare; Crate does not collect them or activate the subscription through its OAuth connection. See Cloudflare's [R2 prerequisites](https://developers.cloudflare.com/r2/get-started/#before-you-begin) and [billing setup](https://developers.cloudflare.com/billing/get-started/create-billing-profile/).

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and select the account you will authorize in Crate.
2. Open **Storage & databases → R2 → Overview**.
3. Complete the R2 checkout flow, reviewing its terms and adding a payment method if requested.
4. Once R2 is active, return to **Settings → Crate** in Obsidian and select **Connect with Cloudflare**. Authorize the same account.

Crate creates its own bucket, database, Worker, and reminder resources. You do not need to create those resources or generate an API token manually. Other devices connecting to this server reuse the account's active R2 subscription.

### R2 free allowance and billing

R2 Standard currently includes 10 GB-month of storage, 1 million Class A operations (such as writes and listings), and 10 million Class B operations (such as reads) per month, with free outbound data transfer. The free allowance is shared across the account; it is not a separate allowance for every vault or bucket. Infrequent Access storage is excluded from the free tier. Usage above the allowance is billed, so free usage does not remove the payment-method requirement. Check [Cloudflare's current R2 pricing](https://developers.cloudflare.com/r2/pricing/) before activating it.

Stored data includes retained file versions as well as current vault files. Other Cloudflare services have their own limits and pricing. Crate's **Cloudflare usage** panel provides estimates, not a spending cap. The current server cannot complete setup without R2 activation.

### R2 activation error

If Crate shows **R2 is not active for this Cloudflare account** (Cloudflare error `10042`):

1. Follow the [activation steps above](#activate-r2-before-connecting) for the account selected during authorization. Adding a payment method alone does not complete R2 activation; finish the R2 checkout flow.
2. Return to Crate and select **Connect with Cloudflare** again, authorizing that same account.
3. If the error persists even though R2 is active, check the selected account and its R2 subscription status in Cloudflare. Contact Cloudflare support if it still rejects access to an active subscription.

Crate saves resource names and Cloudflare IDs so retries can reuse the deployment. You do not need to delete the server or reset your vault to resolve this prerequisite.

## OAuth connection and deployment

1. [Activate R2](#activate-r2-before-connecting) in the target Cloudflare account, including its checkout and payment-method requirements.
2. Install the Client-ID-configured Crate build.
3. Open **Settings → Crate → Configuration** and select **Connect with Cloudflare**. On mobile, select **Open Cloudflare** in the dialog to open the sign-in page in your browser.
4. In Cloudflare, select exactly one account, review the five permissions, and authorize Crate.
5. Cloudflare returns to the static callback page. It removes the OAuth query from the browser URL immediately and opens `obsidian://crate-cloudflare-oauth`. If Obsidian does not open automatically, select **Open Obsidian** on that page.
6. Crate verifies the random OAuth state before exchanging the code with its in-memory PKCE verifier.
7. Crate discovers existing `crate-<deployment-id>` Workers and their bindings. It reuses the only match automatically, asks the user to choose when several exist, or creates a new Worker, D1 database, R2 bucket, Durable Objects, and workers.dev endpoint when none exists. Joining an existing deployment does not upload code or change schema. Creation initializes the hash-verified current schema. Explicit updates verify the schema marker before installing the new Worker. A newer remote Worker is never downgraded.
8. Crate registers this device's hashed credential through the Cloudflare D1 API, then saves the OAuth access and refresh tokens in Obsidian secret storage for explicit usage and server management operations. Failed operations revoke newly exchanged tokens; operations using an existing saved login retain it. Existing installations can select **Reconnect** under **Account and devices** to authorize again.
9. Connection does not transfer vault files. Open the command palette and select **Crate: Sync - sync now** to sync this vault with the server.

If the Cloudflare API returns R2 error `10042`, follow [R2 activation error](#r2-activation-error). When the installed plugin contains different Worker, web app, or schema artifacts, **Update server** appears and reuses those same Worker, D1, R2, and Durable Object resources. It is hidden when the server already has the exact embedded artifact or was deployed by a newer plugin version.

Server updates use the saved Cloudflare login and renew it when needed. **Update server** opens Cloudflare authorization only when credentials are missing, revoked, cannot be renewed, or lack required permissions. Network and server errors are shown in Obsidian without starting another login. Reconnect, repair, reset, and deletion also reuse the saved login. Reset and deletion retain their destructive-action confirmations and resource checks. First-time setup and new devices sign in through Cloudflare.

Cloudflare account access is the source of truth for vault devices. The plugin never exposes a Worker claim page or a vault-device setup link. A device credential can be created or rotated only using valid Cloudflare authorization, either saved or newly obtained.

## Connecting another device

Install Crate on the other device, open **Settings → Crate → Configuration**, and select **Connect with Cloudflare**. Authorize the account that owns the vault's Crate server. When that account has multiple Crate servers, choose the matching Worker in Obsidian.

## Supported protocol and schema

App writes use the current protocol range in [the release contract](current-contract.md). Both clients verify the server before mutations; the Worker rejects missing or incompatible protocol headers with 428. Native capture uses the separate [Shortcut contract](reading-shortcuts.md), including narrow adapters for released templates.

Provisioning initializes empty databases from the hash-verified `src/cloudflare/schema.sql` at version 3. Schema 1 is the first supported baseline; schemas 1 and 2 upgrade through the registered migrations after a verified recovery checkpoint. Existing schema-3 databases receive no DDL. Unsupported schemas and missing saved databases stop without replacing storage.

The ordered server revision and schema identity are recorded in D1 after live verification. Different stable artifacts sharing a server revision cannot replace each other. Explicitly targeted development builds use a separate ordered build number and may promote to stable; see [development deployments](server-upgrades.md#testing-development-deployments). Updates preserve the database and bucket bindings, file references, history and receipts. The deployment fence stays held until the exact Worker, database version and metadata endpoint are verified.

**Check and recover update** resumes confirmed or definitively rejected steps with the exact artifact under new ownership. Uncertain provider requests remain blocked until their outcome is settled. Recovery archives preserve the baseline without rewriting their source. See the [server upgrade contract](server-upgrades.md) for future migrations, backup requirements and safe operator recovery, and the [compatibility matrix](compatibility.md) for client formats.

### Reminder parser upgrades

The reminder parser version controls both the disposable web list cache and a separate durable source verification record. After a semantic parser upgrade, an unchanged file's old source identities, queued notification commands, and installed alarms cannot authorize delivery until its current R2 revision has been parsed by the installed version. Reuploading unchanged bytes is unnecessary. The notification coordinator automatically walks Markdown paths in indexed pages of 100 and reparses at most two files and 2 MiB per invocation. Each invocation also projects at most one file. A separate invocation of the existing Durable Object class dispatches up to five alarm commands, giving scanning and dispatch separate D1 query budgets without another class migration. It persists progress, resumes after interruption, after a reminder folder is selected. It visits only that folder and its descendants. Authenticated access initializes this work once per parser version, and mutations arm processing before the write. Pending work continues through finite coordinator alarms; no recurring maintenance cron remains.

Verification updates source identities and projection jobs in one guarded D1 transaction. Existing occurrence first-observation timestamps are retained, so a genuine reminder first observed before its deadline remains eligible within the delivery window when revalidation finishes late. Confirmed code examples and other excluded Markdown contexts remove their obsolete projections and cancel their alarms. Unreadable bytes, unsupported metadata, and unresolved schedules remain quarantined, preserve prior identities, and authorize no derived cancellation or notification. Failed sources are retried after an hour or immediately when repaired file bytes commit. Duplicate identities remain quarantined until repaired.

**Run diagnostics** reports the source parser version, queued verification count, quarantined source count, and per-source projection issues. Counts cover discovered source rows while the bounded file scan is running. An isolated restore clears source verification records and rebuilds them from the restored R2 bytes. Do not restore an old parser build over a current deployment to bypass source issues; repair the source notes or use a forward update. Notifications already dispatched by the old Worker before the new build starts cannot be recalled.

## Concurrent updates, resets, and abandoned operations

Current Crate builds serialize updates, resets, and deletions using the reserved `crate_deployment_fence` row in the deployment's D1 `maintenance_state` table. Each attempt receives a fresh owner ID. Crate verifies the live Worker's database and bucket bindings, acquires the row atomically, then checks the remote build again before publishing. A completed intervening update stops an older attempt even when both builds have the same version number but different artifacts. The row contains operation identity and build information; it contains no OAuth credentials or vault content.

The fence covers schema changes, Worker publication, schedules, endpoint setup, and reset's destructive requests. A second operation stops before changing those resources. A new deployment first finds or creates its exact named database, saves the ID locally, and confirms that the name resolves to that single database. Initial creation relies on Cloudflare rejecting duplicate database names within the account: its [official Wrangler D1 client](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/create.ts) handles provider error `7502` as an existing database name. Only that definite conflict permits lookup after a failed create; a lost create response stops the attempt before publication. Discovery does not have to be immediately consistent: no visible matching database or multiple matching IDs stops provisioning. Empty databases may contain only the fence bootstrap table before schema initialization. Competing initial attempts use the same database once discoverable. A failed first attempt can leave this owned empty database or partially provisioned resources for a later retry; Crate does not delete them as rollback.

The fence has no timeout. Updates release it only after live verification. Reset may release it after a settled failure; terminal deletion carries `deletionPending: true` until its original database is removed, including after local save failures or definite provider rejections. A lost response, shutdown, or other uncertain mutation outcome leaves the row held because an accepted Cloudflare request may still complete. Deletion saves resource identities and progress independently of reset/rebuild checkpoints. Once its database is gone, no original resource is recreated. Isolated backup restoration removes the archived fence row from the restored database.

For interrupted deletion, reconnect to the network and select **Crate settings → Advanced server actions → Resume server deletion**. Crate rechecks the original resource identities and replaces the inspected row by compare-and-swap. It can repeat terminal Worker, object, bucket, and database deletion after lost responses: late deletes converge on removing the same original resources. Each resume rotates the cleanup capability. An uncertain helper publication requires its unique provider-visible upload receipt, or operator review, before another upload can begin. Never manually recreate resources under the original names during deletion.

Permanent deletion can supersede any confirmed, definitively rejected, or operator-settled operation for the exact selected Worker. It does not interpret that operation’s application version, recovery protocol number, step name, database schema, or verification requirements. The old client loses ownership without opening the server to writes. An unresolved update/reset request still blocks destruction if it could publish or recreate resources. This boundary concerns request completion, not application compatibility. **Resume server deletion** remains available after a failed deletion; regular connect, switch, repair, update, and rebuild actions stay blocked.

This is coordination among current Crate clients, not a Cloudflare publication precondition. The [Worker upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) does not document a D1 owner token or `If-Match` publication condition. Older Crate builds and direct dashboard/API operations do not honor this fence. For future rollouts, stop incompatible update/reset clients and allow accepted provider requests to finish. Keep direct administration quiescent during a Crate deployment or reset. An old client or administrator with account write access can bypass this coordination.

To inspect a held operation, use Python 3 and a short-lived account-scoped token with D1 read/write permission. Supply the token through `CLOUDFLARE_API_TOKEN`, not a command-line argument. Obtain the account, database, and Worker identifiers from the saved deployment metadata or the Cloudflare dashboard:

```bash
python3 scripts/crate-deployment-fence.py inspect \
  --account <account-id> --database <database-id> --worker crate-<deployment-id>
```

If another device is still working, let it finish. For an abandoned operation, stop **every** deployment/reset client for this server and revoke the credentials they were using. Then establish that no already accepted or in-flight provider mutations can still complete: inspect the live Worker version, bindings, resource state, and provider activity; use Cloudflare support when an outstanding request's outcome cannot be established. Revoking a token or waiting a fixed interval alone does not cancel an already accepted request. Keep the fence held while that outcome is uncertain.

Only after establishing quiescence, inspect again. Use `settle` with the exact inspected owner to retain the lock and allow permanent deletion. To preserve data during an update, recover it using its matching plugin build. Legacy reset recovery may use `release`; terminal deletion refuses release because its storage must finish being removed.

```bash
python3 scripts/crate-deployment-fence.py settle \
  --account <account-id> --database <database-id> --worker crate-<deployment-id> \
  --owner <inspected-owner-id> --confirm-quiescent
```

Both `settle` and `release` use the exact inspected row and cannot erase a replacement owner. They cannot cancel an accepted provider request: `--confirm-quiescent` asserts the operator resolved those requests. For terminal deletion, use `settle` followed by **Resume server deletion**; do not release its lock. If the original database has already been deleted, resume this vault’s saved deletion progress without creating a lock in another database. If a cleanup-helper upload is still marked uncertain locally after D1 removal, retain the saved settings and inspect that exact helper and upload receipt before altering the checkpoint.

## Recovery and deletion

- If the browser handoff fails, select **Open Obsidian** on the callback page.
- If OAuth expires, return to Crate settings and start again. Authorization state and PKCE material are intentionally not recoverable after plugin reload.
- **Disconnect this device** clears the Worker URL and device secret but retains the non-secret deployment identity, allowing a later Cloudflare sign-in to reuse the same Worker. It never deletes Cloudflare resources.
- Replaced and deleted sync objects remain recoverable for 30 days through **File history** in a file’s context menu or **Sync Activity → History → File history** (including deleted files). Recovery verifies the retained bytes and refuses to overwrite a remote path that changed after the recovery screen was opened.
- **Run diagnostics** reports manifest access, pending backend queues, and the last scheduled-maintenance result. Use it after a server upgrade and before relying on a newly seeded vault.
- To destroy the server and synced data, select **Advanced server actions → Delete server and all data**. The Cloudflare dashboard remains available for manual administration.

For paired D1/R2 backup verification and isolated restore commands, use [Backup and recovery](recovery.md).

## Delete a Crate server

**Settings → Crate → Advanced server actions → Delete server and all data** permanently removes this server and its remote data for all devices. Local vault files and other deployments are kept. The confirmation identifies the account, Worker, database, and file bucket. Crate reuses the saved Cloudflare login when available. Cancelling confirmation performs no deletion.

Deletion is a terminal resource operation, separate from reset, upgrade, and rebuild. It verifies the saved account, exact Worker/database/bucket identities, Worker and bucket creation identities, and resource sharing by other Workers. It does not read application tables, schema markers, protocol numbers, server revisions, semantic versions, or remote file references. Changed or shared resource identities stop deletion to protect other servers; arbitrary binding names, configuration, and Durable Object class names do not impose release-specific restrictions.

The confirmation authorizes the entire selected D1 database and R2 bucket. Every listed object is removed, including unknown old/future formats, manual uploads, backups, history, and opaque keys containing dot segments. Crate does not try to classify these objects as known Crate files. This also permits deletion when the database required by an old reset flow is already missing.

Crate saves deletion progress before destructive requests and disconnects local sync. It deletes the original Worker through Cloudflare’s [Worker deletion API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/) and verifies that its owned Durable Object namespaces are gone, regardless of class name. It uses normal deletion so Cloudflare can reject references from another Worker. A separate, uniquely named `crate-delete-<deletion-id>` helper empties the selected bucket without any D1 binding. Crate removes the empty bucket, deletes the exact original database, then removes the helper. It neither uploads a replacement original Worker nor recreates storage.

File cleanup uses the isolated helper’s authenticated endpoint and [R2’s native array delete](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2bucket-method-definitions). Requests contain at most 1,000 keys and at most 1,100,000 serialized bytes. Listing restarts from the first page after each batch so removals cannot skip later objects. Crate verifies the helper and bucket identities before each batch and requires a public readiness response matching that exact upload receipt. Keep the plugin open; this is an interactive, resumable operation.

The Cloudflare account token is never sent to the helper endpoint. Each attempt generates an ephemeral 256-bit cleanup capability in memory and publishes only its SHA-256 hash as helper configuration. The helper has access only to the selected bucket and accepts bounded batches after capability authentication; it serves no sync or write routes. D1, while present, records deployment ownership and request checkpoints. Once D1 is absent, an uncertain helper upload is checkpointed locally using its provider receipt. Progress counts only verified responses. Lost object-delete responses resume by re-listing remaining keys.

Remote files, retained versions, recovery history, shared server settings, device registrations, subscriptions, and reminder state are erased. Local vault files are kept. To sync again, select **Connect with Cloudflare**, create a new server, then select **Crate: Sync - sync now**. Reconnect other devices and set up web push again. Deletion does not recreate a server or upload local files. Independently exported backups, files cached on other devices, and Cloudflare-managed logs or retention are outside this deletion.

If a request or local save fails, use **Resume server deletion** under **Advanced server actions**. Keep this vault’s saved plugin settings. The checkpoint identifies the original resources, and regular connection and update actions remain blocked until deletion finishes. Do not manually change its Cloudflare resources or rename unrelated resources to bypass an ownership check.

The separate rebuild action has been removed. An unfinished rebuild from an earlier release can be resumed using that release to preserve its behavior, or superseded by terminal deletion for a fresh start. No obsolete build is required just to delete the selected server.

### Start fresh after the development numbering reset

Crate 0.4.0 uses launch protocol 1. Retired development servers reporting protocols such as 10 may also have higher server revisions and unrelated database formats. Reconnecting registers device access to that existing server; it does not publish a new Worker or migrate its database. Retrying the connection test cannot resolve this incompatibility.

If the local vault is the source for a fresh server, stop old clients and select **Crate settings → Advanced server actions → Delete server and all data**. Crate verifies ownership and can take over a settled update checkpoint as described above. After deletion finishes, select **Connect with Cloudflare**, create a new server, and select **Crate: Sync - sync now**. Local vault files are kept; the old server's remote data is permanently removed. Keeping remote-only data instead requires the matching old build and its backup/recovery tools.

If deletion still needs review, retain its technical details and inspect the held operation using the command above. An unresolved provider request requires confirmed quiescence before `settle --owner <inspected-owner-id> --confirm-quiescent`; then retry deletion. Do not lower schema/revision markers or erase the fence to make the old deployment appear compatible. Automated coverage includes `server-delete.test.ts`, `server-delete-worker.integration.ts`, `deployment-lifecycle.test.ts`, and `plugin-integration.test.ts`. Hosted deletion and physical-device acceptance still require manual verification.

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
