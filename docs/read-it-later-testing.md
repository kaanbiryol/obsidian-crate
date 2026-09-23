# Test Reading

This branch contains the plugin, server, web library, background extraction, Web Clipper template, and iPhone/Android capture flows. Server revision 66 upgrades schema 1 to schema 2; protocol 11 stays compatible.

## Try the browser now

Run `npm run preview:reading`, then open <http://localhost:8877/preview/start>. This starts the real built server in an isolated `.crate/reading-preview` directory. The link creates fresh Reading access on each visit. It does not connect to your real vault or deployment. Stop the command with Ctrl+C; its test data remains for the next run.

Save a public article, wait for extraction, open it, favorite it, add tags, archive it, and restore it to the inbox. Open an article once before testing offline reading. Offline changes remain listed as pending until the server confirms them. The exported recovery JSON contains saved articles and pending work, so keep it private.

## Test in Obsidian

1. Build with `npm run build`. Copy `dist/main.js`, `dist/styles.css`, and `manifest.json` into a test vault's `.obsidian/plugins/crate/` directory. Reload the plugin.
2. In **Settings → Crate → Reading**, enable Reading on this device. Use **Crate: Add reading link** and **Crate: Open reading**. These work locally before connecting a server.
3. Connect the test vault to a server built from this branch. For a fresh local server, use `npm run server -- start --local --data-dir ./test-results/reading-server`. For phone access, use the existing HTTPS server/tunnel setup described in the README.
4. Select **Enable server reading**. An already enrolled Reminders web app should open Reading through its feature switch without another setup link. For a browser without a Reminders connection, select **Open web reading** or use **Copy setup link** on another device. Setup links expire after 10 minutes and are single use.
5. Select **Copy template**, import it from the clipboard in Obsidian Web Clipper, and save with **Crate Reading** into the test vault. Crate preserves the clip's body and filename; it appears in the web library after normal sync. With automatic sync off, select **Crate: Sync now**.

The reader suppresses remote images and active HTML. **Open note** uses Obsidian's normal Markdown rendering. Unmarked notes are not adopted. Changes to Reading metadata preserve personal notes and unknown YAML properties.

## Test iPhone

For iOS 27, the Pages workflow builds and signs the credential-free pairing template on macOS and publishes it at `/shortcuts/v1/Save%20to%20Crate%20(iOS%2027).shortcut`. Publish that website artifact before rolling out server revision 67. Retain this versioned path for installed servers; a breaking pairing protocol needs a new path. To build locally, run `npm run build:reading-shortcut -- --pairing`. This writes `dist/Save to Crate (iOS 27).shortcut` and its readable `.plist`; generated artifacts are never committed. Only the public template is sent to Apple’s signing service. The builder is `scripts/reading-shortcut-first-run.mjs`, using the capture actions from `docs/shortcuts/save-to-crate.plist`.

1. On the enrolled phone, select **Reading settings → Set up iPhone shortcut** in the PWA. For a new phone, in Obsidian select **Set up shortcut → Copy phone setup link**, then open that link in Safari within 10 minutes.
2. Select **Download Save to Crate**, open the file in Shortcuts, and select **Add Shortcut**. If Safari saves it to Downloads, open the file from Files. Return to Crate, select **Create pairing code → Copy pairing code**, then run the shortcut from **All Shortcuts** and paste when asked. Wait for **Crate setup saved**. Use HTTPS; the code expires after 10 minutes and works once. A new code replaces the previous one. If an exchange reply is lost, create a new code and run setup again. No permanent credential is copied out of the PWA.
3. Share a web link and select **Save to Crate (iOS 27)**. Allow access to your Crate server if Shortcuts asks. **Show Web View** presents the branded page in an iOS browser sheet. **Saved to Crate** appears after the bookmark is committed; article extraction continues in the background. Dismiss the sheet when finished. iOS controls its size and browser controls.
4. Retry on the same page after an interrupted save. Sharing the same URL again returns **Already saved**, without moving an archived item back to the inbox.
5. To read, open a Reading setup link in Safari. For installation, select **Share → Add to Home Screen** within 10 minutes. Library access and shortcut capture access are separate. The shortcut cannot read the library or vault.

