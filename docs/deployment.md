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
| Grant type | `authorization_code` only |
| Token authentication method | `none` |
| Redirect URL | `https://crate.kaanbiryol.com/oauth/callback/` |
| Client URL | `https://kaanbiryol.com` |
| Logo URL | `https://crate.kaanbiryol.com/assets/logo.png` |
| Privacy policy URL | `https://crate.kaanbiryol.com/privacy/` |
| Terms URL | Leave empty |
| Allowed CORS origins | Leave empty |
| Post-logout redirect URLs | Leave empty |

Do not enable `refresh_token`, `openid`, `offline_access`, Implicit, or any client-secret authentication method. Crate is a desktop public client and uses a fresh PKCE S256 verifier for each authorization.

Select only these four scopes in the dashboard:

| Cloudflare scope label | OAuth scope ID | Why Crate needs it |
|---|---|---|
| Workers Scripts Write (shown as **Workers Scripts Edit** in some dashboard accounts) | `workers-scripts.write` | Upload the Worker module, declare Durable Object bindings, configure the account workers.dev subdomain, and enable the script endpoint |
| D1 Write (may be shown as **D1 Edit**) | `d1.write` | Find/create the D1 database and initialize its schema |
| Workers R2 Storage Write (may be shown as **Workers R2 Storage Edit**) | `workers-r2.write` | Find/create the R2 bucket |
| Memberships Read | `memberships.read` | Call `GET /memberships` to discover the account ID selected during consent |

Cloudflare is transitioning permission labels from **Edit** to **Write**. Its current permissions reference lists **Workers Scripts Edit** as granting write access, so select the **Edit** entry when the dashboard does not show **Write**. OAuth scope names correspond to API-token permission names, and the scope ID returned by `GET /oauth/scopes` is the value used by the client. The IDs above are the dot-delimited IDs configured in Crate. Before promoting the client, confirm the four displayed labels and IDs against the authenticated `GET /oauth/scopes` response for the client-owner account; do not add broader account or zone scopes.

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
4. In Cloudflare, select exactly one account, review the four permissions, and authorize Crate.
5. Cloudflare returns to the static callback page. It removes the OAuth query from the browser URL immediately and opens `obsidian://crate-cloudflare-oauth`.
6. Crate verifies the random OAuth state before exchanging the code with its in-memory PKCE verifier.
7. Crate discovers existing `crate-<deployment-id>` Workers and their bindings. It reuses the only match automatically, asks the user to choose when several exist, or creates a new Worker, D1 database, R2 bucket, Durable Objects, and workers.dev endpoint when none exists. Joining an existing deployment does not upload code or change schema. Creation initializes the hash-verified current schema. Explicit updates verify the schema marker before installing the new Worker. A newer remote Worker is never downgraded.
8. Crate registers this device's hashed credential through the Cloudflare D1 API, then revokes and discards the access token.
9. Connection does not transfer vault files. For a new server, run **Initial sync → Upload all** when ready. When joining an existing server, run **Sync now** instead.

If the Cloudflare API returns R2 error `10042`, Crate tells the user to activate the R2 subscription and try again. Resource names and Cloudflare IDs are saved without credentials, so retries converge on the same deployment. When the installed plugin contains different Worker, web app, or schema artifacts, **Authorize update** appears and reuses those same Worker, D1, R2, and Durable Object resources. It is hidden when the server already has the exact embedded artifact or was deployed by a newer plugin version.

Cloudflare account access is the source of truth for vault devices. The plugin never exposes a Worker claim page or a vault-device setup link. A device credential can be created or rotated only during a successful Cloudflare OAuth session.

## Connecting another device

Install Crate on the other device, open **Settings → Crate → Configuration**, and select **Connect with Cloudflare**. Authorize the account that owns the vault's Crate server. When that account has multiple Crate servers, choose the matching Worker in Obsidian.

## Supported protocol and schema

