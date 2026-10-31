# Device pairing (proposal)

Status: draft design, not implemented.

Today a second Obsidian device repeats the whole Cloudflare setup: **Connect with Cloudflare**, browser sign-in, Worker selection and, in an encrypted vault, typing the recovery key ([connecting another device](deployment.md#connecting-another-device)). This proposal lets a connected desktop add a device with one QR scan and, for an encrypted vault, one code comparison.

## Goals

- A phone with Crate installed in an empty vault connects without Cloudflare sign-in, Worker selection or the recovery key.
- The phone never receives Cloudflare account credentials. It holds only a revocable vault device token.
- Nothing that can leak after use (QR photo, screenshot, link history) grants access.
- Keep the existing invariant that vault enrollment is authorized through Cloudflare, not by another device token ([Worker API](worker-api.md#endpoints)).

## Non-goals

- Creating the phone vault or installing the plugin. Obsidian offers no API for either, so the user still creates an empty vault, turns on community plugins and installs Crate.
- Self-hosted servers in the first version. They already have `crate pair`; see [later work](#later-work).
- Replacing **Connect with Cloudflare**. It stays as the fallback when no unlocked desktop is available.

## User flow

1. Desktop: **Settings → Crate → Configuration → Add a device**. Crate shows a QR code, the same link as text with **Copy link**, and a ten-minute countdown.
2. Phone: scan the QR code with the camera. It opens a small page on the Worker that says "Open in Obsidian" and, if Crate is not installed yet, lists the setup steps. Selecting **Open in Obsidian** hands the code to the plugin.
3. Phone: Crate confirms "Connect this vault to `<server>`?" and the user selects **Connect**. The plugin redeems the code, saves the connection and starts the first sync.
4. Encrypted vault only: both screens move straight to the existing key approval. The user compares the three codes, selects **Approve** on desktop and **Confirm and unlock** on the phone.
5. Desktop shows "Connected: `<device name>`" and closes the dialog.

The phone can also paste the copied link into a **Paste pairing link** field in Crate settings, for cameras that do not open links or when the QR cannot be scanned.

## Design

### 1. Issuing a code (desktop, Cloudflare API)

The desktop issues the code through its saved Cloudflare login, the same path **Update server** uses (`withAuthorization` in `cloudflare/deployment/service.ts`). If the login is missing or cannot be renewed, Cloudflare authorization opens on the desktop, which is easier than on a phone.

- Generate a 256-bit code with `createRandomHexToken()`.
- Insert its SHA-256 hash with `queryD1`, next to `registerCloudflareAuthorizedDevice` in `cloudflare/deployment/device-registration.ts`:
  `INSERT INTO reading_enrollments(token_hash, generation, scope, expires_at) VALUES (?, ?, 'vault_device', ?)`
  with a ten-minute expiry and the server's current reset generation.
- Delete any earlier unredeemed `vault_device` row first, so at most one code is live.

`reading_enrollments` is reused because it already holds hashed one-use codes with an expiry, maintenance prunes expired rows (`maintenance/operation-receipts.ts`), and an encryption reset clears it (`encryption/reset.ts`). This needs no schema change; the `auth_tokens.scope` CHECK constraint rules out storing pending codes there. The table name no longer matches its contents; renaming it waits for the next schema version.

Because only the Cloudflare account owner can write D1 through the Cloudflare API, a stolen vault device token still cannot mint other device tokens.

### 2. The QR link

The QR code encodes `https://<worker>/pair#<code>`. The code is in the fragment, so it is never sent to the Worker by the browser or recorded in its request logs.

`GET /pair` is a static, no-store page served with the PWA assets. Its script reads the fragment and builds `obsidian://crate-pair?server=<origin>&code=<code>`. The page shows **Open in Obsidian** and short setup steps for a phone without Crate. It makes no API calls.

The QR is rendered with `qrcode-generator`, which is already a dependency.

### 3. Redeeming a code (phone, Worker)

The plugin registers `crate-pair` with `registerObsidianProtocolHandler`, like `crate-cloudflare-oauth` in `plugin/lifecycle.ts`. The handler validates the origin (HTTPS, or a local development host), asks for confirmation, then calls a new public route:

`POST /auth/device-pairing/exchange { code, tokenHash, deviceId, deviceName, platform }`

- The phone generates its token locally with `generateSecureToken()` and sends only its hash, as Cloudflare registration does today. The raw token never crosses the network during pairing.
- One D1 batch inserts the `vault` token only if a matching `vault_device` row exists, has not expired and carries the current reset generation, then deletes that row. The insert uses `INSERT ... SELECT ... WHERE EXISTS`, like `exchangeShortcutPairing`, so concurrent redemptions create at most one token.
- If a vault token with the same `deviceId` exists (the phone is re-pairing), the batch replaces its hash instead of adding a row, matching `registerCloudflareAuthorizedDevice`.
- Lost response: the phone retries with the same `tokenHash`. When the code is gone but a vault token with that `tokenHash` and `deviceId` exists, the route returns success. Knowing a hash grants nothing, so this is safe and keeps the retry guarantee.
- Failures return 410 "This pairing code expired or was already used. Create a new one on your desktop." The route is added to the unauthenticated rate-limited actions in `worker/rate-limit.ts`, so it gets the per-IP budget, and responds with `Cache-Control: no-store`.

The phone then saves `{ workerUrl, authToken }` through `configureCloudflareAuthorizedDevice`, which reads shared settings and runs the connection test as today. It stores no Cloudflare login or deployment metadata. Server changes already run only on desktop ([deployment](deployment.md#oauth-connection-and-deployment)), so the phone needs no account credentials.

### 4. Encrypted vaults (reuse `web-pairing-v1`)

The phone is now a vault device without keys. Key transfer reuses the [app approval protocol](e2ee-implementation.md#app-approval-protocol) unchanged: commitment, ECDH P-256, three comparison groups, both confirmations.

Worker change: allow a `vault` credential to `start` a request, and require that `accept` and `approve` come from a different token than the requester. Today vault devices cannot start requests.

Plugin changes:

- The phone shows the requester side in a modal. `pwa/connection/AppPairing.tsx` and `encryption/pairing/session.ts` already implement it for the PWA; the component moves to shared UI so the plugin can render it.
- The desktop's **Add a device** dialog polls `GET /encryption/pairing` while open and moves into the existing approval modal (`ui/settings/web-app-pairing-modal.ts`) when the new device's request appears.
- The phone stores the keys through the same path as recovery-key unlock, then starts syncing.

The QR could carry a second secret to authenticate the ECDH exchange and skip the comparison. That would be a new cryptographic protocol, while the desktop is already in front of the user, so this proposal keeps the human comparison.

### 5. Capability and versions

The Worker advertises `device-pairing-v1` in `/.well-known/crate` once both route changes ship. This is a server revision bump ([server upgrades](server-upgrades.md)). The desktop shows **Add a device** only when the capability is present and otherwise says "Update your server to add devices from here." An older phone plugin cannot handle `crate-pair`; the `/pair` page tells the user to update Crate.

## Security review points

| Risk | Mitigation |
| --- | --- |
| QR photographed or shared | One use, ten minutes, only one live code; the link alone never unlocks encrypted data |
| Code guessed | 256 bits, per-IP limit, generic 410 |
| Stolen device token mints more tokens | Codes are issued only through the Cloudflare API |
| Malicious relay substitutes keys | Unchanged human comparison of three codes |
| Server reset while a code is live | Reset clears `reading_enrollments`; the generation check rejects the rest |
| Cross-use with Reading codes | Exchanges match `scope` exactly; tests cover both directions |

Docs to update on implementation: [Worker API](worker-api.md) (the enrollment invariant and the new route), [deployment](deployment.md#connecting-another-device), [encryption](e2ee-implementation.md), [privacy](privacy.md) and the user guide.

## Tests

- Worker integration against D1: redemption creates one token; concurrent redemptions; expiry; replay; lost-response retry; re-pairing replaces the device's token; a reset invalidates live codes; a `vault_device` code fails Shortcut exchange and a Shortcut code fails device exchange; rate limit.
- Worker integration for `/encryption/pairing`: a vault requester succeeds; self-approval is rejected; existing app pairing behavior is unchanged.
- Unit: code issuance SQL through a mocked `queryD1`; `crate-pair` handler validation and confirmation; desktop dialog capability gating.
- Browser: the `/pair` page builds the Obsidian link from the fragment and makes no requests.
- Physical devices: scanning on iPhone and Android opens Obsidian; a full encrypted pairing between desktop and phone.

## Later work

- Self-hosted: the gateway can issue codes for a connected desktop through an authenticated plugin request, or `crate pair --qr` can print the same link.
- Show recent pairings in the device list with a **Revoke** action. The existing token list already covers revocation.

## Decisions

- A paired phone gets no Cloudflare login. Account credentials can change every Worker and database in the account, and phones are lost more often than desktops. Server changes run only on desktop for every device, since phones can suspend Obsidian partway through a long operation.
- Codes expire after ten minutes. Closing the desktop dialog does not delete the code, which avoids another Cloudflare API call; issuing a new code replaces the old one.
