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

The CLI sets up an R2 bucket and deploys a Cloudflare Worker for you:

```bash
# Login to Cloudflare
npm run build:cli
npx crate login

# Create R2 bucket + deploy worker
npx crate init
```

After init completes, copy the worker URL and auth token into the Crate plugin settings.

## Development

### Build the plugin

```bash
npm run build
```

This runs TypeScript type checking followed by an esbuild bundle, producing `main.js`.

### Build the CLI

```bash
npm run build:cli
```

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

## CLI Commands

| Command | Description |
|---|---|
| `crate login` | Authenticate with Cloudflare via browser |
| `crate logout` | Clear stored credentials |
| `crate init` | Create R2 bucket and deploy worker |
| `crate deploy` | Redeploy the worker script to an existing worker |
| `crate doctor` | Diagnose and verify your setup |

### Redeploy the worker

After making changes to the worker template, redeploy with:

```bash
npx crate deploy
```

This uses the worker name saved from `crate init`. You can also specify it explicitly:

```bash
npx crate deploy --worker-name <name>
```

Existing R2 bucket bindings and auth token are preserved.
