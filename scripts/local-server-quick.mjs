import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installCloudflared } from './local-server-cloudflared.mjs';
import { startProcess, tunnelEnvironment } from './local-server-process.mjs';
import { openLocalRuntime } from './local-server-runtime.mjs';
import { listenLocalServer } from './local-server-http.mjs';
import { createPairing, startLocalControl } from './local-server-pairing.mjs';
import { monitorPublicReadiness } from './local-server-readiness.mjs';

export function quickTunnelOrigin(output) {
	return output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s/]|$)/)?.[0] ?? null;
}

export async function startQuickTunnel({ command, port, signal, timeout = 60_000 }) {
	const temporary = await mkdtemp(join(tmpdir(), 'crate-quick-'));
	const config = join(temporary, 'config.yml');
	await writeFile(config, '{}\n', { mode: 0o600 });
	let output = '';
	let discovered;
	const originReady = new Promise(resolve => { discovered = resolve; });
	let child;
	let timer;
	try {
		child = startProcess(command, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`,
			'--metrics', '127.0.0.1:0'], { signal, env: tunnelEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], onOutput(chunk) {
			output = (output + chunk).slice(-16_384);
			const origin = quickTunnelOrigin(output);
			if (origin) discovered(origin);
		} });
		const origin = await Promise.race([
			originReady,
			child.exited.then(result => { throw new Error(`Cloudflare Quick Tunnel stopped (${result.error?.code ?? result.signal ?? result.code}). ${output.slice(-2000)}`); }),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for a Cloudflare Quick Tunnel address. Check internet access and retry.')), timeout); }),
		]);
		signal?.throwIfAborted();
		return { origin, exited: child.exited, async stop() { await child.stop(); await rm(temporary, { recursive: true, force: true }); } };
	} catch (error) {
		await child?.stop();
		await rm(temporary, { recursive: true, force: true });
		throw error;
	} finally { clearTimeout(timer); }
}

export async function startQuickServer({ dataDir, port = 0, name = hostname().slice(0, 128), signal, onReadiness }) {
	let runtime;
	let active;
	let server;
	let tunnel;
	let pairing;
	let control;
	let readiness;
	const instance = randomUUID();
	async function close() {
		active = null;
		await readiness?.close();
		await control?.close();
		await tunnel?.stop();
		if (server) {
			const deadline = setTimeout(() => server.closeAllConnections(), 5000);
			try { await new Promise(resolve => server.close(resolve)); }
			finally { clearTimeout(deadline); }
		}
		await runtime?.close();
	}
	try {
		// Reject a bad or already-running data directory before any exposure.
		runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
		const command = await installCloudflared({ signal });
		server = await listenLocalServer(() => active, { host: '127.0.0.1', port, instance,
			pairing: { exchange: code => pairing.exchange(code) } });
		tunnel = await startQuickTunnel({ command, port: server.address().port, signal });
		await runtime.close();
		runtime = await openLocalRuntime({ dataDir, origin: tunnel.origin, handleSignals: false });
		signal?.throwIfAborted();
		const existing = await runtime.db.prepare("SELECT COUNT(*) AS count FROM auth_tokens WHERE scope = 'vault'").first();
		pairing = createPairing({ db: runtime.db });
		const pairingCode = existing.count === 0 ? pairing.issue(name) : null;
		control = await startLocalControl({ dataDir, pairing, origin: runtime.origin });
		active = runtime;
		readiness = monitorPublicReadiness({ origin: runtime.origin, instance, signal, onChange: onReadiness });
		return { runtime, tunnel, server, pairingCode, name, close };
	} catch (error) { await close(); throw error; }
}
