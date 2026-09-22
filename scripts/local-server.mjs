import { homedir, hostname as computerName } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';
import { listenLocalServer } from './local-server-http.mjs';
import { ensureCloudflared, normalizeTunnelHostname, readRemoteSettings, saveQuickSettings, setupRemoteAccess, startTunnel } from './local-server-tunnel.mjs';
import { runProcess } from './local-server-process.mjs';
import { startQuickServer } from './local-server-quick.mjs';
import { createPairing, requestLocalPairing, startLocalControl } from './local-server-pairing.mjs';
import { monitorPublicReadiness } from './local-server-readiness.mjs';
import { randomUUID } from 'node:crypto';
import { backupLocalServer, checkLocalUpgrade, restoreLocalServer } from './local-server-backup.mjs';

const help = `Crate local server

npm run server -- setup [--data-dir PATH] [--name "My Mac"]
npm run server -- setup --hostname crate.example.com [--data-dir PATH] [--port 8787]
npm run server -- start [--data-dir PATH]
npm run server -- start --local [--port 8787] [--host 127.0.0.1] [--origin https://crate.example.com]
npm run server -- add-device --name "My Mac" [--data-dir PATH]
npm run server -- pair --name "My phone" [--data-dir PATH]
npm run server -- backup --output PATH [--data-dir PATH]
npm run server -- upgrade --output NEW_BACKUP_PATH [--data-dir PATH]
npm run server -- restore --backup PATH --data-dir EMPTY_PATH
npm run server -- check-upgrade [--data-dir PATH]

Setup defaults to a Quick Tunnel: no account or domain. It initializes storage,
installs cloudflared if missing, and prints your address and first pairing code.
Quick Tunnel addresses change on restart; reconnect devices and re-enroll PWAs.
--hostname selects a permanent named tunnel and requires a Cloudflare domain.
Start reuses saved remote settings; --local skips the managed tunnel.
Without remote setup, start uses localhost (build first: npm run build:worker).
Use pair while the server is running to connect another device without downtime.
Stop the server before offline add-device administration.
Default data directory: ~/.crate/server (one vault per directory).
See docs/self-hosting.md for backups, updates, and other HTTPS proxies.`;

const shutdown = new AbortController();
const stopped = new Promise(resolve => shutdown.signal.addEventListener('abort', resolve, { once: true }));
const onSignal = () => shutdown.abort();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, onSignal);
let runtime;
let server;
let tunnel;
let quickServer;
let control;
let readiness;
const docker = process.env.CRATE_DOCKER === '1';
const pairCommand = docker ? 'docker compose exec crate crate pair --name "My phone"'
	: process.argv[1].endsWith('crate-server.mjs') ? 'npx @kaanbiryol/crate-server pair --name "My phone"' : 'npm run server -- pair --name "My phone"';
function printPairing(pairing) {
	console.log(`Pairing code (single use, expires in 10 minutes): ${pairing.code}\nPaste this code into Crate → Connect to your server. Keep it private.`);
}
function readinessChanged(ready) {
	console.log(ready ? 'Ready: the public HTTPS address reaches this Crate server.'
		: 'Waiting for public access: checking the tunnel and DNS. The local server is running; keep it running while this check retries.');
}

async function buildIfSource() {
	const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
	if (!metadata.crateServerAssets) await runProcess(process.execPath, [join(import.meta.dirname, 'build-worker.mjs')], { signal: shutdown.signal });
}

function printDevice(name, credential) {
	console.log(`Device: ${name}\nToken ID: ${credential.id}\nAccess token (shown once): ${credential.token}\nPaste this token into Crate → Connect to your server. Keep it private.`);
}

