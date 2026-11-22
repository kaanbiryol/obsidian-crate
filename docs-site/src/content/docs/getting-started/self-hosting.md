---
title: Set up your own server
description: Run Crate on your own hardware with one command, then connect Obsidian by scanning a code.
prev:
  link: /docs/getting-started/hosting/
  label: Choose your hosting
next:
  link: /docs/getting-started/first-sync/
  label: Your first sync
---

Run Crate on a computer or server you control, and your synced data is stored there. You don't need a Cloudflare account or a domain. Choose one way to run it:

- **Node.js** on a Mac or Linux computer: one command asks a few questions and sets everything up.
- **Docker** on any computer that runs it, including Windows and home servers.

## With Node.js

Install [Node.js](https://nodejs.org/) 26, then run:

```sh
npx @kaanbiryol/crate-server
```

Crate asks a few questions, and pressing Enter accepts each suggestion:

1. **How your devices reach this computer.** Tailscale Funnel gives a permanent address for free. You need the [Tailscale app](https://tailscale.com/download) on this computer only, with **MagicDNS** and **HTTPS certificates** turned on in its [admin console](https://login.tailscale.com/admin/dns). You can also use your own domain on Cloudflare, or a temporary address to try Crate out.
2. **Start Crate when you log in**, and restart it if it stops. Crate installs itself so it keeps running after you close the terminal.
3. **Keep this Mac awake** while Crate runs, so your devices can always sync.
4. **Where to keep daily backups.** Crate suggests `~/Crate backups` on this computer. On a Mac with iCloud Drive, it also names a folder there; backups contain your vault and server credentials, so pick it only if iCloud may store them.

The first time, Tailscale or Cloudflare may print a link to approve access. When setup finishes, it shows a code to [connect Obsidian](#connect-obsidian).

## With Docker

You need Docker Desktop on macOS or Windows, or Docker Engine with the Compose plugin on Linux. In a new folder, run:

```sh
curl -fsSLO https://raw.githubusercontent.com/kaanbiryol/obsidian-crate/master/compose.yaml
docker compose up -d
docker compose logs -f crate
```

Docker downloads Crate, including an HTTPS tunnel, and starts it in the background. It restarts Crate after a failure, and Docker Desktop can start at login. Wait for the log message saying the public HTTPS address reaches this Crate server. Press **Ctrl+C** to leave the log; Crate keeps running.

The default Docker tunnel address changes every time the server restarts. For an address that never changes, see [Tailscale Funnel with Docker](/docs/reference/self-hosting/#tailscale-funnel-with-docker).

## Connect Obsidian

Install the Crate plugin in Obsidian first. When the server is ready it shows a QR code and a link:

- **On a phone or tablet,** scan the QR code with the camera.
- **On a computer,** open the link.

Obsidian opens and asks to connect the vault. Select **Connect**, then [choose what Crate manages and run your first sync](/docs/getting-started/first-sync/).

You can also enter the server address and pairing code shown below the QR code in **Settings → Crate → Connect to your server**. Codes work once and expire after ten minutes.

## Add another device

Each device needs its own code. On the computer running the server, run the command that matches how you installed it:

```sh
crate-server pair --name "My phone"
```

```sh
docker compose exec crate crate pair --name "My phone"
```

It shows a new QR code and link. In Obsidian, **Settings → Crate → Account and devices → Add a device** shows the right command and copies it for you.

## Keep it healthy

**Settings → Crate → Server → Server computer** shows when the server last backed up, whether it is reachable from the internet, and anything that needs your attention. Phones with the Crate web app and notifications turned on also get a notification when a backup fails, the server stops being reachable, or its disk is nearly full.

To check everything and get a fix for each problem, run this on the server computer:

```sh
crate-server doctor
```

With Docker, use `docker compose exec crate crate doctor`.

## Update the server

When Obsidian shows **Server update available**, run this on the server computer:

```sh
crate-server update
```

Crate makes a verified backup, installs the new release, checks your data, and restarts. If anything fails before your data changes, it goes back to the previous release.

With Docker, run this in the folder with `compose.yaml`:

```sh
docker compose pull && docker compose up -d
```

The new container checks your data before it starts. If the release needs a database migration, it makes a verified backup first.

## Look after your data

Every device keeps a full copy of your notes. The server adds history, pairing, notifications and reminder state, so keep its backups. Setup with Node.js turns on daily backups. With Docker, turn them on yourself:

1. Create a folder named `backups` next to `compose.yaml`. On Linux, make it writable by user ID 1000.
2. In `compose.yaml`, uncomment the `./backups:/backups` line, then run `docker compose up -d`.
3. Turn on daily backups, keeping the latest seven:

   ```sh
   docker compose exec crate crate auto-backup --output /backups --keep 7
   ```

Copy backups to another disk or computer now and then. The [server command reference](/docs/reference/self-hosting/#verified-backups-restore-and-updates) covers restoring one.

