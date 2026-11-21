---
title: Updates
description: Update the Obsidian plugin, Crate server, and web app without discarding pending work.
---

Updating keeps your notes and unsent work as long as you let things finish first. This page walks you through each part.

Crate has three parts to update: the Obsidian plugin, your server, and the web app. Updating the plugin doesn't update a server that's already running.

## Update the plugin

Update Crate on one Obsidian device:

- **Installed with BRAT:** use BRAT's update controls.
- **Installed by hand:** download all the plugin files from the same release, replace the installed files together, then reload Obsidian. [Installation](/docs/getting-started/installation/) shows where the files go.

Your other devices get the same version on their next sync, because **Sync Crate updates** is on by default. Restart Obsidian on each one to load it. In an encrypted vault the update installs on its own; otherwise Crate asks you to select **Install update**. To update each device yourself instead, turn off **Settings → Crate → Sync → Sync options → Sync Crate updates** on that device. [Crate updates](/docs/features/sync/#crate-updates) explains the details.

## Update a Cloudflare server

When the plugin includes a newer server or web app, Crate settings shows an update notice.

1. Let sync finish, and let the web app send or save any pending work.
2. On a desktop, open **Settings → Crate** and select **Update server**. Phones and tablets show the update but can't run it.
3. Follow the prompts and wait for the check to finish.
4. Sync again and open the web app to make sure everything works.

Crate reuses your saved Cloudflare sign-in when it can, and asks you to sign in again if it's missing, revoked, or doesn't have enough access. Connecting another device to your server doesn't update it.

## Update a Docker or local server

Obsidian shows **Server update available** when your plugin includes a newer server than the one you run. Update it on the computer that runs it:

- **Installed with npm:** run `crate-server update`.
- **Docker:** run `docker compose pull && docker compose up -d`.
- **Other installs:** follow the [update and migrate steps](/docs/reference/self-hosting/#update-and-migrate).

The **Server update available** message names the command for your server. See [Update the server](/docs/getting-started/self-hosting/#update-the-server).

Each way makes a backup first and checks that the new version can open your existing data before it starts.

If the check rejects an update, leave your data as it is and follow the [update and migrate steps](/docs/reference/self-hosting/#update-and-migrate). Don't delete storage to get past it.

## Update the web app

After updating the server, reopen the web app and accept its update prompt when it appears. Let pending changes finish, or save them, before reloading. The app may wait until your work is safe before it updates.

If a session or saved copy needs fixing, follow [History and recovery](/docs/troubleshooting/recovery/) before signing out or clearing browser data.
