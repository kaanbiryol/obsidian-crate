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
- The Worker module and current D1 schema are versioned build-time artifacts inside the plugin. Crate initializes empty databases, upgrades schema 2/3/4 to schema 5 without rewriting vault data, and rejects unsupported schemas. Deployment code is never fetched at runtime.
- Vault devices can be authorized only through the Cloudflare account that owns the server.
- Push and reminders web enrollment links are short-lived and cannot grant vault sync access.
- When installing the reminders web app, Safari carries a separate, single-use enrollment grant in the install URL and a ten-minute cookie copied into the Home Screen app. The app clears these after enrollment and keeps its own session; Safari's persistent login credential is not copied. Open the new app within ten minutes of creating the link.
- Push notifications are optional. When enabled, your Worker sends encrypted payloads containing reminder text and project names through the push service used by the browser or operating system. The provider can observe delivery metadata such as the subscription endpoint, timing, and payload size, but cannot read the encrypted payload.
- The reminders web app stores its scoped session and pending reminder changes in browser local storage, and caches confirmed reminder and project content in IndexedDB for offline use. Signing out clears both.
- Remote code is not fetched or evaluated at runtime.
- Vault contents are not end-to-end encrypted by Crate. Your Cloudflare account and Worker can access the synced data.
- Sync is not a backup. Keep an independent backup of any vault you use with Crate. The [paired D1/R2 recovery CLI](docs/recovery.md) creates verified remote archives and restores them into isolated resources.
- Remote deletions always move local files into the vault's `.trash` folder, even if Obsidian is set to delete permanently. Check that folder when recovering an edit made during sync. Crate never syncs `.trash`.

