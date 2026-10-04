---
title: Set up with Docker
description: Run Crate on your own hardware and connect Obsidian using the HTTPS address and pairing code.
---

Run Crate on a computer or server you control. Docker includes the runtime, storage services, and an HTTPS tunnel; you do not need a Cloudflare account, a domain, or Node.js on the host.

## Start the server

Install and start Docker Desktop on macOS or Windows, or Docker Engine with the Compose plugin on Linux. You also need Git to get the repository.

```sh
git clone https://github.com/kaanbiryol/obsidian-crate.git
cd obsidian-crate
docker compose up -d --build
docker compose logs -f crate
```

The first run builds the image from the repository. Wait for the log message confirming that the public HTTPS address reaches this Crate server.

## Connect Obsidian

1. Find **Server address to paste into Obsidian** and **Pairing code** in the logs.
2. In Obsidian, open **Settings → Crate → Connect to your server**.
3. Enter the complete HTTPS address and the pairing code.
4. Open the command palette and select **Crate: Sync - sync now**.

Wait for completion and check **Crate: Sync - show activity** for errors. Automatic sync starts off; enable **Settings → Crate → Sync → Automatic sync** if you want this device to continue syncing automatically.

Pairing codes work once and expire after ten minutes. If yours expires, [create another code](#create-another-pairing-code).

You can press **Ctrl+C** to leave the log viewer; Crate keeps running in the background.

Use the public HTTPS address even if Obsidian is on the same computer. The internal `127.0.0.1:8787` listener shown in Docker logs is inside the container and is not published to the host.

## Create another pairing code

Keep the server running. From the same repository folder on the host, run:

```sh
docker compose exec crate crate pair --name "My phone"
```

Use the new code and existing server address under **Connect to your server** on the next Obsidian device. You do not need to restart the server. Give each device its own code.

For a server running directly with Node instead of Docker, use the [server command reference](/docs/reference/self-hosting/#storage-and-lifecycle).

## Keep it available

Keep the computer awake, online, and running Docker. Scheduled notifications and sync cannot reach a stopped server.

The default Quick Tunnel address changes when the server restarts. On each Obsidian device, use **Settings → Crate → Server → Update server address**, sync, then reconnect the web app. For a permanent address, follow the [custom-domain tunnel setup](/docs/reference/self-hosting/#access-away-from-home-with-cloudflare-tunnel).

## Look after your data

Server data persists in a Docker volume when the container is replaced. Keep separate backups and avoid removing that volume. Before updating, follow the [backup and upgrade instructions](/docs/reference/self-hosting/#verified-backups-restore-and-updates).

[Connect your other devices →](/docs/getting-started/devices/)
