// The CLI entry: parses arguments, turns signals into an abort, runs one command and
// closes what it opened, in order, even after a failure. Commands live in commands/.
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { tailscaleSocket } from './local-server-tailscale.mjs';
import { closeLocalServerResources } from './local-server-lifecycle.mjs';
import { validateCommandOptions } from './local-server-options.mjs';
import { autoBackup, backup, checkUpgrade, restore, upgrade } from './commands/data.mjs';
import { addDevice, listDevices, pair, revoke } from './commands/devices.mjs';
import { start } from './commands/start.mjs';
import { status } from './commands/status.mjs';
import { service } from './commands/service.mjs';
import { update } from './commands/update.mjs';
import { doctor } from './commands/doctor.mjs';

const help = `Crate local server

npm run server -- setup [--data-dir PATH] [--name "My Mac"]
npm run server -- setup --hostname crate.example.com [--data-dir PATH] [--port 8787]
npm run server -- setup --tailscale [--data-dir PATH] [--port 8787]
npm run server -- start [--data-dir PATH]
npm run server -- start --local [--port 8787] [--host 127.0.0.1] [--origin https://crate.example.com]
npm run server -- add-device --name "My Mac" [--data-dir PATH]
npm run server -- pair --name "My phone" [--data-dir PATH]
npm run server -- devices [--data-dir PATH]
npm run server -- revoke --id TOKEN_ID [--data-dir PATH]
npm run server -- status [--data-dir PATH]
npm run server -- backup --output PATH [--data-dir PATH]
npm run server -- auto-backup --output DIR [--keep 7] [--data-dir PATH]
npm run server -- auto-backup --off [--data-dir PATH]
npm run server -- upgrade --output NEW_BACKUP_PATH [--data-dir PATH]
npm run server -- upgrade --backup LATEST_BACKUP_PATH [--data-dir PATH]
npm run server -- restore --backup PATH --data-dir EMPTY_PATH
npm run server -- check-upgrade [--data-dir PATH]
npm run server -- service [--keep-awake] [--max-file-size MB] [--data-dir PATH]
npm run server -- service --off
npm run server -- update [--data-dir PATH]
npm run server -- doctor [--data-dir PATH]

Setup defaults to a Quick Tunnel: no account or domain. It initializes storage,
installs cloudflared if missing, and prints your address and first pairing code.
Quick Tunnel addresses change on restart; reconnect devices and re-enroll PWAs.
--hostname selects a permanent named tunnel and requires a Cloudflare domain.
--tailscale uses Tailscale Funnel for a permanent address without a domain.
Start reuses saved remote settings; --local skips the managed tunnel.
Without remote setup, start uses localhost (build first: npm run build:worker).
Use pair while the server is running to connect another device without downtime.
devices, revoke, status, backup and auto-backup work while the server runs or while it
is stopped. A running server pauses sync for a moment while backup copies its database.
auto-backup makes a verified backup every day while the server runs and keeps the newest.
service starts Crate at login (launchd on macOS, systemd on Linux) and restarts it after a failure.
--keep-awake keeps a Mac from idle sleep while Crate runs.
--max-file-size MB (start, setup, service; CRATE_MAX_FILE_SIZE_MB in Docker) syncs files up to
that size, from 25 (the default) to 1024. Above 25, every device needs the current Crate plugin
and mobile devices still skip files over 25 MB. Encrypted vaults and Markdown notes stay at 128 MB.
update installs the newest release after a verified backup and rolls back if it fails;
other installs print their own update steps. doctor checks the server and prints a fix for each problem.
Stop the server before offline add-device administration.
Default data directory: ~/.crate/server (one vault per directory).
See docs/self-hosting.md for backups, updates, and other HTTPS proxies.`;

/** @type {Record<string, import('./local-server-options.mjs').Command>} */
const commands = {
	setup: start, start, 'add-device': addDevice, pair, devices: listDevices, revoke, status,
	backup, 'auto-backup': autoBackup, upgrade, restore, 'check-upgrade': checkUpgrade, service, update, doctor,
};

const shutdown = new AbortController();
const stopped = new Promise(resolve => shutdown.signal.addEventListener('abort', resolve, { once: true }));
const onSignal = () => shutdown.abort();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, onSignal);
const docker = process.env.CRATE_DOCKER === '1';
/** @type {import('./local-server-lifecycle.mjs').CommandResources} */
const resources = {};

try {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		'data-dir': { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, origin: { type: 'string' },
		output: { type: 'string' }, backup: { type: 'string' }, keep: { type: 'string' }, off: { type: 'boolean' },
		hostname: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, local: { type: 'boolean' }, 'keep-awake': { type: 'boolean' }, 'max-file-size': { type: 'string' }, quick: { type: 'boolean' }, tailscale: { type: 'boolean' }, help: { type: 'boolean' }, json: { type: 'boolean' },
	} });
	const command = positionals[0];
	if (values.help || !command) console.log(help);
	else {
		validateCommandOptions(positionals, values, { dockerWithoutTailscale: () => docker && !tailscaleSocket() });
		process.umask(0o077);
		const dataDir = resolve(values['data-dir'] ?? join(homedir(), '.crate', 'server'));
		await commands[command]({ command, values, dataDir, docker, signal: shutdown.signal, stopped }, resources);
	}
} catch (error) {
	if (!shutdown.signal.aborted) { console.error(error.message); process.exitCode = 1; }
} finally {
	try {
		if (resources.quickServer) await resources.quickServer.close();
		else await closeLocalServerResources(resources);
	} catch (error) { console.error(error.message); process.exitCode = 1; }
	for (const signal of signals) process.removeListener(signal, onSignal);
}