Read the full [privacy policy](https://crate.kaanbiryol.com/privacy/).

## Prerequisites

- A Cloudflare account with R2 enabled
- Obsidian 1.13.0 or newer

Building from source additionally requires Node.js 26.8.2+ (26.x) and npm; `.nvmrc` pins the version used by every CI workflow.

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
3. The static callback at `crate.kaanbiryol.com` returns to Obsidian. Crate reuses an existing Crate server in that account or provisions a new Worker, R2 bucket, D1 database, Durable Objects, endpoint, and schema.
4. Crate registers this device through the Cloudflare-authorized D1 API, revokes the temporary OAuth token, and connects automatically.
5. No vault files are transferred during connection. Select **Sync now** to sync this vault with the server.

The OAuth deployment uses the build-time Worker and current schema included in the installed plugin. Unsupported databases are rejected without modification; see the [recovery runbook](docs/recovery.md) before changing deployments. The permanent sync credential is generated inside Obsidian; only its SHA-256 hash is registered in D1.

To connect another computer or mobile device, install Crate there and select **Connect with Cloudflare**. Access to the Cloudflare account is the source of truth for vault membership. If the account contains more than one Crate server, Obsidian asks which one belongs to the vault.

**Disconnect this device** removes the local sync credential while retaining the non-secret deployment identity. Signing in to Cloudflare again reconnects the same server.

For the one-time GitHub Pages and OAuth-client configuration, updates, and recovery instructions, see [Deploying and operating the server](docs/deployment.md). When the installed Crate build contains newer Worker, web app, or schema artifacts, Obsidian shows a server-update notice and **Authorize update** appears in Crate settings. Updating reuses the resource IDs saved by the initial OAuth deployment.

## Sync Scope and Limits

- After the first sync, Crate syncs on startup, when Obsidian resumes, and every five minutes by default. These automatic sync options can be changed under **Settings → Crate → Sync**.
- Crate syncs files inside the vault, including attachments. Hidden dotfiles and dot-folders can also be synced; they are not excluded as a group.
- Files larger than 25 MiB (25 × 1024 × 1024 bytes) are skipped and reported as sync errors. They are not uploaded to or downloaded from the remote vault.
- The default ignore patterns are `.git/`, `.trash/`, `*.tmp`, and `.DS_Store`. Crate always ignores the active Obsidian configuration folder's entire `plugins/` tree, its Markdown merge cache, conflict copies, and `workspace*` files.
- Change ignore patterns under **Settings → Crate → Sync → Ignore patterns**. A pattern ending in `/` ignores that directory tree; `*` and `?` wildcards are supported.
- Adding an ignore pattern stops future transfers but does not silently delete an existing remote copy. Use **Settings → Crate → Infrastructure → Remove ignored remote files** to review and remove those copies explicitly.
- Remote files replaced or deleted by sync are retained for 30 days. Use **Restore remote file** in Crate settings to recover one; a force full sync also keeps its remote deletions recoverable for that period.
- Synced paths must be portable across desktop and mobile filesystems. Windows-reserved names, unsupported characters, trailing dots/spaces, and case- or Unicode-normalization collisions are rejected before transfer.
- Creating a server provisions Worker, R2, D1, and Durable Object resources in your Cloudflare account. Cloudflare plan limits and possible usage charges apply to those resources.

## Reminders

Crate stores reminders as Markdown in a configurable vault folder. Reminders are disabled on new installs until you explicitly adopt a folder in **Settings → Crate → Reminders**. Adoption scans that folder and adds stable `<!-- crate-id:... -->` comments to checkbox lines so reminders can be updated safely. The plugin then provides a reminders workspace view and registers commands for creating reminders and opening projects.

When Obsidian adopts or rescans a reminder, relative dates such as `tomorrow` and times without a timezone are resolved once in that device's timezone and saved as explicit dates or UTC timestamps. Recurring reminders also save their timezone and first occurrence. Existing reminder IDs, titles, and descriptions are preserved. Editing a saved date back to natural language resolves it again on the next scan. The web app reports an unresolved schedule until Obsidian saves it; vault file sync continues. This keeps the same saved reminder date across devices, reloads, and midnight.

Code fences, indented code, frontmatter, and hidden HTML examples are excluded from reminders and remain unchanged during adoption. Reorder supports simple task lists within the same section. Use the Markdown editor to reorder nested tasks or tasks with supporting paragraphs, or to move/delete a task together with its children. Crate rejects these structural changes in the reminder list before editing the note.

Plugin project moves save a recovery record in the plugin's private configuration directory before changing either note. After an interruption, Crate checks both notes before indexing them and completes or rolls back only a verifiable move. If both copies changed, it keeps them and pauses reminder edits and normalization for those notes. Merge or keep the wanted text in one note, remove the duplicate from the other, then run **Crate: Recover interrupted reminder moves**. The notice identifies the affected notes and recovery-record location; damaged records are retained for manual recovery. These records remain on the device and are excluded from vault sync.

Reminder code blocks can be embedded in notes:

````markdown
```reminders-today
```

```reminders-upcoming
```
````

The Worker schedules notifications from committed Markdown using a shared folder, timezone, all-day time, and enabled setting. Another device's startup does not replace that policy. **Settings → Crate → Push notifications** shows the server's folder and timezone; explicit changes apply to all devices. The web app session is restricted to its enrolled reminders folder. Signing out clears its offline data and drafts across tabs and revokes the session's subscriptions. If remote revocation fails, the signed-out screen explains how to remove the session through connected devices in Obsidian.

The web app checks browser permission and confirms push registration with the current server session when opened, resumed, or reconnected. **On** appears after confirmation. If registration fails, **Retry** repairs the existing browser subscription; if permission is blocked, allow notifications in browser settings and reopen Crate.

The reminders web app downloads new app versions automatically when opened or brought back to the foreground, including on iPhone Home Screen installs. It applies the update after a brief idle period once editors and settings are closed and pending changes have finished syncing. Updates wait while the app is offline or in the background. If an automatic update fails, the **Update** button remains available; reopening or returning to the app retries the update. An already-open editor in another tab is not reloaded.

The reminders web app updates immediately when you save, complete, delete, or reorder a reminder. Pending changes are kept on the device and resume syncing when the app is open and connected, including after a reload. If a save is rejected, the app keeps your text with **Retry**, **Edit**, and **Discard** actions. Other rejected changes restore the confirmed state and offer **Retry** or **Dismiss**. A lost response leaves a change pending until the app can confirm the result. If your session expires or is renewed, pending changes and editor drafts remain on the device. Reconnect to the same deployment and reminders folder, review or export the saved changes, then select **Resume saved changes** to check their original receipts and retry safely. Changes from another folder are never resumed automatically. Browsing cached reminders while offline remains read-only; reconnect before starting a new change. Explicitly signing out clears pending changes along with the offline cache and drafts across tabs.

If **Offline copy unavailable** appears, close older Crate tabs and select **Rebuild offline copy** while connected. This refreshes confirmed data and preserves pending changes and drafts. Unknown newer formats are left intact. Unreadable pending edits stay on the device under **Damaged pending changes**, where you can review and export their original text while healthy changes continue syncing; see [browser storage recovery](docs/pwa-storage-recovery.md).

Completing a recurring reminder advances the same reminder to its next scheduled occurrence. After the final occurrence, it stays checked. **Reopen this occurrence** keeps that final occurrence's date and reduces its completion count once; completing it again restores that count. Earlier occurrences are not stored as separate tasks and cannot be restored through this action.

Diagnostics flag exhausted delivery attempts. Repair session enrollment or provider access, then reschedule a missed reminder to a future time.

Crate accepts push endpoints from [Apple](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Mozilla](https://mozilla-services.github.io/autopush-rs/http.html), [Google FCM](https://firebase.google.com/docs/reference/fcm/rest), and [Microsoft WNS](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview). The server allows up to 20 subscriptions, with at most five per session, and limits test/enrollment requests. Other push providers need explicit support before they can subscribe.

## Sync and reminder limits

Vault files larger than 25 MiB produce a visible sync error and are left on the device. Reminder notes larger than 1 MiB, or whose parsed reminder data exceeds the cache limit, are omitted from the web list with a per-file explanation; healthy notes stay available. These explanations remain visible with cached reminders and clear after a successful refresh of repaired sources. Split the affected note to restore web editing and notification scheduling. Web edits cannot grow a reminder note beyond 1 MiB.

Existing binary files are never overwritten by an unsafe asynchronous write. Incoming binary changes are saved as review copies and shown in conflicts; review both versions and replace the original when ready. UTF-8 text supported by Obsidian's atomic writer applies automatically when its precondition still matches.

The current protocol is 8; ordinary protocol-7 writes remain supported during upgrades. File restores require the new durable restore capability. Follow the [upgrade order](docs/compatibility.md#upgrade-order), update the plugin/server and reload older web tabs before editing. Uploads are journaled locally before dispatch, and retries recover the original result before starting new work; see [upload recovery and rename preservation](docs/upload-recovery.md). Failed web edits retain a local draft. A retry first resolves the original attempted save; later draft edits then become a separate revision-checked update. Another device's intervening changes still produce a conflict.

New web changes use a server-issued date and can be retried through the next 179 UTC dates (a 180-date window). Retained receipts still confirm earlier commits. After expiry and receipt cleanup, the app stops the change for export and comparison with current reminders; it never silently reissues it. Uncommitted requests from older clients also require review after upgrading. See the [retry and retention policy](docs/reminder-retention.md).

Crate supports the current prerelease formats. Provisioning accepts an empty database or schema 2/3/4/5. Its additive upgrade to schema 5 adds upload receipts and an indexed storage-key lookup, retaining deletion receipts and reminder source verification without rewriting existing vault data. Other schemas are rejected without modification. Current recovery tools archive schema 2/3/4/5 and upgrade supported old archives during isolated restoration. See the [compatibility matrix and rollback policy](docs/compatibility.md).

## Development

Create the local test vault from the versioned sample notes, then run the dev watcher:

```bash
npm run vault:setup
npm run dev
```

The baseline lives in `fixtures/test-vault/`; the working `test-vault/` stays
ignored by Git. Setup adds missing notes and preserves existing edits. See
[test vault setup](docs/testing.md#test-vault-setup) for restoring sample notes.

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

Run the complete first-release gate, including lint, types, dead-code analysis, unit and Worker-runtime tests, the PWA smoke test, size budgets, and release-artifact checks:

```bash
npm run release:check
```

Generated files under `.generated/`, `dist/`, and root-level release artifacts such as `main.js` are intentionally not tracked. Pushing a tag that exactly matches the `x.y.z` version in `manifest.json` runs the release gate and creates a GitHub release with `main.js`, `manifest.json`, and `styles.css` as individual assets.

## Documentation

- [Architecture](docs/architecture.md)
- [Deploying and operating the server](docs/deployment.md)
- [Sync pipeline](docs/sync-pipeline.md)
- [Worker API](docs/worker-api.md)
- [Testing](docs/testing.md)

## Resetting a Crate server

**Settings → Crate → Recovery and troubleshooting → Troubleshooting → Reset server** erases this deployment's remote files, retained versions, database, subscriptions, and reminder state, then rebuilds the server. Local files are kept. The flow requires confirmation and fresh Cloudflare authorization, checks exact ownership, and blocks shared resources or unknown data. Use **Resume server reset** after an interruption. Afterward, upload your local vault and reconnect other devices. See [server reset and recovery](docs/deployment.md#reset-a-crate-server).

## License

Crate is licensed under the [0BSD license](LICENSE).

Licenses and notices for bundled dependencies are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

**Delete server** in **Settings → Crate → Recovery and troubleshooting → Troubleshooting** permanently removes this vault’s verified Crate Worker/web app, database, file bucket and contents, and reminder state without rebuilding. Local vault files and other deployments are kept. It requires confirmation of the exact resources and fresh Cloudflare authorization. Shared resources or unrecognized data block deletion. After an interruption, use **Resume server deletion**; connecting, updating, and resetting remain blocked until deletion completes.
