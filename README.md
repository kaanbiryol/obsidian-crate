# Crate

Sync your Obsidian vault to Cloudflare R2 storage via a Cloudflare Worker.

## Setup

### Prerequisites

- Node.js >= 18
- A Cloudflare account with R2 enabled

### Install dependencies

```bash
npm install
```

### Initialize Cloudflare infrastructure

Use the plugin settings UI to set up Cloudflare infrastructure (R2 bucket, D1 database, Worker). The setup flow is accessible from the Crate settings tab in Obsidian.

## Development

### Build the plugin

```bash
npm run build
```

This runs TypeScript type checking followed by an esbuild bundle, producing `main.js`.

### Install plugin to your vault

```bash
export OBSIDIAN_VAULT="/path/to/your/vault"
npm run deploy
```

This builds the plugin and copies `main.js`, `manifest.json`, and `styles.css` into your vault's plugin directory.

### Watch mode

```bash
npm run dev
```

