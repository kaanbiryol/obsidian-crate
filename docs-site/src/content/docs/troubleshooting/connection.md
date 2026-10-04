---
title: Connection problems
description: Fix Cloudflare sign-in, expired pairing codes, changed server addresses, and web app connections.
---

Start with the device and server you are trying to connect. Obsidian vault connections and web app sessions use different setup flows.

## Cloudflare does not return to Obsidian

On mobile, select **Open Cloudflare** in Crate's connection dialog to begin authorization. When the callback page opens, select **Open Obsidian** if the app does not open automatically.

If authorization was interrupted, return to Crate settings and start **Connect with Cloudflare** again. Use the Cloudflare account that owns the server.

## R2 is not active

Open the Cloudflare dashboard in the same account you chose during setup and finish R2 activation. Then retry the connection. Activating R2 in a different account does not enable it for this server.

See [R2 activation steps](/docs/getting-started/cloudflare/#before-you-connect).

## A Docker server cannot be reached

Check that the host is awake and online, then inspect the server logs:

```sh
docker compose logs -f crate
```

Wait for confirmation that the public HTTPS address reaches this Crate server. Use **Server address to paste into Obsidian**, including `https://`. Do not use the internal Docker listener address.

The default Quick Tunnel address changes when the server restarts. In Obsidian, use **Settings → Crate → Server → Update server address** on each device, then sync. Create a fresh connection link for the web app.

On a phone, `localhost` and `127.0.0.1` point to the phone itself. Use the server's public HTTPS address.

## A pairing code has expired

Pairing codes work once and expire after ten minutes. [Create a new code](/docs/getting-started/self-hosting/#create-another-pairing-code), then enter it under **Connect to your server** in Obsidian.

A pairing code for Obsidian is not a web app connection link. To connect the web app, use **Crate web app → Connect another device** after Obsidian has connected.

## The web app asks to reconnect

Generate a new link from **Settings → Crate → Crate web app** on a connected Obsidian device. Open it in the browser or installed app you want to use.

If the app contains pending saves or drafts, preserve them before signing out or clearing browser data. Reconnect to the same server and folder, then follow its review and resume prompts. See [Pending work](/docs/troubleshooting/recovery/#pending-work-in-the-web-app).

## Files are missing after connecting

Connection does not transfer files. Run **Crate: Sync - sync now** on the original device, wait for completion, then sync the other device. Confirm both are connected to the same server and check ignore rules.

Automatic sync starts off on each device. Enable **Settings → Crate → Sync → Automatic sync** if you expect files to transfer after editing. For missing articles or reminders, also check that the feature is enabled and its configured folder contains the notes. The [settings guide](/docs/features/settings/) explains these controls.

If Crate reports an incompatible server, follow [Updates](/docs/troubleshooting/updates/). Do not reset storage to bypass a compatibility message.
