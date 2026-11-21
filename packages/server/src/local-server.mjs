// The CLI entry: parses arguments, turns signals into an abort, runs one command and
// closes what it opened, in order, even after a failure. Commands live in commands/.
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { tailscaleSocket } from './local-server-tailscale.mjs';
import { closeLocalServerResources } from './local-server-lifecycle.mjs';
import { validateCommandOptions } from './local-server-options.mjs';
import { backup, checkUpgrade, restore, upgrade } from './commands/data.mjs';
import { addDevice, listDevices, pair, revoke } from './commands/devices.mjs';
import { start } from './commands/start.mjs';
import { status } from './commands/status.mjs';

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
npm run server -- upgrade --output NEW_BACKUP_PATH [--data-dir PATH]
npm run server -- restore --backup PATH --data-dir EMPTY_PATH
npm run server -- check-upgrade [--data-dir PATH]

Setup defaults to a Quick Tunnel: no account or domain. It initializes storage,
installs cloudflared if missing, and prints your address and first pairing code.
Quick Tunnel addresses change on restart; reconnect devices and re-enroll PWAs.
--hostname selects a permanent named tunnel and requires a Cloudflare domain.
--tailscale uses Tailscale Funnel for a permanent address without a domain.
Start reuses saved remote settings; --local skips the managed tunnel.
Without remote setup, start uses localhost (build first: npm run build:worker).
Use pair while the server is running to connect another device without downtime.
devices, revoke and status work while the server runs or while it is stopped.
Stop the server before offline add-device administration.
Default data directory: ~/.crate/server (one vault per directory).
See docs/self-hosting.md for backups, updates, and other HTTPS proxies.`;

/** @type {Record<string, import('./local-server-options.mjs').Command>} */
const commands = {
	setup: start, start, 'add-device': addDevice, pair, devices: listDevices, revoke, status,
	backup, upgrade, restore, 'check-upgrade': checkUpgrade,
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
		output: { type: 'string' }, backup: { type: 'string' },
		hostname: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, local: { type: 'boolean' }, quick: { type: 'boolean' }, tailscale: { type: 'boolean' }, help: { type: 'boolean' },
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