try {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		'data-dir': { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, origin: { type: 'string' },
		output: { type: 'string' }, backup: { type: 'string' },
		hostname: { type: 'string' }, name: { type: 'string' }, local: { type: 'boolean' }, quick: { type: 'boolean' }, help: { type: 'boolean' },
	} });
	let command = positionals[0];
	if (values.help || !command) console.log(help);
	else {
		if (positionals.length !== 1 || !['start', 'setup', 'add-device', 'pair', 'backup', 'restore', 'check-upgrade', 'upgrade'].includes(command)) throw new Error('Unknown command. Use --help for usage.');
		if (command === 'setup' && (values.local || values.host || values.origin)) throw new Error('Setup uses a loopback listener and --hostname for the public address.');
		if (values.quick && (values.hostname || values.local || values.origin || values.host || command === 'add-device')) throw new Error('--quick cannot be combined with hostname, local, origin, host, or add-device.');
		if (command !== 'setup' && values.hostname) throw new Error('--hostname belongs to setup. Use --origin for an external reverse proxy.');
		if (command === 'add-device' && !values.name?.trim()) throw new Error('Provide --name for this device.');
		if (values.name !== undefined && (!values.name.trim() || values.name.trim().length > 128)) throw new Error('Provide a device name between 1 and 128 characters.');
		process.umask(0o077);
		const dataDir = resolve(values['data-dir'] ?? join(homedir(), '.crate', 'server'));
		if (command === 'backup') {
			if (!values.output) throw new Error('Provide --output with a new backup directory. Stop the server before backing up.');
			console.log(`Backup verified: ${await backupLocalServer(dataDir, values.output)}`);
		} else if (command === 'upgrade') {
 if (!values.output) throw new Error('Stop the server and provide --output with a new backup directory.');
 const upgraded = await openLocalRuntime({ dataDir, administrative: true, upgradeBackup: values.output });
 await upgraded.close();
 console.log('Server data upgraded. The verified backup is at ' + resolve(values.output));
		} else if (command === 'restore') {
			if (!values.backup) throw new Error('Provide --backup with a verified backup directory. Restore into an empty data directory.');
			await restoreLocalServer(dataDir, values.backup);
			console.log(`Backup restored and database verified: ${dataDir}. Start Crate to resume.`);
		} else if (command === 'check-upgrade') {
			const checked = await checkLocalUpgrade(dataDir);
			console.log(`Compatible: server revision ${checked.from} → ${checked.to}, runtime ${checked.runtime}. Back up before updating; no data was changed by this check.`);
		} else if (command === 'pair') {
			const pairing = await requestLocalPairing(dataDir, values.name);
			console.log(`Server address to paste into Obsidian: ${pairing.origin}`);
			printPairing(pairing);
		} else {
		let remote = command !== 'add-device' && !values.local ? await readRemoteSettings(dataDir) : null;
		const quick = values.quick || remote?.mode === 'quick' || (command === 'setup' && !remote && !values.hostname);
		if (quick && (values.hostname || values.origin || values.host || (remote && remote.mode !== 'quick'))) throw new Error('Quick Tunnel and named tunnel settings cannot be combined.');
		const port = values.port === undefined ? remote?.port ?? (quick ? 0 : 8787) : Number(values.port);
		if (!Number.isInteger(port) || port < (quick ? 0 : 1) || port > 65535) throw new Error('Port must be between 1 and 65535 (or 0 for an automatic Quick Tunnel port).');
		const host = values.host ?? '127.0.0.1';
		if (quick) {
			console.log('Starting Crate with a Cloudflare Quick Tunnel. Files stay on this computer; public HTTPS traffic passes through Cloudflare.');
			console.log('This temporary address changes on restart. Keep the server computer awake and online.');
			if (command === 'setup') await buildIfSource();
			quickServer = await startQuickServer({ dataDir, port, name: values.name, signal: shutdown.signal, onReadiness: readinessChanged });
			await saveQuickSettings(dataDir, port);
			console.log(`Server address to paste into Obsidian: ${quickServer.runtime.origin}\nInternal listener (diagnostics only): 127.0.0.1:${quickServer.server.address().port}\nData: ${dataDir}`);
			if (quickServer.pairingCode) printPairing(quickServer.pairingCode);
			else console.log('Existing device tokens remain valid. Update the server address in Crate to the URL above.');
			console.log(`Connect in Obsidian → Settings → Crate → Connect to your server, then select Sync now.\nUse Copy app link or Show QR code in Crate to enroll the PWA. A new tunnel address requires fresh PWA enrollment.\nAdd a device without restarting: ${pairCommand}\n${docker ? 'Crate runs in the background. Stop it with docker compose stop.' : 'Keep this terminal open. Press Ctrl+C to stop safely.'}`);
			const result = await Promise.race([stopped.then(() => null), quickServer.tunnel.exited]);
			if (result && !shutdown.signal.aborted) throw new Error(`Cloudflare Quick Tunnel stopped (${result.error?.code ?? result.signal ?? result.code}). Restart Crate to get a new address.`);
		} else {
			if (remote && (port !== remote.port || host !== '127.0.0.1' || (values.origin && values.origin !== `https://${remote.hostname}`))) {
				throw new Error('Saved tunnel settings require their original hostname, port, and loopback listener. Use --local for an independent reverse proxy.');
			}
			if (command === 'setup') {
				let hostname = values.hostname ?? remote?.hostname;
				if (!hostname) {
					if (!process.stdin.isTTY) throw new Error('Provide --hostname crate.example.com when setup runs without an interactive terminal.');
					const prompt = createInterface({ input: process.stdin, output: process.stdout });
					try { hostname = await prompt.question('Public hostname on your Cloudflare domain (e.g. crate.example.com): ', { signal: shutdown.signal }); }
					finally { prompt.close(); }
				}
				hostname = normalizeTunnelHostname(hostname);
				if (remote && remote.hostname !== hostname) throw new Error('This directory already has a saved hostname. Reuse it to preserve installed PWA connections.');
				console.log(`Setting up https://${hostname}. Files stay on this computer; public HTTPS traffic passes through Cloudflare.`);
				await buildIfSource();
				// Lock and validate storage before installing or provisioning anything.
				runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
				shutdown.signal.throwIfAborted();
				await ensureCloudflared({ signal: shutdown.signal });
				remote = await setupRemoteAccess({ dataDir, hostname, port, signal: shutdown.signal });
				await runtime.close();
				runtime = null;
				command = 'start';
			}
			shutdown.signal.throwIfAborted();
			if (remote && !remote.ready) throw new Error('Remote setup is incomplete. Run npm run server -- setup again.');
			const origin = remote ? `https://${remote.hostname}` : values.origin ?? `http://localhost:${port}`;
			if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !origin.startsWith('https://')) {
				throw new Error('Listening beyond localhost requires --origin with the HTTPS address of your reverse proxy.');
			}
			runtime = await openLocalRuntime({ dataDir, origin, administrative: command === 'add-device', handleSignals: false });
			shutdown.signal.throwIfAborted();
			if (command === 'add-device') printDevice(values.name, await issueLocalDevice(runtime.db, values.name));
			else {
				const instance = randomUUID();
				const pairing = createPairing({ db: runtime.db });
				server = await listenLocalServer(runtime, { host, port, pairing, instance });
				control = await startLocalControl({ dataDir, pairing, origin });
				const existing = await runtime.db.prepare("SELECT COUNT(*) AS count FROM auth_tokens WHERE scope = 'vault'").first();
				if (existing.count === 0) printPairing(pairing.issue(values.name?.trim() || computerName().slice(0, 128)));
				shutdown.signal.throwIfAborted();
				if (remote) tunnel = await startTunnel(dataDir, remote, shutdown.signal);
				console.log(`Server address to paste into Obsidian: ${runtime.origin}\nInternal listener (diagnostics only): ${host}:${port}\nData: ${runtime.dataDir}\nAdd a device without restarting: ${pairCommand}\n${docker ? 'Crate runs in the background. Stop it with docker compose stop.' : 'Press Ctrl+C to stop safely.'}`);
				if (origin.startsWith('https://')) readiness = monitorPublicReadiness({ origin, instance, signal: shutdown.signal, onChange: readinessChanged });
				if (remote) console.log('Tunnel is starting; initial DNS/certificate propagation may take a few minutes.\nUse this HTTPS server address in Obsidian, then Copy app link or Show QR code to enroll the PWA.');
				const result = await Promise.race([stopped.then(() => null), ...(tunnel ? [tunnel.exited] : [])]);
				if (result && !shutdown.signal.aborted) throw new Error(`Cloudflare Tunnel stopped (${result.error?.code ?? result.signal ?? result.code}). Crate is stopping too; check cloudflared output and restart.`);
			}
		}
		}
	}
} catch (error) {
	if (!shutdown.signal.aborted) { console.error(error.message); process.exitCode = 1; }
} finally {
	try {
		await readiness?.close();
		await control?.close();
		await quickServer?.close();
		await tunnel?.stop();
		if (server) {
			const deadline = setTimeout(() => server.closeAllConnections(), 5000);
			try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
			finally { clearTimeout(deadline); }
		}
		await runtime?.close();
	} catch (error) { console.error(error.message); process.exitCode = 1; }
	for (const signal of signals) process.removeListener(signal, onSignal);
}
