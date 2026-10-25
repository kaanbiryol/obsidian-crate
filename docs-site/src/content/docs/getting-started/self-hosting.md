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
4. Open the command palette and select **Crate: Sync now**.

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

The default tunnel address changes every time the server restarts. When it does, on each Obsidian device use **Settings → Crate → Server → Update server address**, sync, then reconnect the web app. For an address that never changes, set up a [custom-domain tunnel](/docs/reference/self-hosting/#access-away-from-home-with-cloudflare-tunnel).

## Look after your data

Your server's data lives in a Docker volume, so it survives when the container is replaced. Don't remove that volume, and keep separate backups. Before updating, follow the [backup and upgrade instructions](/docs/reference/self-hosting/#verified-backups-restore-and-updates).

[Connect your other devices →](/docs/getting-started/devices/)
