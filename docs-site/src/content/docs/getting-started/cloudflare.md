---
title: Set up with Cloudflare
description: Create a Crate server in your Cloudflare account from Obsidian.
next:
  link: /docs/getting-started/first-sync/
  label: Your first sync
---

Crate can build its own server in your Cloudflare account, straight from Obsidian. You don't need to create API tokens or set anything up in the Cloudflare dashboard beyond one step below. It takes a few minutes.

## Before you connect

[Install Crate](/docs/getting-started/installation/), then turn on **R2**, Cloudflare's file storage, which Crate uses to store your vault:

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and choose the account you want to use with Crate.
2. Open **Storage & databases → R2 → Overview**.
3. Complete the R2 checkout. Review its terms and enter payment details if asked.

Cloudflare handles billing; Crate doesn't collect your payment details. There's a free allowance, but usage isn't unlimited. See [Cloudflare's R2 setup guide](https://developers.cloudflare.com/r2/get-started/#before-you-begin) for current requirements.

## Create your server

Create your server from Obsidian on a desktop. Phones and tablets can connect to an existing server, but can't create, update, or delete one, because they may pause Obsidian in the background partway through.

1. In Obsidian, open **Settings → Crate → Connect with Cloudflare**.
2. In your browser, choose exactly one Cloudflare account, review the permissions, and authorize Crate.
3. Go back to Obsidian. If it doesn't open on its own, select **Open Obsidian**.
4. For a new vault, select **Create server**.
5. Wait for the connection to finish.
6. In **Choose what Crate manages in this vault**, turn Reminders and Reading on or off, then select **Finish**. [Choose what Crate manages](/docs/getting-started/first-sync/#choose-what-crate-manages) explains each choice.

Crate creates everything it needs in your account: the server (a Cloudflare Worker), file storage (R2), a database (D1), and what's needed for notifications.

Connecting another copy of this vault? Select the existing server instead of creating a new one. Each unrelated vault needs [its own server](/docs/getting-started/hosting/#one-server-for-each-vault).

Next, [run your first sync](/docs/getting-started/first-sync/).

## Check hosting usage

Open **Settings → Crate → Usage** and select **Refresh** to see what Cloudflare reports. These numbers are estimates, not a spending cap. They can include other apps in the same account and may lag behind. File history you keep uses storage too.

Crate also checks about once a day while Obsidian is open, on devices signed in to Cloudflare, and shows a notice when file storage or operations reach 80% of the free allowance, and again once they pass it. The warnings never pause sync. To turn them off, open **Settings → Crate → Usage** and turn off **Warn before R2 billing**.

For billing and account management, use your Cloudflare dashboard.

## If setup doesn't finish

- **Turn on R2 in Cloudflare:** select **Open R2 in Cloudflare**, finish turning on R2 in that same account, then try again.
- **Sign-in doesn't return to Obsidian, or the server can't be reached:** see [Connection problems](/docs/troubleshooting/connection/).
- **Crate asks for a newer server:** connecting an existing server doesn't upgrade it. Follow [Updates](/docs/troubleshooting/updates/).
