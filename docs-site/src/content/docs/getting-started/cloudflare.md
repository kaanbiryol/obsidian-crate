---
title: Set up with Cloudflare
description: Create a Crate server in your Cloudflare account and complete your first sync.
---

Crate can create its server and storage in your Cloudflare account from Obsidian. You do not need to create an account API token manually.

## Before you connect

[Install Crate](/docs/getting-started/installation/), then activate **R2**, the file storage Crate uses, in your Cloudflare account:

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and choose the account you will use with Crate.
2. Open **Storage & databases → R2 → Overview**.
3. Complete the R2 checkout flow, reviewing its terms and entering payment details if requested.

Cloudflare handles billing; Crate does not collect your payment details. An included free allowance does not make usage unlimited. See [Cloudflare's R2 setup guide](https://developers.cloudflare.com/r2/get-started/#before-you-begin) for its current requirements.

## Create your server

1. Open **Settings → Crate → Connect with Cloudflare** in Obsidian.
2. In the browser, choose the Cloudflare account, review the permissions, and authorize Crate. On mobile, select **Open Cloudflare** in the connection dialog first.
3. Return to Obsidian. If the callback page does not open it automatically, select **Open Obsidian**.
4. Select **Create server** for a new vault. Crate provisions the Worker, R2 bucket, D1 database, and notification infrastructure in your account.
5. Wait for the connection to finish.

Crate creates the storage and server resources for you; you do not need to create them manually in the dashboard.

When connecting another copy of this vault, select the existing server instead of creating another one. Each separate vault should have its own server.

## Complete your first sync

Connecting does not transfer files. Open Obsidian's command palette and select **Crate: Sync - sync now**.

Wait for sync to finish, then run **Crate: Sync - show activity** to check for errors or conflicts. Open a synced note to confirm the expected content.

Automatic sync starts off. For ongoing transfers, enable **Settings → Crate → Sync → Automatic sync** on this device. You can now [connect another device or open the web app](/docs/getting-started/devices/).

Reading and Reminders start enabled; notifications and encryption do not. Use [Choose and manage features](/docs/features/settings/) to keep the features you want and pause the others.

## Check hosting usage

Open **Settings → Crate → Usage** and select **Refresh** to see Cloudflare's reported usage. These figures can include other apps in the same account and may be delayed. They are estimates, not a spending cap. Retained file history uses storage too.

Use your Cloudflare dashboard for billing and account management.

## If setup does not finish

If Crate reports **R2 is not active for this Cloudflare account**, complete R2 activation in that same account and retry.

For sign-in callbacks, unreachable servers, and other connection problems, see [Connection problems](/docs/troubleshooting/connection/). Connecting an existing server does not upgrade it; follow [Updates](/docs/troubleshooting/updates/) when Crate asks for a newer server.
