# Crate server

Run Crate's sync server and reminders PWA on your computer. Requires Node.js
26.8.2+ in the 26.x series. No Cloudflare account or domain is needed for the
default Quick Tunnel mode.

```sh
npx @kaanbiryol/crate-server
```

The package includes the built server. On first launch it initializes persistent
storage, uses an existing `cloudflared` or downloads a pinned official release
with SHA-256 verification, starts a Cloudflare Quick Tunnel, and prints the HTTPS
address and your first single-use pairing code. No administrator privileges are needed for
the downloaded binary. Install the Crate Obsidian plugin separately, enter the
address and pairing code in **Settings → Crate → Connect to your server**, then select
**Sync now**. The launcher does not scan or modify your local Obsidian vault.

Keep the terminal open and the computer awake. Ctrl+C stops the server and tunnel.
Run the same command again to resume with the same local data.

**The public address changes when the tunnel restarts.** Existing device tokens
remain valid. On each connected Obsidian device, use **Settings → Crate → Server details → Update server address**.
Use a fresh **Copy app link** or **Show QR code** to enroll the PWA at the new
address. Browser storage and push subscriptions belong to each address. Sync
pending PWA changes before stopping a tunnel. Quick Tunnels are intended for
testing and development and have no uptime guarantee.

The default data directory is `~/.crate/server`. Stop the server before copying
the entire directory for backup or updating
the package. Runtime/schema compatibility is checked before opening stored data.

```sh
npx @kaanbiryol/crate-server pair --name "My phone"
npx @kaanbiryol/crate-server --data-dir /path/to/another-vault
```

Use the pair command while the server is running. Pairing codes expire after ten
minutes and can be exchanged once; they never contain the device token itself.
The plugin receives a separate device token and saves it in Obsidian secret
storage. The server stores only its hash. Long-lived tokens are not printed by
normal startup. An expired or lost code can be replaced with the pair command.

The launcher reports public access as ready only after an HTTPS probe reaches
this running instance. It keeps retrying while DNS or the tunnel is unavailable.

Use backup --output PATH while stopped to create a checksum-verified backup.
Use restore --backup PATH --data-dir EMPTY_PATH to validate and restore it, and
check-upgrade to check compatibility without changing stored data. Runtime or
schema changes require a tested migration; they are rejected until supported.

Running the command opts into remote access through Cloudflare. Cloudflare
terminates public HTTPS and handles traffic through the tunnel. Files, database,
and alarm state remain on your computer. Crate does not end-to-end encrypt vault
contents. The launcher downloads its tunnel binary from Cloudflare's official
GitHub releases to `~/.crate/bin` if needed. Miniflare telemetry is disabled.

For a permanent address, use a new data directory with
`setup --hostname crate.example.com` and a domain you control in Cloudflare, or
run `start --local --origin https://your-address` with your own HTTPS proxy.

See the repository's [self-hosting guide](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/self-hosting.md)
for installation, recovery, backups, and updates.

This directory is the package source. Build and pack the distributable from the
repository with `npm run pack:server`; do not publish this source directory.
