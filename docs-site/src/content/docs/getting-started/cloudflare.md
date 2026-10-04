---
title: Set up with Cloudflare
description: Create a Crate server in your Cloudflare account and complete your first sync.
---

Crate can create its server and storage in your Cloudflare account from Obsidian. You do not need to create an account API token manually.

## Before you connect

[Install Crate](/docs/getting-started/installation/), then activate **R2** in the Cloudflare account you want to use. Cloudflare handles billing and any required payment details; Crate does not collect them.

See the repository's [R2 activation steps](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/deployment.md#activate-r2-before-connecting) if you have not used R2 before.

## Create your server

1. Open **Settings → Crate → Connect with Cloudflare** in Obsidian.
2. In the browser, choose the Cloudflare account, review the permissions, and authorize Crate. On mobile, select **Open Cloudflare** in the connection dialog first.
3. Return to Obsidian. If the callback page does not open it automatically, select **Open Obsidian**.
4. Select **Create server** for a new vault. Crate provisions the Worker, R2 bucket, D1 database, and notification infrastructure in your account.
5. Wait for the connection to finish.

When connecting another copy of this vault, select the existing server instead of creating another one. Each separate vault should have its own server.

## Complete your first sync

Connecting does not transfer files. Open Obsidian's command palette and select **Crate: Sync - sync now**.

Wait for sync to finish, then check **Sync activity**. You can now [connect another device or open the web app](/docs/getting-started/devices/).

## If setup does not finish

If Crate reports **R2 is not active for this Cloudflare account**, complete R2 activation in that same account and retry.

For sign-in callbacks, unreachable servers, and other connection problems, see [Connection problems](/docs/troubleshooting/connection/). Connecting an existing server does not upgrade it; follow [Updates](/docs/troubleshooting/updates/) when Crate asks for a newer server.
