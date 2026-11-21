// Stable address setup: Tailscale Funnel or a named Cloudflare Tunnel. Each step locks
// storage before provisioning and returns the saved remote settings that start serves.
import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { hostname as computerName } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { packageVersion, packaged, runtimeRoot } from '../assets.mjs';
import { saveAutoBackup } from '../local-server-backup-schedule.mjs';
import { PACKAGE_NAME, crateCommand, installKind } from '../local-server-install.mjs';
import { requestLocalControl, requestLocalPairing } from '../local-server-pairing.mjs';
import { runProcess } from '../local-server-process.mjs';
import { openLocalRuntime } from '../local-server-runtime.mjs';
import { installService, servicePaths } from '../local-server-service.mjs';
import { currentTailscaleHostname, findTailscale } from '../local-server-tailscale.mjs';
import { ensureCloudflared, normalizeTunnelHostname, saveTailscaleSettings, setupRemoteAccess } from '../local-server-tunnel.mjs';
import { runSetupWizard } from '../local-server-wizard.mjs';
import { printPairing } from './devices.mjs';
import { describeAutoBackup } from './status.mjs';

const execFileAsync = promisify(execFile);

/** @typedef {import('../local-server-options.mjs').CommandContext} CommandContext */
/** @typedef {import('../local-server-lifecycle.mjs').CommandResources} CommandResources */
/** @typedef {import('../local-server-tunnel.mjs').RemoteSettings} RemoteSettings */

/** A source checkout builds the Worker; an installed package ships it.
 * @param {AbortSignal} signal */
export async function buildIfSource(signal) {
	if (!packaged) await runProcess(process.execPath, [join(runtimeRoot, 'scripts/build-worker.mjs')], { signal });
}

/** Saves this computer's Tailscale Funnel address.
 * @param {CommandContext} context
 * @param {RemoteSettings | null} remote The directory's saved settings.
 * @param {number} port
 * @param {CommandResources} resources
 * @returns {Promise<RemoteSettings>} */
export async function setupTailscale({ dataDir, signal }, remote, port, resources) {
	console.log('Setting up Tailscale Funnel. Files stay on this computer; public HTTPS traffic passes through Tailscale.');
	await buildIfSource(signal);
	// Lock and validate storage before exposing anything.
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
	const hostname = await currentTailscaleHostname(signal);
	if (remote && remote.hostname !== hostname) throw new Error(`This directory was set up for https://${remote.hostname}. Rename this computer back in Tailscale to keep connected devices and PWAs.`);
	const saved = await saveTailscaleSettings(dataDir, hostname, port);
	await runtime.close();
	resources.runtime = null;
	return saved;
}

/** Provisions a named Cloudflare Tunnel and its DNS route, asking for the hostname when
 * none is saved or given.
 * @param {CommandContext} context
 * @param {RemoteSettings | null} remote The directory's saved settings.
 * @param {number} port
 * @param {CommandResources} resources
 * @returns {Promise<RemoteSettings>} */
export async function setupNamedTunnel({ dataDir, values, signal }, remote, port, resources) {
	let hostname = values.hostname ?? remote?.hostname;
	if (!hostname) {
		if (!process.stdin.isTTY) throw new Error('Provide --hostname crate.example.com when setup runs without an interactive terminal.');
		const prompt = createInterface({ input: process.stdin, output: process.stdout });
		try { hostname = await prompt.question('Public hostname on your Cloudflare domain (e.g. crate.example.com): ', { signal }); }
		finally { prompt.close(); }
	}
	hostname = normalizeTunnelHostname(hostname);
	if (remote && remote.hostname !== hostname) throw new Error('This directory already has a saved hostname. Reuse it to preserve installed PWA connections.');
	console.log(`Setting up https://${hostname}. Files stay on this computer; public HTTPS traffic passes through Cloudflare.`);
	await buildIfSource(signal);
	// Lock and validate storage before installing or provisioning anything.
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
	signal.throwIfAborted();
	await ensureCloudflared({ signal });
	const saved = await setupRemoteAccess({ dataDir, hostname, port, signal });
	await runtime.close();
	resources.runtime = null;
	return saved;
}

/** Setup asks its questions only in a terminal, when no option or saved setup decides.
 * @param {CommandContext} context @param {RemoteSettings | null} remote */
