# Deploying and operating the server

Crate has two independently released parts: the Obsidian plugin and the Cloudflare server. The plugin does not contain the Worker bundle and never needs a Cloudflare account API token.

## First deployment

1. Install and enable the Crate plugin.
2. Open **Settings → Crate → Configuration** and select **Deploy to Cloudflare**.
3. Review the repository and bindings in Cloudflare, then deploy. The configuration provisions:

   - one Worker;
   - one R2 bucket bound as `BUCKET`;
   - one D1 database bound as `DB`;
   - `REMINDER_ALARMS` and `SETUP` Durable Object namespaces.

4. Open the Worker URL immediately and select **Claim server**.
5. Select **Open in Obsidian**. If the browser cannot open Obsidian, copy the setup link and open it on the device where Crate is installed.
6. In Crate, run **Initial sync → Upload all** to seed an empty server.

The claim page creates a random enrollment token in the browser and sends only its SHA-256 hash to the Worker. The link is valid for 10 minutes and one successful enrollment. Obsidian verifies `/.well-known/crate`, generates a separate permanent device secret locally, and registers only that secret's hash in D1.

Until the first device finishes enrollment, the deployment has no owner credential. Anyone who knows the Worker URL could claim it, so complete this step promptly.

## Adding another device

On a connected device, open **Settings → Crate → Configuration → Set up another device** and either copy the link or show its QR code. The link expires after 10 minutes and can be consumed once. Creating another link replaces any pending additional-device link.

The long-lived credential from the existing device is never placed in the link. The new device generates its own credential during enrollment.

## Updating the server

Update the existing Cloudflare project so it retains the same Worker, D1 database, R2 bucket, and Durable Object history. Do not use **Deploy to Cloudflare** again as an update mechanism; that flow can create an independent deployment.

For a Cloudflare Git-connected project:

1. Bring the connected repository up to the desired Crate release.
2. Read the release notes for protocol or migration requirements.
3. Trigger a build for the existing project or push the update to its configured production branch.
4. Open the Worker URL and confirm that it still says the server is claimed.
5. In Obsidian, run **Settings → Crate → Advanced → Test connection**.

The plugin checks the server's advertised protocol range before syncing. An incompatible server is rejected with a clear connection error rather than used optimistically.

## Command-line fallback

Wrangler 4.123 requires Node.js 22 or newer. Authenticate and create the stateful resources once:

```bash
npx --yes wrangler@4.123.0 login
npx --yes wrangler@4.123.0 d1 create crate-sync
npx --yes wrangler@4.123.0 r2 bucket create crate-sync
```

Copy the D1 database ID returned by Wrangler into `wrangler.jsonc`. If `crate-sync` is already taken in your account, choose another R2 bucket name and update `bucket_name` in the same file. Keep these deployment-specific values for future updates.

Then install, deploy the existing project, and apply its migrations:

```bash
npm ci
npm run deploy
```

The `postdeploy` script runs `npm run db:migrate:remote`. Durable Object migrations are applied as part of Worker deployment. On later updates, reuse the same configured resource IDs and names, pull the desired release, and run `npm ci && npm run deploy` again.

## Recovery

### The claim response or page reload was interrupted

Reload the same Worker URL in the same browser. The page keeps the pending enrollment token in local storage and can reconstruct the link until it expires.

### The first setup link expired

If no device was registered, the server automatically becomes claimable again after the 10-minute window. Reload the Worker URL and claim it again.

### An additional-device link expired

Create a replacement from any connected device. Issuing it invalidates the previous pending link.

### The server is claimed but no connected device remains

If the D1 `auth_tokens` table still contains device records, the server stays locked by design. Recover a device secret from that device's Obsidian secret storage or restore the D1 database. Deleting all device records makes the setup coordinator treat the server as unowned; only do that from the Cloudflare dashboard when intentionally recovering ownership.

### Deployment rollback

Roll back the existing Worker deployment in Cloudflare. Do not delete or replace D1, R2, or Durable Object bindings. Confirm protocol compatibility with **Test connection** before resuming sync.

## Deleting the server

Resetting Crate in Obsidian clears only the local Worker URL and device secret. It does not delete remote data. Delete the Worker, R2 bucket, D1 database, and Durable Object resources explicitly in the Cloudflare dashboard when you intend to destroy the server and synced data.
