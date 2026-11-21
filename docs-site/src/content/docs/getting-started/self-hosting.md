---
title: Set up with Docker
description: Run Crate on your own hardware and connect Obsidian using the HTTPS address and pairing code.
---

Run Crate on a computer or server you control, and your synced data is stored there. Docker brings everything Crate needs, including an HTTPS tunnel. You don't need a Cloudflare account, a domain, or Node.js.

## Start the server

You need Docker Desktop on macOS or Windows, or Docker Engine with the Compose plugin on Linux, plus Git. Then run:

```sh
git clone https://github.com/kaanbiryol/obsidian-crate.git
cd obsidian-crate
docker compose up -d --build
docker compose logs -f crate
```

The first run builds Crate from the repository, so it takes a little while. Wait for the log message saying the public HTTPS address reaches this Crate server.

## Connect Obsidian

1. In the logs, find **Server address to paste into Obsidian** and **Pairing code**.
2. In Obsidian, open **Settings → Crate → Connect to your server**.
3. Enter the full HTTPS address and the pairing code.
4. In **Choose what Crate manages in this vault**, turn Reminders and Reading on or off, then select **Finish**. [After you connect](/docs/getting-started/hosting/#after-you-connect) explains the defaults.
5. Open the command palette and select **Crate: Sync now**.

When it finishes, check **Crate: Show sync activity** for errors. If you want this device to keep syncing on its own, turn on **Settings → Crate → Sync → Automatic sync**; it starts off.

Pairing codes work once and expire after ten minutes. If yours expires, [create another code](#create-another-pairing-code).

<details>
<summary>Good to know</summary>

- Press **Ctrl+C** to leave the log viewer. Crate keeps running in the background.
- Use the public HTTPS address even if Obsidian is on the same computer. The `127.0.0.1:8787` address in the logs is inside the container and isn't reachable from your computer.

</details>

## Create another pairing code

Each device needs its own code. With the server running, run this from the same repository folder:

```sh
docker compose exec crate crate pair --name "My phone"
```

On the next Obsidian device, enter the new code and the same server address under **Connect to your server**. There's no need to restart the server.

Running the server directly with Node instead of Docker? See the [server command reference](/docs/reference/self-hosting/#storage-and-lifecycle).

## Keep it available

Sync and scheduled notifications only work while the server is running. Keep the machine awake, online, and running Docker.

The default tunnel address changes every time the server restarts. When it does, on each Obsidian device use **Settings → Crate → Server → Update server address**, sync, then reconnect the web app. To avoid this, [get an address that never changes](#get-an-address-that-never-changes).

## Get an address that never changes

Without your own domain, use Tailscale Funnel. It gives the server a permanent address like `https://crate.your-tailnet.ts.net`, and your phone doesn't need Tailscale installed. You need a free Tailscale account:

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS certificates**, and [allow Funnel](/docs/reference/self-hosting/#tailscale-funnel-with-docker) for your devices.
2. Start Crate with the Tailscale setup instead:

   ```sh
   docker compose -f compose.yaml -f compose.tailscale.yaml up -d --build
   docker compose -f compose.yaml -f compose.tailscale.yaml logs -f crate
   ```

3. Open the Tailscale sign-in link from the logs. Crate then prints its address and pairing code as before.

Use both `-f` files in every later command, including `exec crate crate pair`. If you already connected devices with the default tunnel, use **Update server address** on each one and reconnect the web app once.

If you have a domain on Cloudflare, you can use a [custom-domain tunnel](/docs/reference/self-hosting/#access-away-from-home-with-cloudflare-tunnel) instead.

## Look after your data

Your server's data lives in a Docker volume, so it survives when the container is replaced. Don't remove that volume, and keep backups outside it.

### Turn on daily backups

1. Create a folder named `backups` next to `compose.yaml`. On Linux, make it writable by user ID 1000.
2. In `compose.yaml`, uncomment the `./backups:/backups` line, then run `docker compose up -d`.
3. Turn on daily backups, keeping the latest seven:

   ```sh
   docker compose exec crate crate auto-backup --output /backups --keep 7
   ```

Crate makes the first backup right away, then a verified backup each day while it runs, without stopping sync for more than a moment, and deletes the oldest beyond seven. Copy the `backups` folder to another disk or computer now and then. The [server command reference](/docs/reference/self-hosting/#verified-backups-restore-and-updates) covers restoring one.

### Update the server

When Obsidian shows **Server update available**, update the server to the same version as your plugin:

1. Let sync finish on your devices, and make a backup:

   ```sh
   docker compose exec crate crate backup --output /backups/before-update
   ```

   This needs the `backups` folder from [daily backups](#turn-on-daily-backups). Use a new name each time.
2. From the repository folder, switch to the release that matches your plugin version, for example `0.14.3`:

   ```sh
   git fetch --tags
   git checkout 0.14.3
   ```

3. Stop the server, keep a copy of the current image, build the new one, and check it before you start it:

   ```sh
   docker compose stop
   docker image tag crate-server:local crate-server:before-update
   docker compose build
   docker compose run --rm crate check-upgrade
   docker compose up -d
   ```

Start the server only if `check-upgrade` succeeds. If it reports that the database needs a migration, or rejects the update, follow the [update and migrate steps](/docs/reference/self-hosting/#update-and-migrate) instead of starting it.

[Connect your other devices →](/docs/getting-started/devices/)