Protocol 7 is required for writes. Both clients verify the server before mutations; the Worker rejects missing or incompatible protocol headers with 428. Only the current prerelease formats are supported.

Provisioning initializes an empty database from the bundled, hash-verified `src/cloudflare/schema.sql`. Existing databases must contain `crate_schema` with version 2, 3, 4 or 5. Versions 2/3/4 upgrade additively to 5: upload receipts and a live storage-key index are added, alongside the deletion receipts and authoritative source verification needed by older schemas. Existing vault rows are preserved. Both initialization and this additive upgrade can be retried idempotently after interruption. Other schemas are rejected before Worker upload, without changing their data; no portable-path backfill is bundled.

Apply the schema before installing the new Worker. The serving schema-2 or schema-3 Worker can continue using existing tables during this additive upgrade; only the new Worker enforces current parser authority for notifications, and schema-2 Workers do not record deletion receipts. Take a paired D1/R2 backup before updating. Do not remove the added tables or lower the marker to roll back: fixes must preserve schema 5, its audit records, and source verification rules. A full historical rollback requires the matching old build, its recovery tools, and its paired backup restored to isolated resources, and excludes writes made after that backup. The current recovery tools archive and verify schema-2, schema-3, schema-4 and schema-5 deployments before any update; isolated restoration upgrades schema-2/3/4 archives additively before installing the current server. The source archive is preserved. See the [complete compatibility matrix and rollback policy](compatibility.md).

An explicit update of a current-schema deployment preserves resource IDs and data. Downgrade checks use the current remote deployment metadata and repeat after acquiring deployment ownership. Older prerelease deployments require separate current resources; keep their original deployment and paired backup intact for recovery. Do not point the new Worker at an unsupported database.

### Reminder parser upgrades

The reminder parser version controls both the disposable web list cache and a separate durable source verification record. After a semantic parser upgrade, an unchanged file's old source identities, queued notification commands, and installed alarms cannot authorize delivery until its current R2 revision has been parsed by the installed version. Reuploading unchanged bytes is unnecessary. The notification coordinator automatically walks Markdown paths in indexed pages of 100 and reparses at most two files and 2 MiB per invocation. Each invocation also projects at most one file and dispatches at most two alarm commands so their combined work stays within the D1 query budget. It persists progress, resumes after interruption, and runs even before a notification policy is configured. Scheduled maintenance starts or resumes this work at most every 15 minutes; pending work continues through coordinator alarms.

Verification updates source identities and projection jobs in one guarded D1 transaction. Existing occurrence first-observation timestamps are retained, so a genuine reminder first observed before its deadline remains eligible within the delivery window when revalidation finishes late. Confirmed code examples and other excluded Markdown contexts remove their obsolete projections and cancel their alarms. Unreadable bytes, unsupported metadata, and unresolved schedules remain quarantined, preserve prior identities, and authorize no derived cancellation or notification. Failed sources are retried after an hour or immediately when repaired file bytes commit. Duplicate identities remain quarantined until repaired.

**Run diagnostics** reports the source parser version, queued verification count, quarantined source count, and per-source projection issues. Counts cover discovered source rows while the bounded file scan is running. An isolated restore clears source verification records and rebuilds them from the restored R2 bytes. Do not restore an old parser build over a current deployment to bypass source issues; repair the source notes or use a forward update. Notifications already dispatched by the old Worker before the new build starts cannot be recalled.

## Concurrent updates, resets, and abandoned operations

Current Crate builds serialize updates, resets, and deletions using the reserved `crate_deployment_fence` row in the deployment's D1 `maintenance_state` table. Each attempt receives a fresh owner ID. Crate verifies the live Worker's database and bucket bindings, acquires the row atomically, then checks the remote build again before publishing. A completed intervening update stops an older attempt even when both builds have the same version number but different artifacts. The row contains operation identity and build information; it contains no OAuth credentials or vault content.

