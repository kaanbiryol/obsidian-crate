---
title: Choose your hosting
description: Compare hosting Crate in your Cloudflare account with running it on your own hardware.
---

Crate needs a server for vault sync and the web app. You choose where that server runs; you do not need a Crate account.

| | Cloudflare | Your own hardware |
| --- | --- | --- |
| Setup | Connect your Cloudflare account in Obsidian | Run the repository's Docker setup |
| Storage | Your R2 bucket and D1 database | A persistent Docker volume on your host |
| Availability | Your computer can sleep | Your host must stay awake and online |
| Address | A server address from your deployment | A temporary tunnel address by default; a custom domain can make it stable |
| What you manage | Cloudflare account, usage, and server updates | Host, Docker, backups, and server updates |

## Cloudflare

Choose Cloudflare if you want a server that stays available without keeping your own computer running. Crate creates the server and storage in your account after you authorize it.

Activate R2 before connecting. Cloudflare requires billing setup, and hosting charges may apply to your usage.

[Set up with Cloudflare →](/docs/getting-started/cloudflare/)

## Your own computer or server

Choose Docker if you want the server's files and database on hardware you manage. The default setup includes an HTTPS tunnel and does not require a Cloudflare account or your own domain.

Keep the host awake, online, and running Docker for sync and scheduled notifications. The default tunnel address changes when it restarts.

[Set up with Docker →](/docs/getting-started/self-hosting/)

## One server for each vault

Connect copies of the **same vault** to the same server. Create a separate server for an unrelated vault. Local vault names do not separate remote data: connecting different vaults to one server combines their files during sync.

Both hosting options support [optional end-to-end encryption](/docs/features/encryption/). Enable it in Crate settings to protect synced content. File paths, sizes, and notification scheduling metadata remain visible to your server. Without encryption enabled, the server can read synced content.
