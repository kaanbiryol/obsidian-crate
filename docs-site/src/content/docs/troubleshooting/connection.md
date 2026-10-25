---
title: Connection problems
description: Fix Cloudflare sign-in, expired pairing codes, changed server addresses, and web app connections.
---

A failed connection doesn't touch your notes. They stay on your device while you sort it out.

Find the problem you're seeing below. Obsidian and the web app connect in different ways, so check which one you're setting up.

## Cloudflare doesn't send me back to Obsidian

1. On mobile, select **Open Cloudflare** in Crate's connection dialog to start signing in.
2. When the confirmation page opens, select **Open Obsidian** if the app doesn't open on its own.

If signing in was interrupted, go back to Crate settings and select **Connect with Cloudflare** again. Use the Cloudflare account that owns your server.

## Cloudflare says R2 isn't active

R2 is Cloudflare's file storage, and Crate needs it turned on.

1. Open the Cloudflare dashboard, signed in to the same account you chose during setup.
2. Finish turning on R2.
3. Try connecting again.

Turning on R2 in a different Cloudflare account won't help this server. See the [R2 activation steps](/docs/getting-started/cloudflare/#before-you-connect).

## I can't reach my Docker server

1. Check that the computer running the server is awake and online.
2. Look at the server logs:

   ```sh
   docker compose logs -f crate
   ```

3. Wait until the logs confirm that the public HTTPS address reaches this Crate server.
4. In Obsidian, paste the address shown as **Server address to paste into Obsidian**, including `https://`.

<details>
<summary>Good to know</summary>

- Don't use the internal Docker listener address. Use the public HTTPS one.
- On a phone, `localhost` and `127.0.0.1` point to the phone itself, not your server.
- The default Quick Tunnel address changes every time the server restarts. When that happens, select **Settings → Crate → Server → Update server address** on each Obsidian device, then sync. Create a fresh connection link for the web app.

</details>

## My pairing code expired

Pairing codes work once and expire after ten minutes. [Create a new code](/docs/getting-started/self-hosting/#create-another-pairing-code), then enter it under **Connect to your server** in Obsidian.

A pairing code is for Obsidian only. To connect the web app, connect Obsidian first, then use **Crate web app → Connect another device**.

## The web app asks me to reconnect

1. On a connected Obsidian device, open **Settings → Crate → Crate web app** and create a new link.
2. Open the link in the browser or installed app you want to use.
3. Reconnect to the same server and folder, then follow the review and resume prompts.

If the app has unsent saves or drafts, keep them safe before you sign out or clear browser data. See [Pending work in the web app](/docs/troubleshooting/recovery/#pending-work-in-the-web-app).

## My files are missing after connecting

Connecting doesn't move files. To bring them over:

1. Run **Crate: Sync now** on the original device and wait for it to finish.
2. Run **Crate: Sync now** on the other device.

Still missing something? Check that:

- Both devices are connected to the same server.
- Your exclusion rules aren't keeping the files local.
- **Settings → Crate → Sync → Automatic sync** is on, if you expect files to sync after editing. It starts off on each device.
- For missing articles or reminders, the feature is turned on and its folder contains the notes. The [settings guide](/docs/features/settings/) explains these controls.

## Crate says my server is incompatible

Follow [Updates](/docs/troubleshooting/updates/) to bring the plugin and server back in step. Don't reset storage to get past a compatibility message.