The fence covers schema changes, Worker publication, schedules, endpoint setup, and reset's destructive requests. A second operation stops before changing those resources. A new deployment first finds or creates its exact named database, saves the ID locally, and confirms that the name resolves to that single database. Initial creation relies on Cloudflare rejecting duplicate database names within the account: its [official Wrangler D1 client](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/create.ts) handles provider error `7502` as an existing database name. Only that definite conflict permits lookup after a failed create; a lost create response stops the attempt before publication. Discovery does not have to be immediately consistent: no visible matching database or multiple matching IDs stops provisioning. Empty databases may contain only the fence bootstrap table before schema initialization. Competing initial attempts use the same database once discoverable. A failed first attempt can leave this owned empty database or partially provisioned resources for a later retry; Crate does not delete them as rollback.

The fence has no timeout. It is released after settled successful requests or a definite provider rejection. A timeout, lost response, plugin shutdown, or other uncertain mutation outcome leaves the row held, because an already accepted Cloudflare request may still complete. Crate reports this state and directs the operator to the recovery tool below. Reset checkpoints remain saved. Once reset deletes the old database, its temporary Worker and matching reset checkpoint exclude other clients until the original reset rebuilds the server. Isolated backup restoration removes the archived fence row from the restored database.

This is coordination among current Crate clients, not a Cloudflare publication precondition. The [Worker upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) does not document a D1 owner token or `If-Match` publication condition. Older Crate builds and direct dashboard/API operations do not honor this fence. Before rolling out this build, stop update/reset activity on older devices, upgrade them, and allow any accepted provider requests to finish. Keep direct administration quiescent during a Crate deployment or reset. An old client or administrator with account write access can bypass this coordination.

To inspect a held operation, use Python 3 and a short-lived account-scoped token with D1 read/write permission. Supply the token through `CLOUDFLARE_API_TOKEN`, not a command-line argument. Obtain the account, database, and Worker identifiers from the saved deployment metadata or the Cloudflare dashboard:

```bash
python3 scripts/crate-deployment-fence.py inspect \
  --account <account-id> --database <database-id> --worker crate-<deployment-id>
```

If another device is still working, let it finish. For an abandoned operation, stop **every** deployment/reset client for this server and revoke the credentials they were using. Then establish that no already accepted or in-flight provider mutations can still complete: inspect the live Worker version, bindings, resource state, and provider activity; use Cloudflare support when an outstanding request's outcome cannot be established. Revoking a token or waiting a fixed interval alone does not cancel an already accepted request. Keep the fence held while that outcome is uncertain.

Only after establishing quiescence, inspect again and release the exact owner shown by the tool:

```bash
python3 scripts/crate-deployment-fence.py release \
  --account <account-id> --database <database-id> --worker crate-<deployment-id> \
  --owner <inspected-owner-id> --confirm-quiescent
```

The conditional release cannot erase a replacement owner, but it cannot fence an old in-flight upload. The confirmation asserts that the operator resolved those requests; the script cannot prove it. Keep the original vault's reset checkpoint and select **Resume server reset** or **Resume server deletion** after release. For an interrupted update, refresh the server status and authorize the update again. If the original database was successfully deleted, there is no fence left to clear: resume the saved reset/deletion checkpoint rather than creating a replacement lock in another database.

## Recovery and deletion

- If the browser handoff fails, select **Open Obsidian** on the callback page.
- If OAuth expires, return to Crate settings and start again. Authorization state and PKCE material are intentionally not recoverable after plugin reload.
- **Disconnect this device** clears the Worker URL and device secret but retains the non-secret deployment identity, allowing a later Cloudflare sign-in to reuse the same Worker. It never deletes Cloudflare resources.
- Replaced and deleted sync objects remain recoverable for 30 days under **Settings → Crate → Infrastructure → Restore remote file**. Recovery verifies the retained bytes and refuses to overwrite a remote path that changed after the recovery screen was opened.
- **Run diagnostics** reports manifest access, pending backend queues, and the last scheduled-maintenance result. Use it after a server upgrade and before relying on a newly seeded vault.
- To destroy the server and synced data, explicitly delete its Worker, R2 bucket, D1 database, and Durable Object resources in the Cloudflare dashboard.

