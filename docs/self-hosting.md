# Run Crate on your own computer

Crate can run its existing Worker and reminders web app on your Mac using
Miniflare/workerd. Miniflare supplies local D1, R2, and Durable Objects, including
persistent reminder alarms. No Cloudflare account, R2 subscription, or OAuth
client is needed for local operation. Server data stays in your chosen directory.
For access away from home, the default [Quick Tunnel setup](#one-command-remote-setup-without-a-domain)
needs no account or domain. Its HTTPS address changes on restart. A
[named Cloudflare Tunnel](#access-away-from-home-with-cloudflare-tunnel) gives you
a stable address using your own domain. Without a domain,
[Tailscale Funnel](#stable-address-without-a-domain-tailscale-funnel) also gives a
stable address. Phones can use any of these without a VPN.

This initial implementation uses the exact Miniflare version already used by
Crate's integration tests, currently a pinned prerelease. Automated tests cover
real HTTP, disk persistence, transactions, revocation, retry receipts and overdue
alarms across restart. They do not establish production support on every
operating system or verify delivery through real browser push providers.

## Run with Docker

Install and start Docker Desktop on your Mac or Windows computer, or Docker
Engine with the Compose plugin on a Linux host. From this repository, run:

```sh
docker compose up -d --build
docker compose logs -f crate
```

The first command builds the image and starts Crate in the background. Node,
Miniflare, the built Worker/PWA, and a checksum-verified `cloudflared` are included.
You do not need Node or npm installed on the host. The build targets the host's
architecture; the Dockerfile supports Linux ARM64 and AMD64. No image is published
to a registry yet, so this command builds from the checkout.

Logs show **Server address to paste into Obsidian** and a **Pairing code**. Enter
those in **Settings → Crate → Connect to your server**, select **Sync now**, then
use **Copy app link** or **Show QR code** to enroll the PWA. Codes expire after
ten minutes and can be redeemed once. The long-lived device token is returned
directly to Obsidian, not printed in the container's startup logs. Ctrl+C exits
the log viewer while Crate continues running.

Wait for **Ready: the public HTTPS address reaches this Crate server**. Until
then, Crate reports that it is waiting for public access and retries DNS/tunnel
checks. The check verifies this running instance, not just any successful web
response. It continues monitoring and reports loss of public access without
restarting the tunnel or discarding data. A local Docker health check can pass
while public access is still waiting.

No Cloudflare account, domain, router configuration, or separate database
container is needed. The tunnel connects outward; Compose publishes no host
ports. Docker must remain running and the computer must stay awake and online.
On a Mac, enable Docker Desktop's start-at-login setting if desired.

**Quick Tunnel addresses still change when Crate restarts**, including automatic
restarts. Update the address on each Obsidian device under **Server details →
Update server address**, sync, and enroll the PWA again. Existing tokens and
server data remain valid. Sync pending PWA edits before stopping or updating.
Docker does not turn a Quick Tunnel into a permanent public hostname.

### Which server address should I enter?

In **Settings → Crate → Connect to your server → Server address**, enter a
complete URL, including `https://` or `http://`:

| How Crate is running | Address to enter |
| --- | --- |
| Docker with the default Quick Tunnel | The `https://…trycloudflare.com` URL on the **Server address to paste into Obsidian:** log line |
| Directly on this computer, in local-only mode | `http://127.0.0.1:8787`, or the port you selected |
| Behind your own tunnel or HTTPS proxy | Its public HTTPS URL, such as `https://crate.example.com` |

In Docker logs, **Internal listener (diagnostics only): 127.0.0.1:8787** describes the listener *inside the
container*. The default Compose setup does not publish that port to your Mac.
Use the public **Server address to paste into Obsidian:** URL even when Obsidian is on the same Mac.
Entering `127.0.0.1:8787` without a protocol is not a complete server URL.

On a phone, `127.0.0.1` and `localhost` mean the phone itself. Use the server's
HTTPS URL to connect from another device. Enroll the PWA using **Copy app link**
or **Show QR code** after connecting Obsidian.

### Choosing a port or public address

The default Docker tunnel setup chooses a public HTTPS address automatically;
you do not need to choose or forward a port. Its internal port is 8787. Changing
that port does not change the public address. A Quick Tunnel's generated hostname
cannot be selected or reserved. For a stable hostname on your own domain, see
[named Cloudflare Tunnel setup](#access-away-from-home-with-cloudflare-tunnel).

For a server running directly on your computer, choose a local port when starting
it (after completing the local installation and device-token setup below):

```sh
npm run server -- start --local --port 9000
```

Enter `http://127.0.0.1:9000` in Obsidian on that computer. **--local** skips any
saved tunnel setup. If you change an existing connection's address, use **Server
details → Update server address**. The server's **--origin** option declares the
HTTPS URL supplied by a separate proxy; it does not create a hostname or tunnel.

### Storage and lifecycle

The `crate-data` named volume contains `/data/server` (files, database, credentials,
and alarm state) and `/data/server.remote` (tunnel settings). It survives container
replacement and `docker compose down`. Do not use **down --volumes** unless you
intend to delete this server's data. The Compose project name defaults to `crate`;
use the same project name for all commands. A different project creates a
separate volume and vault server.

```sh
docker compose stop                         # stop gracefully; preserve data
docker compose up -d                        # resume existing image and data
docker compose up -d --build                # rebuild after a source update
docker compose ps                          # show status and local health
```

Crate runs as an unprivileged user with a read-only container filesystem and a
writable data volume. A kernel lock prevents two image entrypoints from opening
the same volume. After a process crash, Docker restarts Crate and the entrypoint
clears the abandoned runtime lock while holding that exclusive lease. Data and
schema validation still run before opening the database. Use a dedicated local
Docker volume; do not mount a running `npx` data directory or a network filesystem
here. Do not bypass the entrypoint to run a second server against the volume.

The health check verifies the local application endpoint. It does not verify
internet reachability; an unhealthy status alone does not restart a container.
Process exits use Docker's `unless-stopped` restart policy. Manually stopped
containers stay stopped until you start them again.

To add another device or replace an expired pairing code, keep Crate running:

```sh
docker compose exec crate crate pair --name "My phone"
```


Paste its code and server address into Obsidian's **Connect to your server**
form. No restart is needed, so the current tunnel URL stays unchanged. Only the
local server owner can generate codes: administration uses a private local socket
and secret; the public endpoint can only redeem an issued code. Codes are held in
memory and invalidated by a restart. Existing device tokens remain valid.

### Verified backups, restore, and updates

Stop the server to take a consistent backup. This creates a directory with a
manifest and SHA-256 checksum for every database, file, and remote configuration
file, then verifies the copied bytes. Copy the completed backup outside Docker's
volume so losing the volume does not also lose the backup:

```sh
docker compose stop
docker compose run --rm crate backup --output /data/backups/before-update
docker compose run --rm -T --entrypoint tar crate -C /data/backups -czf - before-update > crate-backup.tgz
docker compose up -d
```

Choose a new backup directory name each time; existing backups are not replaced.
Keep backups private. To restore into a fresh, separately named Docker project,
stop the original server and use an image compatible with the backup:

```sh
docker compose stop
docker compose -p crate-restored run --rm -T --entrypoint tar crate -C /data -xzf - < crate-backup.tgz
docker compose -p crate-restored run --rm crate restore --backup /data/before-update
docker compose -p crate-restored up -d
```

Restore refuses non-empty destinations, modified backup files, unsupported
schemas/runtimes, and downgrades. It validates the restored database with reminder
alarms disabled before completing. It preserves device credentials, files, and
Durable Object alarms. Keep the old server stopped; connect to the restored
server's new public address. Use `-p crate-restored` for subsequent commands on
that installation.

Before an upgrade, create the verified backup above, stop the server, retain the
current image, build the update, and run a read-only compatibility check:

```sh
docker compose stop
docker image tag crate-server:local crate-server:before-update
docker compose build
docker compose run --rm crate check-upgrade
docker compose up -d
```

Only start the new image if the check succeeds. If it rejects the upgrade,
retag `crate-server:before-update` as `crate-server:local` and resume the previous
image. The check has not changed the data. Updates with the same storage runtime
and schema can advance the server revision. If the check reports that the
database needs a migration, run
`docker compose run --rm crate upgrade --output /data/backups/before-migration`
before starting. It creates a verified backup, then applies the registered
migrations. A changed runtime, or a schema change without a registered migration
from the data's schema version, is rejected. After a successful
upgrade has written newer data, rollback requires the previous image and its
pre-upgrade backup; do not bypass version checks.

## Start directly on your Mac

Use Node.js 26.8.2 or a compatible 26.x release and npm. From this repository:

For remote access to the PWA, use `npm ci` followed by
`npm run server -- setup`. The [Quick Tunnel setup](#one-command-remote-setup-without-a-domain)
below creates a temporary HTTPS address. For local-only operation:

```sh
npm ci
npm run build
npm run server -- add-device --name "My Mac"
npm run server -- start
```

The first command that opens the server initializes an empty database.
**add-device** prints a new access token once; copy it privately. Only its SHA-256
hash is stored in the database. Each device needs its own token.

Install this build's `dist/main.js`, `dist/styles.css`, and `manifest.json` in
your vault's `.obsidian/plugins/crate/` directory and reload Obsidian. Then:

1. Open **Settings → Crate → Connect to your server**.
2. Set **Server address** to `http://localhost:8787`.
3. Paste the generated token into **Pairing code or access token** and select **Connect**.
4. Select **Sync now** for the first sync. Normal automatic sync settings apply
   after connection.

Disconnect an existing connection first. For a remembered Cloudflare server,
select **Forget saved connection** before connecting locally. This preserves
Cloudflare resources and local files. It does not migrate remote history,
browser sessions, or unsynced changes from other devices.

The plugin verifies compatibility and vault access before saving the token in
Obsidian secret storage. Open the reminders web app link from Crate's reminder
settings after connecting. Visiting `/notifications` alone does not grant access;
the existing folder-bound browser enrollment flow remains in use.

## Data and additional devices

The default directory is `~/.crate/server`, outside the repository and vault.
It contains databases, file bytes and history, Durable Object state, VAPID keys,
and `server.json` compatibility metadata. One directory represents one shared
vault. To choose another location, pass the same **--data-dir** to every command:

```sh
npm run server -- add-device --name "My phone" --data-dir /path/to/crate-data
npm run server -- start --data-dir /path/to/crate-data
```

Stop the server with **Ctrl+C** before issuing another token, then restart it.
Existing devices keep their credentials. Administrative commands do not run
reminder alarms. An exclusive directory lock prevents multiple server or
administration processes from opening the same data simultaneously.

Connected devices can revoke other devices through **Account and devices →
Devices and sessions**. **Disconnect this device** attempts revocation and removes
the local credential. If the server was unreachable, revoke that credential from
another connected device later. Generate a new token to reconnect.

The server computer can also list and revoke credentials itself, for example when
a lost phone was your only connected device. Both commands work while the server
runs or while it is stopped:

```sh
npm run server -- devices
npm run server -- revoke --id TOKEN_ID
```

With Docker, use `docker compose exec crate crate devices` and
`docker compose exec crate crate revoke --id TOKEN_ID`. Revoking a device also
removes its push subscriptions and the Reading shortcut credentials it issued.

When this plugin bundles a newer server than the one you run, Crate settings show
**Server update available**. Update the server on its computer as described in
[Backups, restore, and updates](#backups-restore-and-updates).

## Access from another device

`localhost` means the device you are using. A phone needs an address that reaches
the server computer, with a certificate the phone trusts. Put an HTTPS reverse
proxy in front of the server and set its public origin:

```sh
npm run server -- start --origin https://crate.example.com
```

Configure the proxy to forward that hostname to `http://127.0.0.1:8787`. Forward
all paths, methods, request bodies and response headers; allow at least 25 MiB
uploads and two-minute requests. Do not cache authenticated API responses. Use
`https://crate.example.com` in each device's **Server address**. That origin also
serves the PWA.

The default listener is loopback only. If the proxy runs elsewhere,
**--host 0.0.0.0** enables network listening and requires an explicit HTTPS
**--origin**. Restrict the HTTP port to your trusted proxy. Clients use HTTPS.
Only application requests are exposed; Miniflare's development endpoints remain
private. Client-supplied Cloudflare and forwarding headers are stripped. Proxy
clients share the proxy connection's IP-based request budget; configure any
additional per-client limits at the proxy.

Away from home, use the tunnel setup below or another reachable HTTPS proxy.
The hosting computer must remain awake for sync and
timely notification dispatch. Browser push requires internet access to browser
push providers. After the host resumes, persisted alarms follow Crate's existing
retry and expiry rules; overdue delivery is not guaranteed.

Other computers need Node and workerd binaries supported by the pinned versions.
Linux, Windows, physical mobile clients, HTTPS deployment and automatic startup
services need separate acceptance checks. To start Crate at login or boot, see
[Start Crate automatically](#start-crate-automatically).

## One-command remote setup without a domain

From the repository, run `npm ci` once, then:

```sh
npm run server -- setup
```

Setup builds the server, initializes an empty database or validates existing
data, installs a verified official `cloudflared` release if it is not on PATH,
and starts a Quick Tunnel. It prints the public HTTPS address and, for a fresh
server, a single-use pairing code. Connect in **Settings → Crate → Connect to your
server**, then select **Sync now**. The Obsidian plugin must be installed
separately. The command does not access an Obsidian vault on its own.

No Cloudflare account, domain, Homebrew, or administrator access is needed for
this flow. Node.js and npm must already be installed. Automatic binary downloads
support macOS and Linux on x64/arm64, and Windows x64; the runtime still needs
separate platform acceptance checks. Downloads use a pinned Cloudflare GitHub
release and SHA-256 checksums, and are cached under `~/.crate/bin`.

Keep the terminal open and the computer awake. **Ctrl+C** stops the tunnel and
server. Run `npm run server -- start` to resume. Configuration beside the data
directory remembers Quick Tunnel mode; data and device credentials persist.
**Every new tunnel has a new public address.** On connected Obsidian devices,
use **Server details → Update server address**, then sync again. This verifies
the existing token, backs up and resets checkpoints scoped to the old address,
and performs normal reconciliation on the next sync.

The installed PWA cannot automatically follow a new origin. Sync pending browser
changes before stopping the tunnel, then use a fresh **Copy app link** or
**Show QR code** to enroll the PWA again after restarting. Unsynced browser data
does not move to the new origin. For ongoing daily use with an installed PWA,
use a stable HTTPS endpoint. Cloudflare describes
[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
as testing/development infrastructure with no uptime guarantee.

### Standalone npx package

The distributable includes the built Worker and a locked storage runtime, so
end users do not need the repository or a build toolchain. To build and test it:

```sh
npm run pack:server
npx ./dist/kaanbiryol-crate-server-0.1.0.tgz
```

Once published, users run `npx @kaanbiryol/crate-server`. Maintainers publish
it with `npm run publish:server`; see [releases](releases.md#publish-the-server-package).
Subsequent runs reuse `~/.crate/server` by default.
Pass **--data-dir** to keep multiple vault servers separate. Run
`npx ./dist/kaanbiryol-crate-server-0.1.0.tgz pair --name "My phone"`
while running to issue another pairing code without restarting.

Package source and its dependency shrinkwrap live in `packages/server`.
`npm run build:server` stages only runtime scripts, built assets, licensing, and
package metadata in `dist/server`; publish that staged package, not the source
directory. It includes the installed Miniflare JavaScript distribution and its
license, with explicit runtime dependencies to preserve the repository's sharp
version override. Native binaries are installed for the user's platform.
`npm run test:server-package` packs it, installs it through npx in an
isolated cache, and tests startup and restart without repository files.

## Stable address without a domain: Tailscale Funnel

Tailscale Funnel gives this computer a permanent public HTTPS address such as
`https://my-mac.tail1234.ts.net`. It survives restarts, so the PWA and connected
devices keep working. You need a free Tailscale account and the Tailscale app on
the server computer only. Phones and other devices do not need Tailscale.

1. Install [Tailscale](https://tailscale.com/download) on the server computer and sign in.
2. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**
   under **DNS**.
3. From the repository, after `npm ci`, run:

```sh
npm run server -- setup --tailscale
```

Setup reads this computer's Tailscale name, saves it, starts Crate and runs Funnel
alongside it. The first time, Tailscale prints a link to approve Funnel for your
tailnet; open it and approve. A new public name can take up to 10 minutes to
resolve. Then connect Obsidian with the printed address and pairing code. Later,
`npm run server -- start` reuses the saved address. **Ctrl+C** stops Crate and
takes the public address offline until the next start.

The address is tied to this computer's name in Tailscale. Renaming the computer
changes the address, so Crate refuses to start until you rename it back. On Linux,
Funnel needs permission for your user once: `sudo tailscale set --operator=$USER`.

### Tailscale Funnel with Docker

Docker runs Tailscale in its own container next to Crate, so the host computer
does not need Tailscale installed. The address becomes
`https://crate.<your-tailnet>.ts.net`; set `CRATE_TAILSCALE_HOSTNAME` to use
another name than `crate`.

1. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**.
2. Allow Funnel in your tailnet policy file. Running `tailscale funnel` once on any
   device offers to add it for you; otherwise add:

```json
"nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
```

3. Start both containers:

```sh
docker compose -f compose.yaml -f compose.tailscale.yaml up -d --build
docker compose -f compose.yaml -f compose.tailscale.yaml logs -f crate
```

The Crate log prints a Tailscale sign-in link the first time; open it to add the
container to your tailnet. To sign in without the link, set `TS_AUTHKEY` to an
auth key from the admin console when starting. Tailscale keeps its sign-in in the
`tailscale-state` volume, so later starts need neither. Crate then prints the
address and pairing code as usual. Pass both `-f` files to every
`docker compose` command for this setup, including `exec crate crate pair`.

Tailscale terminates HTTPS on this computer and relays traffic without decrypting
it. Funnel has bandwidth limits that Tailscale does not publish; very large
uploads have not been verified through it. See Tailscale's
[Funnel documentation](https://tailscale.com/kb/1223/funnel) for requirements.

## Access away from home with Cloudflare Tunnel

Run `cloudflared` alongside Crate on the host computer. It connects outward to
Cloudflare, which forwards requests for your hostname to the local server.
No router port forwarding or VPN app on the phone is needed. The route is:

```text
Phone / Obsidian → https://crate.example.com → Cloudflare Tunnel → Crate on your Mac
```

The database, files, and alarm state remain on the Mac. Cloudflare terminates
public HTTPS and handles traffic passing through the tunnel. Optional
[end-to-end encryption](e2ee-implementation.md) protects content before it reaches
the tunnel or the local server; file and folder names are encrypted, while folder structure and scheduling metadata remain visible. Remote access is optional: only the explicit
**setup** command provisions a tunnel. Ordinary local startup does not.

### One-time setup

After `npm ci`, run:

```sh
npm run server -- setup --hostname crate.example.com
```

Use an unused hostname on a domain already managed by your Cloudflare account.
Complete Cloudflare's browser login when prompted;
on a headless server, open the printed login URL on another device. Domain
registration and moving the domain to Cloudflare remain prerequisites.

Setup builds the Worker, initializes or validates local storage, installs
`cloudflared` through Homebrew on macOS if needed, creates a named tunnel and
its DNS route, and starts Crate with the tunnel. On other systems, install
`cloudflared` using the [official packages](https://developers.cloudflare.com/tunnel/downloads/)
first. Existing credentials and storage are preserved. A fresh server prints
its first single-use pairing code, valid for ten minutes, ready to paste into Obsidian.

You can supply the hostname, first device name, and local port directly:

```sh
npm run server -- setup --hostname crate.example.com --name "My Mac" --port 8787
```

Use the same **--data-dir** on setup and subsequent commands if you selected a
custom data directory. Setup requires the server to be stopped. Repeating it
resumes incomplete provisioning and reuses the saved tunnel. DNS conflicts stop
setup; it never overwrites an existing DNS record. Choose an unused hostname
before starting, or resolve the conflicting record yourself before retrying.

This wraps Cloudflare's [locally managed tunnel workflow](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/).
Cloudflare login stores its account-management certificate in
`~/.cloudflared/cert.pem`. Crate saves its separate tunnel credential, ingress
configuration, hostname, and port in `~/.crate/server.remote` (or
`<data-dir>.remote`). Keep that directory private and back it up separately.
Normal launches use the tunnel credential and do not need another browser login.

### Run and connect

After setup, launch both processes with:

```sh
npm run server -- start
```

The saved hostname and port are reused. The HTTP listener stays on loopback;
only the configured hostname reaches Crate through the tunnel. Press **Ctrl+C**
to stop both processes. If the tunnel process exits unexpectedly, the launcher
stops Crate and reports the failure. `cloudflared` handles temporary network
reconnections. Initial DNS and HTTPS certificate propagation can take a few
minutes; a running process alone does not prove remote reachability.

The command runs in the foreground; to start it after a reboot, see
[Start Crate automatically](#start-crate-automatically). `npm run server -- start --local` skips the saved tunnel
for local troubleshooting. For an independently managed tunnel or HTTPS proxy,
use `start --local --origin https://crate.example.com` and manage that proxy
yourself. Do not run both tunnel workflows for the same hostname.

Existing Cloudflare cache overrides, Access login pages, or browser challenges
can interfere with the API. Keep authenticated responses uncached and allow
Crate clients to authenticate using their own tokens. The setup command does
not change your domain's existing security or caching rules.

Use `https://crate.example.com` as **Server address** when connecting Obsidian,
including on the host Mac. Then select **Copy app link** or **Show QR code** in
**Reminders web app** to enroll the phone. Those links use the configured server
address and open `/notifications` with a short-lived enrollment grant. People
with only the public hostname do not gain access to reminders or vault files.

If you already connected using `localhost`, sync pending changes first, disconnect,
and connect again with the HTTPS address and a new device token. Re-enroll any
existing PWA installation at the HTTPS address. Keep this hostname stable:
browser storage, installed apps, and push subscriptions belong to that origin.
Random Quick Tunnel addresses are for temporary testing, not a persistent Crate
installation.

To check remote access, turn off Wi-Fi on the phone, open a fresh enrollment
link over cellular, and verify that reminder changes sync back to Obsidian.
Check notification permission and delivery separately with the Mac awake.
The automated local-server tests do not verify a live Cloudflare tunnel or
physical-device push delivery.

If setup is interrupted before saving a tunnel credential, Cloudflare may have
created a tunnel without completing local setup. Retrying uses the saved tunnel
name and fails on a conflict instead of creating another one. Inspect that named
tunnel in Cloudflare and recover its credentials or remove the unused tunnel
before retrying. A missing credential for a saved tunnel stops startup; restore
the remote directory from backup. Stopping the launcher does not delete the DNS
record or tunnel.

## Start Crate automatically

`start` runs in the foreground, so closing the terminal, logging out or rebooting
stops Crate. A service manager can start it for you and restart it if it stops.
Docker users already have this: Compose restarts Crate, and Docker Desktop can
start at login.

First run `setup` once in a terminal, since the first Cloudflare login or Funnel
approval needs you. Then install Crate somewhere a background service can read.
On a Mac, macOS blocks background services from reading **Documents**, **Desktop**
and **Downloads** without a permission prompt, so do not point the service at a
checkout in those folders. Installing the package globally avoids that:

```sh
npm install -g @kaanbiryol/crate-server
node -p process.execPath
echo "$(npm root -g)/@kaanbiryol/crate-server/scripts/crate-server.mjs"
```

The last two commands print the absolute Node and Crate paths for the files
below. Use those exact paths: version managers put shims on `PATH` that a service
cannot use. After upgrading Node, update the Node path and restart the service.

A Quick Tunnel gets a new address on each restart, so use a service with a
[named tunnel](#access-away-from-home-with-cloudflare-tunnel) or
[Tailscale Funnel](#stable-address-without-a-domain-tailscale-funnel). The
saved setup is reused, and `crate-server pair` still works while the service runs.

### macOS (launchd)

Save this as `~/Library/LaunchAgents/local.crate.server.plist`, replacing the
paths and `you` with your own:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>local.crate.server</string>
	<key>ProgramArguments</key>
	<array>
		<string>/path/to/node</string>
		<string>/path/to/crate-server.mjs</string>
		<string>start</string>
		<string>--data-dir</string>
		<string>/Users/you/.crate/server</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>StandardOutPath</key>
	<string>/Users/you/Library/Logs/crate-server.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/you/Library/Logs/crate-server.log</string>
</dict>
</plist>
```

`PATH` lets Crate find `cloudflared` or `tailscale`. Then load it, and check the log:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.crate.server.plist
tail -f ~/Library/Logs/crate-server.log
```

Crate now starts when you log in and restarts 30 seconds after it stops with an
error, such as a tunnel that exited. Stop it with
`launchctl bootout gui/$(id -u)/local.crate.server`, which shuts it down cleanly.
A launch agent runs only while you are logged in. Under **System Settings →
Energy** (or **Battery**), keep the Mac from sleeping while it serves devices.
The log can contain a first pairing code; keep it private.

### Linux (systemd)

Save this as `~/.config/systemd/user/crate.service`, replacing the paths:

```ini
[Unit]
Description=Crate server

[Service]
ExecStart=/path/to/node /path/to/crate-server.mjs start --data-dir /home/you/.crate/server
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=30
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Enable it, keep it running after you log out, and follow its log:

```sh
systemctl --user daemon-reload
systemctl --user enable --now crate
sudo loginctl enable-linger "$USER"
journalctl --user -u crate -f
```

`systemctl --user stop crate` shuts Crate down cleanly. If the network or
Tailscale is not ready at boot, Crate exits and systemd retries it 30 seconds later.

### After a crash or power loss

A lock file stops two servers from using the same data. After a reboot, Crate
replaces a lock left by the previous boot on its own. If Crate was force-quit
without a reboot, the lock stays: check that no Crate or workerd process is
running, then remove `server.lock` from the data directory and start again.

## Backups, restore, and updates

For a source installation, stop the server and use the verified backup commands:

```sh
npm run server -- backup --data-dir /path/to/crate-data --output /path/to/crate-backup
npm run server -- restore --backup /path/to/crate-backup --data-dir /path/to/empty-restored-data
```

The backup includes the local database, objects, alarms, and any adjacent named-tunnel configuration. Restore checks file hashes and compatibility before publishing the restored data. Use a new backup destination each time.

You can also stop the server cleanly and copy the **entire data directory** and its adjacent `.remote` directory to make a cold backup.
Keep its matching repository commit, lockfile and Node version. Backups contain
vault contents and credentials. D1, R2 and Durable Object state belong together;
do not copy just one of them or edit live SQLite files.

To restore, stop clients, preserve the current directory, and copy the complete
backup into a separate directory. Start the matching installation with that
**--data-dir**. Review local edits and pending browser writes before reconnecting.
Never run independent restored copies behind the same address. Cloudflare
recovery scripts manage Cloudflare resources; use a cold directory backup here.

To update, stop the server, make a complete backup, update the source, run
`npm ci` and `npm run build:worker`, then run `npm run server -- check-upgrade --data-dir /path/to/crate-data`. Start with the same directory and origin only if that check succeeds.
If the check reports that the database needs a migration, first run
`npm run server -- upgrade --data-dir /path/to/crate-data --output /path/to/new-backup`.
It creates a verified backup, then applies the registered migrations in order.
The launcher rejects older server revisions and different Miniflare versions.
Normal startup rejects a different schema hash; only **upgrade** accepts one, and
only with a registered migration from the data's recorded schema version. Do not edit `server.json` to bypass
checks. Restore the matching installation when an upgrade is rejected. Stale
generated Worker bundles are also rejected; rebuilding does not reset data.
Missing database files or missing/corrupt `server.json` stop startup instead of
silently creating a replacement server. Restore a complete backup. If the very
first initialization failed before any device connected, use a new empty
directory and retain the incomplete one for diagnosis.

After a crash, `server.lock` may remain. Verify that no Crate or workerd process
uses the directory before removing only that lock file and restarting. The
launcher does not guess whether another process is safe to interrupt.

## Verification

```sh
npm run test:local-server
```

Tests use temporary directories, never `~/.crate/server` or Cloudflare data.
Re-run them when changing Miniflare, startup or persistence layout.
