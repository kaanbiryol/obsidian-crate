# Crate

Self-hosted Obsidian vault sync and reminders using Cloudflare R2, Workers, D1, and push notifications.

Crate is an Obsidian plugin for people who want to own the infrastructure behind their vault sync. You bring a Cloudflare account, the deploy flow provisions the required resources, and your vault files sync through your own Worker and R2 bucket.

Crate is not a hosted service and does not require a Crate account.

[Deployment and OAuth setup](docs/deployment.md)

## Status

Crate is early self-hosted software. Review the code, understand the Cloudflare resources it creates, and test with a non-critical vault before using it for important notes.

It is not currently distributed through the Obsidian community plugin catalog. Install it from source or from release artifacts.

## Features

- Sync vault files across desktop and mobile Obsidian
- Store file contents in your own Cloudflare R2 bucket
- Track sync metadata and registered devices in Cloudflare D1
- Detect conflicts and preserve both versions instead of overwriting silently
- Sync creates, edits, deletes, renames, and attachments
- Deploy the sync server through Cloudflare without giving the plugin an account API token
- Connect devices by signing in to the Cloudflare account that owns the server
- Create and browse reminders stored as Markdown in your vault
- Render reminder query blocks such as `reminders`, `reminders-today`, and `reminders-upcoming`
- Schedule reminder push notifications through your own Worker
- Enroll phones with short-lived web app links or QR codes

## How It Works

The Obsidian plugin owns sync planning, change detection, conflict handling, and local settings. The independently deployed Cloudflare Worker is the storage API. It stores file contents in R2, sync metadata and parsed reminder caches in D1, and reminder notification alarms in Durable Objects.

The plugin never asks for a Cloudflare account API token. Deployment and device connection use Cloudflare OAuth Authorization Code + PKCE. Crate discovers or creates the account's server, registers a permanent device credential whose plaintext stays in Obsidian, and then revokes the temporary OAuth token.

## Privacy and Security

- Vault files are sent to your Worker and stored in your R2 bucket.
- Sync metadata, registered device records, and parsed reminder caches are stored in your D1 database.
- Crate does not include hidden telemetry.
- Sync secrets are stored through Obsidian's secret storage.
- OAuth state and PKCE material exist only in memory during one deployment; authorization codes and OAuth access tokens are never stored or logged.
- The Worker module and initial D1 schema are versioned build-time artifacts inside the plugin. Crate does not fetch deployment code at runtime.
- Vault devices can be authorized only through the Cloudflare account that owns the server.
- Push and reminders web enrollment links are short-lived and cannot grant vault sync access.
- Remote code is not fetched or evaluated at runtime.
- Vault contents are not end-to-end encrypted by Crate. Your Cloudflare account and Worker can access the synced data.

## Prerequisites

- A Cloudflare account with R2 enabled
- Obsidian 1.13.0 or newer

Building from source additionally requires Node.js 20.19+, 22.12+, or 24+ and npm.

## Install From Source

Clone the repository and install dependencies:

```bash
git clone https://github.com/kaanbiryol/obsidian-crate.git
cd obsidian-crate
npm install
```

Build the plugin:

```bash
npm run build
```

Build artifacts are written to `dist/`:

- `dist/main.js`
- `dist/styles.css`

Copy `dist/main.js`, `manifest.json`, and `dist/styles.css` into:

```text
<Vault>/.obsidian/plugins/crate/
```

Then reload Obsidian and enable **Crate** in **Settings -> Community plugins**.

## Local Vault Deploys

For repeated local testing, save a vault path:

```bash
npm run deploy:plugin:configure
```

This writes `deploy.local.json`, which is ignored by git.

Deploy to that vault:

```bash
npm run deploy:plugin
```

`npm run deploy:plugin` builds the plugin and copies `dist/main.js`, `manifest.json`, and `dist/styles.css` into the configured vault plugin folder. You can also set `OBSIDIAN_VAULT` for one-off deploys.

## Cloudflare Setup

After installing the plugin, open the Crate settings tab in Obsidian:

