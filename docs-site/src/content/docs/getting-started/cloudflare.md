---
title: Set up with Cloudflare
description: Create a Crate server in your Cloudflare account and complete your first sync.
---

Crate can build its own server in your Cloudflare account, straight from Obsidian. You don't need to create API tokens or set anything up in the Cloudflare dashboard beyond one step below. It takes a few minutes.

## Before you connect

[Install Crate](/docs/getting-started/installation/), then turn on **R2**, Cloudflare's file storage, which Crate uses to store your vault:

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and choose the account you want to use with Crate.
2. Open **Storage & databases → R2 → Overview**.
3. Complete the R2 checkout. Review its terms and enter payment details if asked.

Cloudflare handles billing; Crate doesn't collect your payment details. There's a free allowance, but usage isn't unlimited. See [Cloudflare's R2 setup guide](https://developers.cloudflare.com/r2/get-started/#before-you-begin) for current requirements.

## Create your server

1. In Obsidian, open **Settings → Crate → Connect with Cloudflare**.
2. In your browser, choose the Cloudflare account, review the permissions, and authorize Crate. On mobile, select **Open Cloudflare** in the connection dialog first.
3. Go back to Obsidian. If it doesn't open on its own, select **Open Obsidian**.
4. For a new vault, select **Create server**.
5. Wait for the connection to finish.
6. In **Choose what Crate manages in this vault**, turn Reminders and Reading on or off, then select **Finish**. [After you connect](/docs/getting-started/hosting/#after-you-connect) explains the defaults.

Crate creates everything it needs in your account: the server (a Cloudflare Worker), file storage (R2), a database (D1), and what's needed for notifications.

Connecting another copy of this vault? Select the existing server instead of creating a new one. Each separate vault should have its own server.

## Complete your first sync

Connecting doesn't move any files yet.

1. Open Obsidian's command palette and select **Crate: Sync now**.
2. When it finishes, run **Crate: Show sync activity** to check for errors or conflicts.
3. Open a synced note to make sure it looks right.

You're set up. If you want this device to keep syncing on its own, turn on **Settings → Crate → Sync → Automatic sync**; it starts off.

Next, [connect another device or open the web app](/docs/getting-started/devices/). Notifications and encryption start off. [Choose and manage features](/docs/features/settings/) to keep what you want.

## Check hosting usage

Open **Settings → Crate → Usage** and select **Refresh** to see what Cloudflare reports. These numbers are estimates, not a spending cap. They can include other apps in the same account and may lag behind. File history you keep uses storage too.

For billing and account management, use your Cloudflare dashboard.

## If setup doesn't finish

- **R2 is not active for this Cloudflare account:** finish turning on R2 in that same account, then try again.
- **Sign-in doesn't return to Obsidian, or the server can't be reached:** see [Connection problems](/docs/troubleshooting/connection/).
- **Crate asks for a newer server:** connecting an existing server doesn't upgrade it. Follow [Updates](/docs/troubleshooting/updates/).
