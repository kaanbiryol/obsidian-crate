---
title: Choose your hosting
description: Compare hosting Crate in your Cloudflare account with running it on your own hardware.
---

Vault sync and the web app need a Crate server. You decide where it runs, and you don't need a Crate account. There are two options:

- **Cloudflare:** Crate sets up a server in your own Cloudflare account. It stays online without your computer.
- **Your own hardware:** run Crate with one command, or with Docker, on a computer or server you manage. Your data is stored there.

```mermaid
flowchart TB
  accTitle: Where your Crate server runs
  accDescr: Obsidian and the Crate web app connect to one Crate server. With Cloudflare, the server and its file storage and database run in your Cloudflare account. With your own hardware, an HTTPS tunnel reaches the server running in Docker, which stores its data in a Docker volume on your machine.
  devices["`**Your devices**
  Obsidian with Crate,
  Crate web app`"]
  subgraph home["Your own hardware"]
    tunnel["`HTTPS tunnel
    (Quick Tunnel or
    Tailscale Funnel)`"]
    server["`Crate server
    in Docker`"]
    volume[("`Docker volume
    on your machine`")]
    tunnel --> server --> volume
  end
  subgraph cf["Cloudflare"]
    worker["`Crate server
    (Cloudflare Worker)`"]
    storage[("`File storage (R2)
    and database (D1)`")]
    worker --> storage
  end
  devices --> worker
  devices --> tunnel
```

| | Cloudflare | Your own hardware |
| --- | --- | --- |
| Setup | Connect your Cloudflare account in Obsidian | Run one command, or Docker, then scan a code |
| Where your data lives | Storage and a database in your Cloudflare account | A folder or Docker volume on your machine |
| Availability | Your computer can sleep | Your machine must stay awake and online |
| Address | A server address from your deployment | A permanent Tailscale address, your own domain, or a temporary tunnel address |
| What you look after | Cloudflare account, usage, and server updates | The machine, and running one command to update |

## Cloudflare

Choose Cloudflare if you want a server that's always available without keeping your own computer running. After you authorize Crate, it creates the server and storage in your account for you.

Before connecting, you need to turn on R2, Cloudflare's file storage. Cloudflare asks for billing details for this, and hosting charges may apply to your usage.

[Set up with Cloudflare →](/docs/getting-started/cloudflare/)

## Your own computer or server

Choose your own hardware if you want the server's files and database on a machine you manage. One command asks a few questions and sets up a permanent address with a free Tailscale account, start at login, and daily backups. You don't need a Cloudflare account or your own domain. Docker works too, including on Windows.

Your machine needs to stay awake and online for sync and scheduled notifications to work.

[Set up your own server →](/docs/getting-started/self-hosting/)

## After you connect

On the first device you connect, Crate ends setup with **Choose what Crate manages in this vault**. It lists Reminders and Reading with the folder each one uses. Both start off:

- **An empty or new folder** shows what Crate will store there.
- **A folder that already has notes** shows how many notes it has and what turning the feature on changes: Reminders adds a small ID comment to each task and turns dates like "tomorrow" into fixed dates, and Reading adds Crate frontmatter to each note.

Select **Finish** to turn on what you chose. Crate saves the features you turned on for the vault, so devices you connect later turn them on without asking. If you leave both off, the next device you connect asks again. Features you leave off don't change any notes, and closing the step without **Finish** changes nothing. You can change these later in **Settings → Crate**.

## One server for each vault

Connect copies of the **same vault** to the same server, and give each unrelated vault its own server. Vault names don't keep data apart: when you connect a vault that has files to a server that already has files, Crate asks to replace the vault with the server's contents. Select **Cancel** to keep the vault as it is.

## Privacy

Both options support [optional end-to-end encryption](/docs/features/encryption/), which you turn on in Crate settings. Without it, your server can read synced content. With it, content and file and folder names are encrypted; folder structure, sizes, and notification scheduling details stay visible to your server.