export function wizardApplies({ command, values, docker }, remote) {
	return command === 'setup' && !remote && !docker && !values.hostname && !values.tailscale && !values.quick
		&& Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Asks the setup questions, saves daily backups, and either installs the service (returning
 * null) or returns the options a foreground start serves with.
 * @param {CommandContext} context @param {CommandResources} resources
 * @returns {Promise<import('../local-server-options.mjs').CommandOptions | null>} */
export async function runWizardSetup(context, resources) {
	const { dataDir, signal } = context;
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	let choices;
	try { choices = await runSetupWizard({ ask: question => prompt.question(question, { signal }), findTailscale }); }
	finally { prompt.close(); }
	const values = { ...context.values, 'keep-awake': choices.keepAwake,
		...(choices.access === 'tailscale' ? { tailscale: true } : choices.access === 'quick' ? { quick: true } : { hostname: choices.hostname }) };
	const port = values.port === undefined ? choices.access === 'quick' ? 0 : 8787 : Number(values.port);
	const configured = { ...context, values };
	if (choices.service) {
		// Provisioning initializes storage and needs the interactive Tailscale or Cloudflare login.
		if (choices.access === 'tailscale') await setupTailscale(configured, null, port, resources);
		else await setupNamedTunnel(configured, null, port, resources);
		if (choices.backupDir) console.log(describeAutoBackup(await saveAutoBackup(dataDir, { dir: choices.backupDir, keep: 7 })));
		await startAsService(configured, choices.keepAwake);
		return null;
	}
	if (choices.backupDir) {
		// Saving settings creates the data directory, so initialize its storage first.
		await buildIfSource(signal);
		const runtime = resources.runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
		await runtime.close();
		resources.runtime = null;
		console.log(describeAutoBackup(await saveAutoBackup(dataDir, { dir: choices.backupDir, keep: 7 })));
	}
	return values;
}

/** A service needs a script that outlives npx's temporary cache.
 * @param {AbortSignal} signal @returns {Promise<string>} */
async function lastingScript(signal) {
	if (installKind() !== 'npx') return process.argv[1];
	console.log(`Installing Crate so it can start at login: npm install -g ${PACKAGE_NAME}@${packageVersion}`);
	await runProcess('npm', ['install', '-g', `${PACKAGE_NAME}@${packageVersion}`], { signal });
	const root = (await execFileAsync('npm', ['root', '-g'])).stdout.trim();
	return join(root, PACKAGE_NAME, 'scripts/crate-server.mjs');
}

/** Installs the service, then shows its log until the address is public and a pairing
 * code is on screen. Ctrl+C closes only this view; the service keeps running.
 * @param {CommandContext} context @param {boolean} keepAwake */
async function startAsService({ dataDir, signal, values }, keepAwake) {
	const script = await lastingScript(signal);
	const logPath = /** @type {{ log: string }} */ (servicePaths()).log;
	let offset = await stat(logPath).then(info => info.size, () => 0);
	await installService({ dataDir, keepAwake, script, maxFileSize: values['max-file-size'] });
	console.log(`\nCrate now runs in the background and starts when you log in. Its log follows; press Ctrl+C to close this view, Crate keeps running.\nLog: ${logPath}\n`);
	let shown = '', paired = false, ready = false;
	const deadline = Date.now() + 15 * 60_000;
	while (!signal.aborted && Date.now() < deadline && !(paired && ready)) {
		const file = await open(logPath, 'r').catch(() => null);
		if (file) {
			try {
				const { size } = await file.stat();
				if (size > offset) {
					const buffer = Buffer.alloc(size - offset);
					await file.read(buffer, 0, buffer.length, offset);
					offset = size;
					const text = buffer.toString();
					process.stdout.write(text);
					shown += text;
				}
			} finally { await file.close(); }
		}
		ready ||= /^Ready: /m.test(shown);
		paired ||= shown.includes('crate-pair-');
		// The server prints the address after any first pairing code; existing devices mean none.
		if (!paired && shown.includes('Server address to paste into Obsidian:') && await requestLocalControl(dataDir, 'GET', '/status').then(() => true, () => false)) {
			const pairing = await requestLocalPairing(dataDir, computerName().slice(0, 128));
			printPairing(pairing, pairing.origin);
			paired = true;
		}
		await delay(1000, undefined, { signal }).catch(() => {});
	}
	if (signal.aborted) return;
	console.log(ready ? `\nCrate is set up. Check on it any time with: ${crateCommand(installKind(), 'doctor')}`
		: `\nCrate is still waiting for its public address. It keeps trying in the background; check with: ${crateCommand(installKind(), 'doctor')}`);
}
