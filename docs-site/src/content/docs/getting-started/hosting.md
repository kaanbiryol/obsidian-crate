---
title: Choose your hosting
description: Compare hosting Crate in your Cloudflare account with running it on your own hardware.
---

Vault sync and the web app need a Crate server. You decide where it runs, and you don't need a Crate account. There are two options:

- **Cloudflare:** Crate sets up a server in your own Cloudflare account. It stays online without your computer.
- **Your own hardware:** run Crate with Docker on a computer or server you manage. Your data is stored there.

| | Cloudflare | Your own hardware |
| --- | --- | --- |
| Setup | Connect your Cloudflare account in Obsidian | Run the repository's Docker setup |
| Where your data lives | Storage and a database in your Cloudflare account | A persistent Docker volume on your machine |
| Availability | Your computer can sleep | Your machine must stay awake and online |
| Address | A server address from your deployment | A temporary tunnel address by default; a custom domain makes it permanent |
| What you look after | Cloudflare account, usage, and server updates | The machine, Docker, backups, and server updates |

## Cloudflare

Choose Cloudflare if you want a server that's always available without keeping your own computer running. After you authorize Crate, it creates the server and storage in your account for you.

Before connecting, you need to turn on R2, Cloudflare's file storage. Cloudflare asks for billing details for this, and hosting charges may apply to your usage.

[Set up with Cloudflare →](/docs/getting-started/cloudflare/)

## Your own computer or server

Choose Docker if you want the server's files and database on hardware you manage. The default setup includes an HTTPS tunnel, so you don't need a Cloudflare account or your own domain.

Your machine needs to stay awake, online, and running Docker for sync and scheduled notifications to work. The default tunnel address changes whenever it restarts.

[Set up with Docker →](/docs/getting-started/self-hosting/)

## One server for each vault

Connect copies of the **same vault** to the same server, and give each unrelated vault its own server. Vault names don't keep data apart: connecting two different vaults to one server merges their files when they sync.

## Privacy

Both options support [optional end-to-end encryption](/docs/features/encryption/), which you turn on in Crate settings. Without it, your server can read synced content. With it, content and file and folder names are encrypted; folder structure, sizes, and notification scheduling details stay visible to your server.
