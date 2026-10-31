---
title: Install Crate
description: Install the Crate beta in Obsidian using BRAT, or install release files manually.
---

Crate is an Obsidian plugin, so you install it inside Obsidian on each device where you want it. You need **Obsidian 1.13.0 or newer**.

Crate isn't in Obsidian's community plugin catalog yet. Until it is, a helper plugin called BRAT installs it for you and keeps it updated. Before you start, read [what to know about the beta](/docs/getting-started/limits/).

## Install with BRAT

1. In Obsidian, open **Settings → Community plugins**. Enable community plugins if asked, then select **Browse**.
2. Search for **BRAT**, install it, and enable it.
3. Open **Settings → BRAT** and select **Add beta plugin**.
4. Enter the repository below, select the latest release, and add the plugin.
5. Go back to **Settings → Community plugins** and enable **Crate**.

```text
kaanbiryol/obsidian-crate
```

Crate is now installed. Open **Settings → Crate** to finish setup. If BRAT gives you trouble, see [BRAT's installation guide](https://tfthacker.com/brat-quick-guide).

## What next?

- **Sync your vault or use the web app:** [choose where your server runs](/docs/getting-started/hosting/), either your Cloudflare account or your own computer with Docker. After connecting, Crate asks which features to manage in this vault.
- **Just try it on this device:** turn on **Reading** or **Reminders** in **Settings → Crate**, then run **Crate: Add link to reading list** or **Crate: Create reminder** from Obsidian's command palette. Both work without a server. Crate shows the folder each feature will use before it changes any notes.

Vault sync, the web app, and notifications need a server.

When you're ready, follow [Reading](/docs/features/reading/) or [Reminders](/docs/features/reminders/) for everyday use, and [Choose and manage features](/docs/features/settings/) to adjust your setup.

<details>
<summary>Install release files manually</summary>

Download `main.js`, `manifest.json`, and `styles.css` from the same [Crate release](https://github.com/kaanbiryol/obsidian-crate/releases). Put them in this folder inside your vault:

```text
.obsidian/plugins/crate/
```

Reload Obsidian, then enable **Crate** under **Settings → Community plugins**. If your vault uses a custom configuration folder, use it instead of `.obsidian`.

</details>

Want to work on the plugin itself? Follow the repository's [build-from-source instructions](https://github.com/kaanbiryol/obsidian-crate#install-from-source).
