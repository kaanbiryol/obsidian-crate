import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { runProcess, startProcess, tunnelEnvironment } from './local-server-process.mjs';

export function normalizeTunnelHostname(value) {
	const hostname = value?.trim().toLowerCase();
	if (!hostname || hostname.length > 253 || !hostname.includes('.') || isIP(hostname)
		|| hostname.endsWith('.localhost') || hostname.endsWith('.local')
		|| hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
		throw new Error('Provide a public DNS hostname such as crate.example.com, without https://, a port, or a path.');
	}
	return hostname;
}

export function remotePaths(dataDir) {
	const directory = `${resolve(dataDir)}.remote`;
	return { directory, settings: join(directory, 'remote.json'), credentials: join(directory, 'tunnel.json'), config: join(directory, 'config.yml') };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJson(path) {
	let text;
	try { text = await readFile(path, 'utf8'); }
	catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
	try { return JSON.parse(text); }
	catch { throw new Error(`Invalid JSON in ${path}. Restore this file before continuing.`); }
}

export async function readRemoteSettings(dataDir) {
	const paths = remotePaths(dataDir);
	const settings = await readJson(paths.settings);
	if (settings === undefined) {
		const contents = await readdir(paths.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
		if (contents.some(name => name !== '.DS_Store')) throw new Error('Remote configuration files exist without remote.json. Restore the complete remote directory before continuing.');
		return null;
	}
	if (settings?.mode === 'quick') {
		if (settings.format !== 1 || !Number.isInteger(settings.port) || settings.port < 0 || settings.port > 65535) throw new Error('Invalid saved Quick Tunnel settings.');
		return settings;
	}
	if (!settings || settings.format !== 1 || typeof settings.hostname !== 'string'
		|| normalizeTunnelHostname(settings.hostname) !== settings.hostname
		|| !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535
		|| typeof settings.ready !== 'boolean' || typeof settings.name !== 'string' || !settings.name.startsWith('crate-') || !uuid.test(settings.name.slice(6))
		|| (settings.tunnelId !== undefined && !uuid.test(settings.tunnelId)) || (settings.ready && !settings.tunnelId)) {
		throw new Error('Invalid saved remote configuration. Restore it before continuing.');
	}
	return settings;
}

export async function saveQuickSettings(dataDir, port) {
	const existing = await readRemoteSettings(dataDir);
	if (existing && existing.mode !== 'quick') throw new Error('This directory uses a named tunnel. Keep that setup or choose another data directory.');
	const paths = remotePaths(dataDir);
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	await writePrivate(paths.settings, { format: 1, mode: 'quick', port });
}

async function writePrivate(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, 'wx', 0o600);
		try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
		finally { await file.close(); }
		await rename(temporary, path);
	} finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function readCredentials(path, settings) {
	const credentials = await readJson(path);
	if (!credentials || !uuid.test(credentials.TunnelID) || typeof credentials.AccountTag !== 'string'
		|| !credentials.AccountTag || typeof credentials.TunnelSecret !== 'string'
		|| Buffer.from(credentials.TunnelSecret, 'base64').length !== 32
		|| (settings.tunnelId && credentials.TunnelID !== settings.tunnelId)) {
		throw new Error('Tunnel credentials are missing or invalid. Restore the remote configuration directory; do not create a replacement tunnel for an existing address.');
	}
	await chmod(path, 0o600);
	return credentials;
}

export async function ensureCloudflared({ signal, run = runProcess, platform = process.platform } = {}) {
	try { await run('cloudflared', ['--version'], { signal, stdio: 'ignore' }); }
	catch (error) {
		if (error.code !== 'ENOENT') throw error;
		if (platform !== 'darwin') throw new Error('Install cloudflared, then rerun setup: https://developers.cloudflare.com/tunnel/downloads/');
		try { await run('brew', ['--version'], { signal, stdio: 'ignore' }); }
		catch { signal?.throwIfAborted(); throw new Error('Install cloudflared (brew install cloudflared), then rerun setup. Homebrew was not available.'); }
		console.log('Installing cloudflared with Homebrew...');
		await run('brew', ['install', 'cloudflared'], { signal });
		await run('cloudflared', ['--version'], { signal, stdio: 'ignore' });
	}
}

// Caller holds the server data lock throughout setup. Persist each completed
// step so a failed DNS request can resume without creating another tunnel.
export async function setupRemoteAccess({ dataDir, hostname, port, signal, run = runProcess }) {
	const paths = remotePaths(dataDir);
	let settings = await readRemoteSettings(dataDir);
	hostname = normalizeTunnelHostname(hostname ?? settings?.hostname);
	port ??= settings?.port ?? 8787;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
	if (settings && (settings.hostname !== hostname || settings.port !== port)) {
		throw new Error('This data directory already has a saved hostname and port. Reuse them; changing the PWA origin requires a deliberate migration.');
	}
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	await chmod(paths.directory, 0o700);
	if (!settings) {
		settings = { format: 1, hostname, port, name: `crate-${randomUUID()}`, ready: false };
		await writePrivate(paths.settings, settings);
	}
	const cf = args => run('cloudflared', ['tunnel', '--config', paths.config, ...args], { signal, env: tunnelEnvironment() });
	// An explicit config prevents an unrelated ~/.cloudflared/config.yml from
	// changing provisioning behavior. JSON is valid YAML for cloudflared.
	if (!settings.ready) {
		await writePrivate(paths.config, {});
		const certificate = join(homedir(), '.cloudflared', 'cert.pem');
		if (!(await stat(certificate).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.size) {
			console.log('Authorize your domain in the Cloudflare browser login. On a headless host, open the printed URL on another device.');
			await cf(['login']);
		}
		if (!(await stat(paths.credentials).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) {
			if (settings.tunnelId) throw new Error('Saved tunnel credentials are missing. Restore the remote configuration directory.');
			await cf(['create', '--credentials-file', paths.credentials, settings.name]);
		}
		const credentials = await readCredentials(paths.credentials, settings);
		settings.tunnelId = credentials.TunnelID;
		await writePrivate(paths.settings, settings);
		console.log(`Connecting ${hostname} to this tunnel. Existing DNS records will not be overwritten.`);
		await cf(['route', 'dns', settings.tunnelId, hostname]);
	}
	await readCredentials(paths.credentials, settings);
	await writeTunnelConfig(paths, settings);
	await cf(['ingress', 'validate']);
	signal?.throwIfAborted();
	settings.ready = true;
	await writePrivate(paths.settings, settings);
	return settings;
}

async function writeTunnelConfig(paths, settings) {
	await writePrivate(paths.config, { tunnel: settings.tunnelId, 'credentials-file': paths.credentials,
		ingress: [{ hostname: settings.hostname, service: `http://127.0.0.1:${settings.port}` }, { service: 'http_status:404' }] });
}

export async function startTunnel(dataDir, settings, signal) {
	if (!settings.ready || !settings.tunnelId) throw new Error('Remote setup is incomplete. Run npm run server -- setup again.');
	const paths = remotePaths(dataDir);
	await readCredentials(paths.credentials, settings);
	await writeTunnelConfig(paths, settings);
	return startProcess('cloudflared', ['tunnel', '--config', paths.config, '--no-autoupdate', '--loglevel', 'info',
		'--metrics', '127.0.0.1:0', 'run', settings.tunnelId], { signal, env: tunnelEnvironment() });
}
