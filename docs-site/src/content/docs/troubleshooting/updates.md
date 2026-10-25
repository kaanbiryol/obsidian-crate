---
title: Updates
description: Update the Obsidian plugin, Crate server, and web app without discarding pending work.
---

Updating keeps your notes and unsent work as long as you let things finish first. This page walks you through each part.

Crate has three parts to update: the Obsidian plugin, your server, and the web app. Updating the plugin doesn't update a server that's already running.

## Update the plugin

- **Installed with BRAT:** use BRAT's update controls.
- **Installed by hand:** download all the plugin files from the same release, replace the installed files together, then reload Obsidian.

Update Crate on every Obsidian device you use. [Installation](/docs/getting-started/installation/) shows where the files go.

## Update a Cloudflare server

When the plugin includes a newer server or web app, Crate settings shows an update notice.

1. Let sync finish, and let the web app send or save any pending work.
2. Open **Settings → Crate** and select **Update server**.
3. Follow the prompts and wait for the check to finish.
4. Sync again and open the web app to make sure everything works.

Crate reuses your saved Cloudflare sign-in when it can, and asks you to sign in again if it's missing, revoked, or doesn't have enough access. Connecting another device to your server doesn't update it.

## Update a Docker or local server

1. Make a verified backup, and keep a copy of your current installation.
2. Check that the new version is compatible with your existing storage before you start it.
3. Follow the [self-hosting backup and update instructions](/docs/reference/self-hosting/#verified-backups-restore-and-updates) and the [compatibility reference](/docs/reference/compatibility/#local-server-storage).

<details>
<summary>Good to know</summary>

- If storage needs a format upgrade, you run it on purpose, with the server stopped. A normal start never quietly converts storage it doesn't support.
- If an upgrade is rejected, leave the original data as it is. Don't edit version details or delete storage to get past the check.

</details>

## Update the web app

After updating the server, reopen the web app and accept its update prompt when it appears. Let pending changes finish, or save them, before reloading. The app may wait until your work is safe before it updates.

If a session or saved copy needs fixing, follow [History and recovery](/docs/troubleshooting/recovery/) before signing out or clearing browser data.
