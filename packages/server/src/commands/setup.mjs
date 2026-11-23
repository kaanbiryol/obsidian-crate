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
import { assertFunnelPortFree, currentTailscaleHostname, findTailscale, tailscaleSocket } from '../local-server-tailscale.mjs';
import { ensureCloudflared, normalizeTunnelHostname, saveTailscaleSettings, setupRemoteAccess } from '../local-server-tunnel.mjs';
import { runSetupWizard } from '../local-server-wizard.mjs';
import { printPairing } from './devices.mjs';
import { bold, cyan, dim, green, red } from '../local-server-style.mjs';
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
	console.log(dim('Setting up Tailscale Funnel. Files stay on this computer; public HTTPS traffic passes through Tailscale.'));
	await buildIfSource(signal);
	// Lock and validate storage before exposing anything.
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
	const hostname = await currentTailscaleHostname(signal);
	if (!tailscaleSocket()) await assertFunnelPortFree(await findTailscale(), hostname, port);
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
	console.log(dim(`Setting up https://${hostname}. Files stay on this computer; public HTTPS traffic passes through Cloudflare.`));
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
		const remote = choices.access === 'tailscale' ? await setupTailscale(configured, null, port, resources)
			: await setupNamedTunnel(configured, null, port, resources);
		const backups = choices.backupDir ? await saveAutoBackup(dataDir, { dir: choices.backupDir, keep: 7 }) : null;
		const script = await lastingScript(signal);
		const logPath = /** @type {{ log: string }} */ (servicePaths()).log;
		// Only this run's log lines matter; earlier runs may have left codes and errors.
		const offset = await stat(logPath).then(info => info.size, () => 0);
		await installService({ dataDir, keepAwake: choices.keepAwake, script, maxFileSize: values['max-file-size'] });
		const origin = `https://${remote.hostname}`;
		console.log(`\n${green('✓')} ${choices.access === 'tailscale' ? 'Tailscale Funnel' : 'Cloudflare Tunnel'} address: ${cyan(origin)}`
			+ `\n${green('✓')} Starts when you log in${choices.keepAwake ? ' and keeps this Mac awake' : ''}`
			+ `\n${green('✓')} ${backups ? `Daily backups to ${backups.dir}` : 'Daily backups are off'}`);
		await followService({ dataDir, origin, logPath, offset, signal });
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
	console.log(dim(`Installing Crate so it can start at login: npm install -g ${PACKAGE_NAME}@${packageVersion}`));
	await runProcess('npm', ['install', '-g', `${PACKAGE_NAME}@${packageVersion}`], { signal });
	const root = (await execFileAsync('npm', ['root', '-g'])).stdout.trim();
	return join(root, PACKAGE_NAME, 'scripts/crate-server.mjs');
}

/** The background server's log lines that need the person during setup: Tailscale's
 * Funnel approval link and startup errors.
 * @param {string} log @returns {string[]} */
export function serviceNotices(log) {
	return [
		...[...log.matchAll(/https:\/\/login\.tailscale\.com\/\S+/g)].map(([link]) => `Turn on Tailscale Funnel for your tailnet: ${cyan(link)}`),
		...[...log.matchAll(/^Error: .+$/gm)].map(([error]) => error),
	];
}

/** Waits for the background server to answer at its public address, then shows a code
 * that connects Obsidian. The server's log stays in its file; this shows only what needs
 * the person: Tailscale's approval link, startup errors, readiness and the code.
 * Ctrl+C stops waiting; the service keeps running.
 * @param {{ dataDir: string, origin: string, logPath: string, offset: number, signal: AbortSignal }} options */
async function followService({ dataDir, origin, logPath, offset, signal }) {
	const doctor = crateCommand(installKind(), 'doctor');
	console.log(dim(`\nChecking that ${origin} is reachable. This can take a few minutes the first time.\nPress Ctrl+C to stop waiting; Crate keeps running in the background.`));
	const surfaced = new Set();
	let shown = '', ready = false;
	const deadline = Date.now() + 15 * 60_000;
	while (!signal.aborted && Date.now() < deadline && !ready) {
		const file = await open(logPath, 'r').catch(() => null);
		if (file) {
			try {
				const { size } = await file.stat();
				if (size > offset) {
					const buffer = Buffer.alloc(size - offset);
					await file.read(buffer, 0, buffer.length, offset);
					offset = size;
					shown += buffer.toString();
				}
			} finally { await file.close(); }
		}
		for (const notice of serviceNotices(shown)) {
			if (!surfaced.has(notice)) { surfaced.add(notice); console.log(notice.startsWith('Error: ') ? red(notice) : notice); }
		}
		ready = /^Ready: /m.test(shown) && await requestLocalControl(dataDir, 'GET', '/status').then(() => true, () => false);
		if (!ready) await delay(1000, undefined, { signal }).catch(() => {});
	}
	if (signal.aborted) return;
	if (!ready) {
		console.log(`\nCrate is still waiting for ${origin} to work. It keeps trying in the background; check with: ${cyan(doctor)}\n${dim(`Log: ${logPath}`)}`);
		return;
	}
	console.log(`${green('✓')} ${origin} is reachable`);
	// The server shows its first code in the log once ready; with devices connected, ask for one.
	const code = /crate-pair-[a-f0-9]{64}/.exec(shown)?.[0];
	printPairing(code ? { code } : await requestLocalPairing(dataDir, computerName().slice(0, 128)), origin);
	console.log(`${bold('Crate keeps running in the background.')} Check on it with: ${cyan(doctor)}\n${dim(`Log: ${logPath}`)}`);
}
