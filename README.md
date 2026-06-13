# Crate

Self-hosted Obsidian vault sync and reminders using Cloudflare R2, Workers, D1, and push notifications.

Crate is an Obsidian plugin for people who want to own the infrastructure behind their vault sync. You bring a Cloudflare account, Crate provisions the required resources, and your vault files sync through your own Worker and R2 bucket.

Crate is not a hosted service and does not require a Crate account.

## Status

Crate is early self-hosted software. Review the code, understand the Cloudflare resources it creates, and test with a non-critical vault before using it for important notes.

It is not currently distributed through the Obsidian community plugin catalog. Install it from source or from release artifacts.

## Features

- Sync vault files across desktop and mobile Obsidian
- Store file contents in your own Cloudflare R2 bucket
- Track sync metadata and registered devices in Cloudflare D1
- Detect conflicts and preserve both versions instead of overwriting silently
- Sync creates, edits, deletes, renames, and attachments
- Manage devices, sync settings, usage, and Cloudflare infrastructure from Obsidian
- Create and browse reminders stored as Markdown in your vault
- Render reminder query blocks such as `reminders`, `reminders-today`, and `reminders-upcoming`
- Schedule reminder push notifications through your own Worker
- Enroll phones with short-lived web app links or QR codes

## How It Works

The Obsidian plugin owns sync planning, change detection, conflict handling, and local settings. The Cloudflare Worker is the storage API. It stores file contents in R2, metadata in D1, and reminder notification alarms in Durable Objects.

Your Cloudflare API token is used for setup and infrastructure management. Sync devices use separate bearer tokens. Push-notification enrollment uses short-lived one-time setup tokens instead of exposing the long-lived sync token in browser URLs or local storage.

## Privacy and Security

- Vault files are sent to your Worker and stored in your R2 bucket.
- Sync metadata and registered device records are stored in your D1 database.
- Crate does not include hidden telemetry.
- Cloudflare and sync secrets are stored through Obsidian's secret storage where available.
- Push enrollment links are short-lived and scoped for setup.
- Remote code is not fetched or evaluated at runtime.
- Vault contents are not end-to-end encrypted by Crate. Your Cloudflare account and Worker can access the synced data.

## Prerequisites

- Node.js 20.19 or newer LTS (20.19+, 22.12+, or 24+)
- npm
- A Cloudflare account with R2 enabled
- Obsidian desktop for local development and deployment

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
<Vault>/.obsidian/plugins/obsidian-crate/
```

Then reload Obsidian and enable **Crate** in **Settings -> Community plugins**.

## Local Vault Deploys

For repeated local testing, save a vault path:

```bash
npm run deploy:configure
```

This writes `deploy.local.json`, which is ignored by git.

Deploy to that vault:

```bash
npm run deploy
```

`npm run deploy` builds the plugin and copies `dist/main.js`, `manifest.json`, and `dist/styles.css` into the configured vault plugin folder. You can also set `OBSIDIAN_VAULT` for one-off deploys.

## Cloudflare Setup

After installing the plugin, open the Crate settings tab in Obsidian:

1. Select **Open Cloudflare** to open a prefilled API token form.
2. Review the token permissions, narrow the account scope if needed, create the token, and copy it.
3. Paste the API token into Crate and select **Validate**.
4. Select your Cloudflare account.
5. Select **Create infrastructure** to provision the R2 bucket, D1 database, Worker, and required bindings.

Cross-device setup links copy sync credentials and sync preferences. Usage metrics use the same Cloudflare API token entered during setup.

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

Generated files under `.generated/`, `dist/`, and root-level release artifacts such as `main.js` are intentionally not tracked. Release assets should be built and attached separately.

## Documentation

- [Architecture](docs/architecture.md)
- [Sync pipeline](docs/sync-pipeline.md)
- [Worker API](docs/worker-api.md)
- [Testing](docs/testing.md)

## License

Crate is licensed under the [0BSD license](LICENSE).
