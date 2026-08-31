# Public release checklist

Complete a fresh copy of this checklist for every release candidate. Test the exact `main.js`, `manifest.json`, and `styles.css` files that will be uploaded. Keep the completed record with the release notes or in the release-preparation pull request.

## Candidate identity

- [ ] Version matches `manifest.json` and `versions.json`:
- [ ] Git commit:
- [ ] `main.js` SHA-256:
- [ ] `manifest.json` SHA-256:
- [ ] `styles.css` SHA-256:
- [ ] Tester and date:

## Automated gates

- [ ] `npm ci` completed with the release Node version from `.nvmrc`.
- [ ] `npm run release:check` passed on the release commit.
- [ ] GitHub Actions passed on Node 20.19.0, 22.12.0, and 24.0.0.
- [ ] Builds from all three Node versions produced identical release artifact hashes.
- [ ] Obsidian's community-directory **Review branch** scan has no unresolved errors or warnings.
- [ ] The scanner reproduced `main.js` and `styles.css` from source.

## Desktop and Cloudflare

- [ ] Installed the exact release assets in a clean vault on Obsidian 1.13.0 or raised `minAppVersion` to the oldest passing version.
- [ ] Connected through OAuth using an account unrelated to the OAuth publisher and confirmed the requested permissions.
- [ ] Confirmed connection alone transfers no vault files.
- [ ] Completed an explicit initial upload using non-critical test data.
- [ ] Restarted Obsidian and completed a normal sync.
- [ ] Disconnected and reconnected the device without creating duplicate Cloudflare resources.
- [ ] Authorized a server update and confirmed the existing Worker, D1 database, R2 bucket, and Durable Objects were reused.
- [ ] Confirmed the inactive-R2 error gives actionable setup guidance.

## iOS

- [ ] Tested on a physical device and recorded the iOS and Obsidian versions.
- [ ] Joined the existing server with **Sync now**.
- [ ] Created, edited, renamed, and deleted Markdown and binary files.
- [ ] Created a concurrent edit and confirmed both versions were preserved.
- [ ] Backgrounded and resumed Obsidian, then disabled and re-enabled Crate.
- [ ] Created, edited, completed, reordered, and deleted reminders.

## Android

- [ ] Tested on a physical device and recorded the Android and Obsidian versions.
- [ ] Joined the existing server with **Sync now**.
- [ ] Created, edited, renamed, and deleted Markdown and binary files.
- [ ] Created a concurrent edit and confirmed both versions were preserved.
- [ ] Backgrounded and resumed Obsidian, then disabled and re-enabled Crate.
- [ ] Created, edited, completed, reordered, and deleted reminders.

## Reminders web app and push

- [ ] Installed the web app on iOS and Android.
- [ ] Enabled push and received a test notification.
- [ ] Received a scheduled reminder notification.
- [ ] Confirmed sign-out clears the local session and offline reminder cache.
- [ ] Confirmed the previous browser session cannot access the API after sign-out.

## Disclosure and operations

- [ ] The deployed privacy page matches `site/privacy/index.html` and describes browser offline storage.
- [ ] The OAuth callback loads and removes OAuth parameters from the address bar.
- [ ] `THIRD_PARTY_NOTICES.md` matches the lockfile.
- [ ] Private vulnerability reporting is enabled and the link in `SECURITY.md` works.
- [ ] **Disconnect this device** removes only the local credential.
- [ ] Explicit Cloudflare resource deletion removes the remote copy as documented.
