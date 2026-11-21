# Crate server

Run Crate's sync server and reminders PWA on your computer. Requires Node.js
26.8.2+ in the 26.x series. No Cloudflare account or domain is needed.

```sh
npx @kaanbiryol/crate-server
```

In a terminal, setup asks a few questions; Enter accepts each suggestion:

1. How your devices reach this computer: Tailscale Funnel (a permanent address,
   free, no domain), your own domain on Cloudflare, or a temporary Quick Tunnel.
2. Whether Crate starts at login and restarts after a failure. Setup installs the
   package globally for this, then a launchd agent (macOS) or systemd user
   service (Linux).
3. Whether to keep this Mac awake while Crate runs.
4. Where to keep daily verified backups.

It then prints the server address with a QR code and a link. Install the Crate
Obsidian plugin, then scan the code with a phone or open the link on a computer,
and Obsidian connects the vault. You can also paste the address and pairing code
into **Settings → Crate → Connect to your server**. The launcher does not scan or
modify your local Obsidian vault.

```sh
crate-server pair --name "My phone"   # a new QR code and pairing code
crate-server doctor                   # check everything and print a fix for each problem
crate-server update                   # back up, install the newest release, check, restart
crate-server status
crate-server devices
crate-server revoke --id TOKEN_ID
crate-server service --keep-awake     # start at login; service --off stops that
crate-server auto-backup --output /path/to/backups
crate-server --data-dir /path/to/another-vault
```

Without a global install, prefix commands with `npx @kaanbiryol/crate-server`.
The default data directory is `~/.crate/server`; pass the same `--data-dir` to
every command for another one.

Pairing codes expire after ten minutes and can be exchanged once; they never
contain the device token itself. The plugin receives a separate device token and
saves it in Obsidian secret storage. The server stores only its hash.

`update` makes a verified backup, installs the release, and runs its read-only
compatibility check. If the database needs a migration, it runs `upgrade`, which
backs up again before migrating. If a step fails before data changed, it
reinstalls the previous release. Runtime changes, and schema changes without a
registered migration, are rejected.

Connected devices show the server's health in **Settings → Crate → Server**, and
browsers enrolled for reminders get a push notification when an automatic backup
fails, the public address stops working, or the disk is nearly full. These
reports name no paths or vault data.

Remote access is opt-in through setup. Cloudflare or Tailscale terminates public
HTTPS and relays traffic; files, database and alarm state stay on your computer.
Use Crate's optional end-to-end encryption to protect content from the server.
The launcher downloads `cloudflared` from Cloudflare's official GitHub releases,
with SHA-256 verification, to `~/.crate/bin` if needed. Miniflare telemetry is
disabled.

See the [self-hosting guide](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/self-hosting.md)
for Docker, recovery, backups, and updates.

This directory is the package source. Build and pack the distributable from the
repository with `npm run pack:server`; do not publish this source directory.
