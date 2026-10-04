---
title: Updates
description: Update the Obsidian plugin, Crate server, and web app without discarding pending work.
---

Crate has three parts to update: the Obsidian plugin, your server, and the web app. Updating the plugin does not automatically replace a running server.

## Update the plugin

If you installed with BRAT, use BRAT's update controls. For a manual installation, download all plugin files from the same release and replace the installed files together, then reload Obsidian.

Update Crate on each Obsidian device you use. See [Installation](/docs/getting-started/installation/) for the file locations.

## Update a Cloudflare server

When the plugin contains newer server or web app code, Crate settings shows an update notice.

1. Let sync finish and resolve or preserve pending web app work.
2. Open **Settings → Crate** and select **Update server**.
3. Follow the update prompts and wait for verification to finish.
4. Sync again and open the web app to check the result.

Crate reuses your saved Cloudflare authorization when possible. It asks you to sign in again if that authorization is missing, revoked, or insufficient. Connecting another device to an existing server does not update the server.

## Update a Docker or local server

Preserve a verified backup and the matching installation before changing server versions. Check compatibility before starting the new version against existing storage.

Follow the [self-hosting backup and update instructions](/docs/reference/self-hosting/#verified-backups-restore-and-updates) and the [compatibility reference](/docs/reference/compatibility/#local-server-storage). A schema migration requires the explicit upgrade flow with the server stopped; ordinary startup does not silently migrate unsupported storage.

If an upgrade is rejected, keep the original data intact. Do not edit version metadata or delete storage to make the check pass.

## Update the web app

After the server update, reopen the web app and use its update prompt when offered. Let pending changes finish or preserve them before reloading. The app may wait until saved work is safe before applying an update.

If a session or cached copy needs recovery, follow [History and recovery](/docs/troubleshooting/recovery/) before signing out or clearing browser data.
