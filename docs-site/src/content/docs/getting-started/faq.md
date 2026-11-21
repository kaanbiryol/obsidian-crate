---
title: Common questions
description: Quick answers about cost, accounts, privacy, other sync tools, several vaults, and what happens to your notes if you stop using Crate.
---

## Does Crate cost anything?

Crate is free and open source under the MIT license. There's no Crate subscription or account.

Your server is where any cost comes from. On Cloudflare, usage within the free allowance costs nothing, and Cloudflare bills you for anything beyond it. Cloudflare asks for a payment method when you turn on R2, even if you stay within the free allowance. On your own hardware, you pay only for the machine you run it on. [Choose your hosting](/docs/getting-started/hosting/) compares the two.

## Do I need a server?

Only for some features. Reading and Reminders work on one device without a server. You need one for vault sync, the web app, and reminder alerts on your phone or with Obsidian closed.

## Does Crate collect my data?

No. Crate has no hidden telemetry and no Crate account. Your vault goes to the server you set up, in your Cloudflare account or on your own computer. Crate also contacts Cloudflare when you create, update or delete a Cloudflare server, and the websites you save to Reading. The [README](https://github.com/kaanbiryol/obsidian-crate#accounts-costs-and-network-use) lists every network connection, and the [privacy policy](/privacy/) covers the rest.

Without [end-to-end encryption](/docs/features/encryption/), whoever runs your server can read your synced notes. With it, the server stores only encrypted content.

## Which devices does Crate run on?

Obsidian 1.13.0 or newer on desktop and mobile. Creating, updating or deleting a Cloudflare server needs a desktop, because phones can pause Obsidian partway through. The web app runs in your browser and installs to an iPhone, iPad or Android Home Screen.

## Can I use Crate with Obsidian Sync, iCloud, or another sync tool?

Use one sync tool per vault. Crate syncs your whole vault, including other plugins and their settings. If a second tool also syncs the same folder, both write the same files, which can cause duplicates and conflicts, and a deletion made by one spreads through the other.

To move a vault to Crate, turn off the other sync tool for that vault first, or move the vault out of a synced folder such as iCloud Drive. A backup tool that only copies your vault elsewhere is fine, and recommended.

## Can I sync more than one vault?

Yes. Give each vault its own server. Connecting a vault to a server that already holds another vault replaces this vault's contents with the server's, after asking first.

- **Cloudflare:** select **Create server** when you connect the new vault.
- **Docker:** each server holds one vault. Run a second copy with its own project name, such as `docker compose -p crate-work up -d --build`, and use the same `-p` name in every command for it.

## What happens to my notes if I stop using Crate?

They stay where they are, as ordinary Markdown files in your vault. Reminders keep small hidden `<!-- crate-id:… -->` comments on their checkbox lines, and Reading notes keep a few `crate_reading_` properties. Both are harmless if you leave them. [Move or remove Crate](/docs/features/move-or-remove/) covers deleting your server and uninstalling the plugin.

## Is sync a backup?

No. Sync copies deletions as well as edits, so a mistake on one device reaches all of them. Crate keeps [file history and saved vault states](/docs/troubleshooting/recovery/) for a limited time. Keep a separate backup of any vault that matters to you.