For paired D1/R2 backup verification and isolated restore commands, use [Backup and recovery](recovery.md).

## Reset a Crate server

**Settings → Crate → Recovery and troubleshooting → Troubleshooting → Reset server** erases this deployment's remote vault data and rebuilds it. The confirmation identifies the account, Worker, D1 database, and R2 bucket. Each attempt requires confirmation and fresh Cloudflare OAuth authorization. Cancelling authorization performs no remote deletion.

The reset verifies exact deployment names and IDs, live Crate annotations and bindings, database tables, bucket creation identity, and ownership of the ReminderAlarm namespace. It checks other Workers for shared D1, R2, Durable Object, and service bindings. Unreadable ownership information, unexpected bindings or namespaces, newer server versions, unknown database tables, or unknown bucket objects stop the reset. It never searches by name prefix to choose resources to delete.

Before deletion, the entire bucket listing is inspected, including every page. Allowed objects are Crate's generated upload keys, `__crate__/settings.json`, and legacy or retained keys explicitly referenced by Crate's database. Arbitrary files placed in the bucket block the reset. Objects are checked again during deletion.

After verification, local sync disconnects and Crate saves a reset checkpoint. It deploys a temporary Worker that returns HTTP 503 and removes the ReminderAlarm namespace using Cloudflare's [deleted-class export](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class). Cloudflare rejects this operation if another Worker binds the namespace. Once the namespace is confirmed absent, Crate empties and deletes the verified R2 bucket, deletes the exact D1 database, and recreates the server. The Worker name and server address remain the same; account settings and other deployments are not reset.

Remote files, retained versions, recovery history, shared server settings, device registrations, subscriptions, and reminder state are erased. Local vault files are kept. After success, run **Initial sync → Upload all**, reconnect other devices, and enroll web push again. Crate does not upload vault files automatically as part of the reset. Independently exported backups, files cached on other devices, and Cloudflare-managed logs or retention are outside this reset.

If a request or local save fails, use **Resume server reset** in the same section. The saved checkpoint identifies the original resources and distinguishes cleanup from rebuilding, so a retry does not wipe newly provisioned data. Regular connection and update actions are blocked while a reset is pending. Keep this vault's plugin settings and avoid manually changing its Cloudflare resources until the reset finishes. Do not rename unrelated resources to bypass a failed ownership check.

**Delete server** in **Settings → Crate → Recovery and troubleshooting → Troubleshooting** permanently removes this vault’s verified Crate Worker/web app, database, file bucket and contents, and reminder state without rebuilding. Local vault files and other deployments are kept. It requires confirmation of the exact resources and fresh Cloudflare authorization. Shared resources or unrecognized data block deletion. After an interruption, use **Resume server deletion**; connecting, updating, and resetting remain blocked until deletion completes.

### Notification abuse limits

New deployments bind `NOTIFICATION_REQUEST_LIMITER` to Cloudflare's Rate Limiting API (60 notification writes per minute per Worker hostname and Cloudflare location). Unknown notification mutation routes return 404 before D1 or authentication. The edge binding bounds requests reaching the database even when source addresses rotate; D1 then enforces a global ceiling of 1,000 admitted attempts per UTC day, followed by smaller per-action budgets. Rotating addresses cannot bypass the daily ceiling; denied counters do not increment. This bounds limiter writes below the free daily write allowance, while unrelated application writes still consume that allowance. The binding is included in deployment ownership checks.

An older/local configuration without the binding uses a bounded per-isolate fallback. It is not a global abuse guarantee. Cloudflare's limiter is also location-scoped and eventually consistent; hosted request volume and ordinary Worker quotas still need monitoring. See the [official Rate Limiting API documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
