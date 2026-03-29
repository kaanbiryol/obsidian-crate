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

This runs the worker bundle step, TypeScript checks, and the Vite build.

Build artifacts are written to `dist/`:

- `dist/main.js`
- `dist/styles.css`

### Install plugin to your vault

```bash
export OBSIDIAN_VAULT="/path/to/your/vault"
npm run deploy
```

This builds the plugin and copies `dist/main.js`, `manifest.json`, and `dist/styles.css` into your vault's plugin directory.

### Watch mode

```bash
npm run dev
```

### Run tests

```bash
npm test
```

### Run lint

```bash
npm run lint
```

Note: the repository currently contains broader lint debt outside the most critical sync/worker paths. Use tests and production builds as the primary verification gates for functional changes.
