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

Protocol 4 is required for writes. Both clients verify the server before mutations; the Worker rejects missing or incompatible protocol headers with 428. Only the current prerelease formats are supported.

Provisioning initializes an empty database from the bundled, hash-verified `src/cloudflare/schema.sql`. Existing databases must contain `crate_schema` with version 1. Any other schema is rejected before Worker upload, without changing its data. An interrupted current-schema initialization can be retried idempotently. There are no SQL upgrade scripts or portable-path backfills.

An explicit update of a current-schema deployment preserves resource IDs and data. Downgrade checks use the current remote deployment metadata. Older prerelease deployments require separate current resources; keep their original deployment and paired backup intact for recovery. Do not point the new Worker at an unsupported database.

## Recovery and deletion

- If the browser handoff fails, select **Open Obsidian** on the callback page.
- If OAuth expires, return to Crate settings and start again. Authorization state and PKCE material are intentionally not recoverable after plugin reload.
- **Disconnect this device** clears the Worker URL and device secret but retains the non-secret deployment identity, allowing a later Cloudflare sign-in to reuse the same Worker. It never deletes Cloudflare resources.
- Replaced and deleted sync objects remain recoverable for 30 days under **Settings → Crate → Infrastructure → Restore remote file**. Recovery verifies the retained bytes and refuses to overwrite a remote path that changed after the recovery screen was opened.
- **Run diagnostics** reports manifest access, pending backend queues, and the last scheduled-maintenance result. Use it after a server upgrade and before relying on a newly seeded vault.
- To destroy the server and synced data, explicitly delete its Worker, R2 bucket, D1 database, and Durable Object resources in the Cloudflare dashboard.

For paired D1/R2 backup verification and isolated restore commands, use [Backup and recovery](recovery.md).
