---
title: Install Crate
description: Install the Crate beta in Obsidian using BRAT, or install release files manually.
---

Crate is an Obsidian plugin for sync, reminders, and reading. You need **Obsidian 1.13.0 or newer** on each device where you install the plugin.

The beta is not in Obsidian's community plugin catalog yet. BRAT can install it and help you keep it updated. Start with a non-critical vault and keep a separate backup of your notes.

## Install with BRAT

1. In Obsidian, open **Settings → Community plugins**. Enable community plugins if needed, then select **Browse**.
2. Search for **BRAT**, install it, and enable it.
3. Open **Settings → BRAT** and select **Add beta plugin**.
4. Enter the repository below, select the latest release, and add the plugin.
5. Return to **Settings → Community plugins** and enable **Crate**.

```text
kaanbiryol/obsidian-crate
```

Open **Settings → Crate** to finish setup. For help with BRAT itself, see [BRAT's installation guide](https://tfthacker.com/brat-quick-guide).

## Choose your next step

For vault sync and the web app, [choose a host](/docs/getting-started/hosting/). You can deploy into your Cloudflare account or run Crate on your own computer with Docker.

To try local features first, use **Crate: Reading - add link** or **Crate: Reminders - create reminder** from Obsidian's command palette. They start enabled and use the `Reading` and `Reminders` folders. A server is needed for vault sync, the web app, and notifications; the current settings screen also shows feature controls after connection.

Follow [Reading](/docs/features/reading/) or [Reminders](/docs/features/reminders/) for everyday use, and [Choose and manage features](/docs/features/settings/) when you are ready to adjust the setup.

## Install release files manually

Download `main.js`, `manifest.json`, and `styles.css` from the same [Crate release](https://github.com/kaanbiryol/obsidian-crate/releases). Place them in this folder inside your vault:

```text
.obsidian/plugins/crate/
```

Reload Obsidian, then enable **Crate** under **Settings → Community plugins**. If you use a custom vault configuration folder, use that folder in place of `.obsidian`.

To work on the plugin itself, follow the repository's [build-from-source instructions](https://github.com/kaanbiryol/obsidian-crate#install-from-source).