1. Select **Connect with Cloudflare**. Your browser opens Cloudflare OAuth.
2. Select one Cloudflare account, review the minimum permissions, and authorize Crate.
3. The static callback at `crate.kaanbiryol.com` returns to Obsidian. Crate reuses an existing Crate server in that account or provisions a new Worker, R2 bucket, D1 database, Durable Objects, endpoint, and initial schema.
4. Crate registers this device through the Cloudflare-authorized D1 API, revokes the temporary OAuth token, and connects automatically.
5. Run **Initial sync → Upload all** when you are ready to seed the remote vault.

The OAuth deployment uses the build-time Worker and initial schema included in the installed plugin. The permanent sync credential is generated inside Obsidian; only its SHA-256 hash is registered in D1.

To connect another computer or mobile device, install Crate there and select **Connect with Cloudflare**. Access to the Cloudflare account is the source of truth for vault membership. If the account contains more than one Crate server, Obsidian asks which one belongs to the vault.

**Disconnect this device** removes the local sync credential while retaining the non-secret deployment identity. Signing in to Cloudflare again reconnects the same server.

For the one-time GitHub Pages and OAuth-client configuration, updates, and recovery instructions, see [Deploying and operating the server](docs/deployment.md). When the installed Crate build contains newer Worker, web app, or schema artifacts, Obsidian shows a server-update notice and **Authorize update** appears in Crate settings. Updating reuses the resource IDs saved by the initial OAuth deployment.

## Sync Scope and Limits

- Crate syncs files inside the vault, including attachments. Hidden dotfiles and dot-folders can also be synced; they are not excluded as a group.
- Files larger than 25 MiB (25 × 1024 × 1024 bytes) are skipped and reported as sync errors. They are not uploaded to or downloaded from the remote vault.
- The default ignore patterns are `.git/`, `.trash/`, `*.tmp`, and `.DS_Store`. Crate always ignores the active Obsidian configuration folder's entire `plugins/` tree, its Markdown merge cache, conflict copies, and `workspace*` files.
- Change ignore patterns under **Settings → Crate → Sync → Ignore patterns**. A pattern ending in `/` ignores that directory tree; `*` and `?` wildcards are supported.
- Cloudflare account and plan quotas still apply to R2, Workers, D1, and push-notification resources.

## Reminders

Crate stores reminders as Markdown in a configurable vault folder. The plugin indexes those files, provides sidebar and full-screen reminder views, and registers commands for creating reminders, opening projects, and viewing reminder storage statistics.

Reminder code blocks can be embedded in notes:

````markdown
```reminders-today
```

```reminders-upcoming
```
````

When push notifications are enabled, Crate schedules reminder notifications through your Worker and lets you enroll additional devices from the settings tab.

## Development

Run the dev watcher:

```bash
npm run dev
```

Each successful development build is also installed into
`test-vault/.obsidian/plugins/crate/`. Open `test-vault` as an Obsidian vault,
enable **Crate** in **Settings → Community plugins**, and reload the plugin after
changes. The installer only replaces `main.js`, `manifest.json`, and `styles.css`,
so local plugin settings are preserved.

Set `OBSIDIAN_TEST_VAULT` to use another development vault without changing the
production deploy configuration:

```bash
OBSIDIAN_TEST_VAULT=/path/to/vault npm run dev
```

Run tests:

```bash
npm test
```

Run lint:

```bash
npm run lint
```

Run TypeScript checks:

```bash
npm run typecheck
npm run typecheck:worker
```

Run the main local verification suite:

```bash
npm run check
```

Run a production build:

```bash
npm run build
```

Run the complete first-release gate, including plugin and Worker size budgets plus artifact separation checks:

```bash
npm run release:check
```

Generated files under `.generated/`, `dist/`, and root-level release artifacts such as `main.js` are intentionally not tracked. Release assets should be built and attached separately.

## Documentation

- [Architecture](docs/architecture.md)
- [Deploying and operating the server](docs/deployment.md)
- [Sync pipeline](docs/sync-pipeline.md)
- [Worker API](docs/worker-api.md)
- [Testing](docs/testing.md)

## License

Crate is licensed under the [0BSD license](LICENSE).