The iOS 27 variant uses Apple's shortcut-scoped Storage to remember setup between runs. These values may sync to your other Apple devices through Shortcuts; they are accessible to the shortcut's owner. See [Apple's Storage overview](https://developer.apple.com/videos/play/wwdc2026/310/). Running without a shared URL opens setup again. Cancelling or entering invalid values leaves the previous stored configuration intact; pairing verifies the code with the server before saving the new configuration. A first share before configuration also opens setup.

The shortcut requires connectivity. Use the enrolled web app's link form for an offline pending save. Browser credentials expire after 90 days; paired capture access expires no later than its issuing browser session and can be revoked from connected devices in Obsidian. A changed tunnel hostname needs fresh browser enrollment and an updated shortcut endpoint. Create a new pairing code and run the iOS 27 shortcut from its library to reconnect.

For older iOS, `npm run build:reading-shortcut` still creates `dist/Save to Crate.shortcut`, with two installation questions. On the affected iOS 27.0 phone, **Add Shortcut** repeatedly did nothing after both answers and no shortcut appeared in the library. The iOS 27 variant avoids that installation path. The cause of the original failure is not established, and dismissing the stalled dialog did not fix the phone. Do not direct that tester through the original template again.

The earlier manual iOS 27 variant remains available with `--first-run-setup` and expects an endpoint and Bearer header from Obsidian. Its native acceptance evidence below does not cover the new one-paste pairing flow.

Before accepting iPhone setup, verify installation, first-run configuration, and a share-sheet save reaching **Saved to Crate** on a physical device. On macOS 27, native testing verified import without questions, both runtime prompts, trimming pasted whitespace, rejecting a non-HTTPS endpoint and a header missing its Bearer prefix, the setup confirmation, and a later shared-link invocation reaching the request permission prompt with the stored endpoint and shared URL. Invalid reconfiguration preserved the previously saved endpoint. Those request probes used dummy credentials and a deliberately invalid hostname, and were stopped before any successful request. A clean reinstall also verified that sharing before configuration opens setup; cancelling left it unconfigured. These checks do not verify iPhone execution. Run `node --test scripts/reading-shortcut.test.mjs` on macOS for serialization and variable-reference regressions. After `npm run build:worker`, run `node --test scripts/reading-shortcut-server.test.mjs scripts/reading-shortcut-browser.test.mjs` for real D1 redemption, expiry/revocation/scope boundaries, and Chromium/WebKit setup UI. Physical acceptance must additionally cover the website download opening Shortcuts, one-paste pairing, cancelled/failed re-pairing preserving the previous setup, and a shared link reaching Saved.

The tester subsequently reported that the iOS 27 shortcut worked on the phone, but its **Open URLs** action immediately switched to Safari. The current template replaces that action with **Show Web View** and keeps the same prepared handoff. Verify this revised presentation on iPhone: save and duplicate-save confirmation, dismissing back to the source app, retry after a connection interruption, and closing before confirmation. The sheet must retain the handoff fragment long enough to commit the save, and must not be assumed to share the user's Safari Reading session. The iPhone sheet itself has not been verified on the Mac.

## Test Android

Install the enrolled Crate web app in a browser supporting Web Share Target. **Share → Crate** opens the Reading form with the link prefilled; select **Save link**. The service worker keeps the incoming share on the device before opening the form, including offline. Paste a URL manually when the browser does not support share targets.

## Existing server upgrade

Cloudflare updates take a verified paired database/file checkpoint before applying the migration. Database triggers pause writes by the old Worker while the checkpoint and migration run. The update retains its deployment fence after an uncertain failure; use the existing **Check and recover update** flow. The backup prefix is recorded in `maintenance_state` as `crate_upgrade_checkpoint`. `scripts/crate-recovery.py download-checkpoint --help` describes copying it into the ordinary paired recovery archive format. Backups consume additional R2 storage and are retained for recovery.

For a self-hosted server, stop it first, then run:

```sh
npm run server -- check-upgrade --data-dir /path/to/server-data
npm run server -- upgrade --data-dir /path/to/server-data --output /path/to/new-backup
npm run server -- start --local --data-dir /path/to/server-data
```

Keep the previous build and backup for recovery. Normal startup refuses an old schema instead of modifying it. Do not edit `server.json` or run fresh-install SQL over existing data.

## Verification and limits

Completed on 2026-09-21: source checks (305 files / 2,600 tests), the Worker suite (65 files / 489 tests), 17 local-server/package checks, 3 Reading server/upgrade/network checks, Chromium and WebKit end-to-end flows, 6 Reading visual checks, reminder update/auth/layout regressions, and Docker restart/recovery. Build, CSS scope, artifact and bundle-budget checks pass. Dependency audit reports no vulnerabilities and the secret scan passes.

A live HTTPS capture from `example.com` was extracted, published by the background job, and opened in the reader. Additional native-network probes fetched Wikipedia and rejected a mismatched TLS certificate. The signed Shortcut's variable connections were inspected in Apple's macOS app. Native setup and persistence checks and the subsequent iPhone report are described above; the revised web-sheet presentation remains a device acceptance check.

Automated checks exercise Markdown preservation, stable identities, source edits/deletion during extraction, exact retry receipts, capture-only scopes, one-use browser/install grants, private-network rejection in the actual local runtime, schema upgrades, backup verification, Chromium and WebKit reading/capture flows, and existing reminders behavior. Chromium covers cold offline launch and the share-target POST; Playwright WebKit has a known offline-navigation limitation and covers cached reading without a cold offline reload.

Extraction uses Defuddle 0.19.4 and linkedom 0.18.12 with asynchronous fallbacks disabled. Defuddle's own `createMarkdownContent` produces the Markdown; Crate registers no formatting rules. A module-local DOMParser adapter lets the published browser bundle run in workerd. Crate validates links and excludes remote media before conversion, strips source-content diagnostics at build time, and rejects the library's raw-HTML error fallback. Public X posts with server-rendered markup are selected by their exact post permalink; unrecognized login shells remain saved links. Extraction makes no third-party fallback requests. Defuddle's two aggressive scoring/pattern passes stay disabled because they remove legitimate short lists and repeated headings; structural cleanup remains enabled. Cloudflare deployments enable `global_fetch_strictly_public`; the local runtime supplies a native network binding allowing public addresses only, enforced after DNS resolution. Redirects are checked individually, requests time out after 15 seconds, and decoded HTML is capped at 2 MiB. Crate does not send browser cookies or Crate credentials to websites. See [Cloudflare's public fetch boundary](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp).

Login-only pages, JavaScript-only pages, bot protection, large pages, unsupported destinations, and failed fetches remain usable saved links. The queue holds up to 1,000 extraction jobs and retries fetch failures up to three times. Public capture is limited to 30 requests per minute per credential; Reading writes share a 500-per-day credential budget and the deployment's edge admission limit. These requests, database operations, alarms, and saved files use the deployment's ordinary hosting resources.

The revised iPhone sheet flow, Android installation, an installed Obsidian/Web Clipper round trip, and a live Cloudflare upgrade/extraction run remain device/deployment acceptance checks. They are not implied by the automated browser and workerd results. No production deployment is changed by building or running the sandbox.
