// The setup and start commands: serve the data directory through a Quick Tunnel, a
// saved stable address or a local listener until a signal or the tunnel stops it.
import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname as computerName } from 'node:os';
import { listenLocalServer } from '../local-server-http.mjs';
import { crateCommand, installKind } from '../local-server-install.mjs';
import { keepAwake } from '../local-server-service.mjs';
import { replacesQuickTunnel, resolveMaxFileBytes, resolveServerOrigin, resolveStartMode } from '../local-server-options.mjs';
import { createPairing, startLocalControl } from '../local-server-pairing.mjs';
import { startQuickServer } from '../local-server-quick.mjs';
import { monitorPublicReadiness } from '../local-server-readiness.mjs';
import { readAutoBackup } from '../local-server-backup-schedule.mjs';
import { openLocalRuntime } from '../local-server-runtime.mjs';
import { startTailscaleFunnel } from '../local-server-tailscale.mjs';
import { readRemoteSettings, saveQuickSettings, startTunnel } from '../local-server-tunnel.mjs';
import { migrateBeforeStart } from './data.mjs';
import { formatPairing } from './devices.mjs';
import { buildIfSource, runWizardSetup, setupNamedTunnel, setupTailscale, wizardApplies } from './setup.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */
/** @typedef {import('../local-server-options.mjs').CommandContext} CommandContext */
/** @typedef {import('../local-server-lifecycle.mjs').CommandResources} CommandResources */
/** @typedef {import('../local-server-tunnel.mjs').RemoteSettings} RemoteSettings */

const pairCommand = () => crateCommand(installKind(), 'pair --name "My phone"');

/** @param {boolean} ready */
function readinessChanged(ready) {
	console.log(ready ? 'Ready: the public HTTPS address reaches this Crate server.'
		: 'Checking that the address is reachable. This can take a few minutes the first time.');
}

/** The tips and footer printed under the address and any pairing code.
 * @param {{ dataDir: string, docker: boolean, listener: string, addressTip?: string }} options */
async function startFooter({ dataDir, docker, listener, addressTip }) {
	const backups = await readAutoBackup(dataDir);
	const tips = [
		addressTip,
		backups ? `Daily backups go to ${backups.dir}.` : `Daily backups are off. Turn them on with: ${crateCommand(installKind(), 'auto-backup --output PATH')}`,
		`Add another device with: ${pairCommand()}`,
		`Data: ${dataDir}. Internal listener (diagnostics only): ${listener}`,
	].filter(Boolean).map(tip => `- ${tip}`);
	return `Good to know:\n${tips.join('\n')}\n\n${docker ? 'Crate runs in the background. Stop it with docker compose stop.' : 'Keep this terminal open. Press Ctrl+C to stop safely.'}`;
}

/** Runs setup and start. Setup first saves a stable address when one is asked for or
 * already saved; both then serve until stopped. @type {Command} */
export async function start(context, resources) {
	const { command, dataDir } = context;
	let remote = !context.values.local ? await readRemoteSettings(dataDir) : null;
	if (wizardApplies(context, remote)) {
		const chosen = await runWizardSetup(context, resources);
		if (!chosen) return;
		context = { ...context, values: chosen };
	}
	const { values } = context;
	// A pulled image may need a migration; a mounted /backups keeps its backup off the volume.
	if (context.docker && process.env.CRATE_AUTO_MIGRATE !== '0') {
		await migrateBeforeStart(dataDir, await access('/backups', constants.W_OK).then(() => '/backups', () => join(dirname(dataDir), 'backups')));
	}
	if (values['keep-awake']) console.log(keepAwake() ? 'Keeping this Mac awake while Crate runs.' : 'Keep-awake works on macOS only; keep this computer from sleeping in its power settings.');
	const { quick, tailscale, port, host } = resolveStartMode(command, values, remote);
	const maxFileBytes = resolveMaxFileBytes(values);
	if (maxFileBytes) {
		console.log(`Syncing files up to ${maxFileBytes / 1024 / 1024} MB. Every device needs the current Crate plugin; mobile devices skip files over 25 MB, and encrypted vaults and Markdown notes stay at 128 MB.`);
		if (maxFileBytes > 100_000_000 && (quick || (remote && !tailscale))) console.log('Cloudflare Tunnel refuses single uploads over 100 MB, so encrypted files and Markdown notes over 100 MB fail to sync through it. Other files travel in smaller parts.');
	}
	if (quick) {
		if (command === 'setup' && !remote && !values.quick) console.log('Quick Tunnel chosen by default. Its address changes on restart. For a stable address, run setup with --tailscale or --hostname.');
		await serveQuickTunnel(context, port, resources, maxFileBytes);
		return;
	}
	const replacingQuick = replacesQuickTunnel(command, values, remote);
	if (command === 'setup') {
		if (replacingQuick) remote = null;
		remote = tailscale ? await setupTailscale(context, remote, port, resources) : await setupNamedTunnel(context, remote, port, resources);
		if (replacingQuick) console.log('Replaced the Quick Tunnel with this stable address. On each device, select Server details → Update server address once, and enroll the PWA again.');
	}
	await serve(context, { remote, tailscale, port, host, maxFileBytes }, resources);
}

/** @param {CommandContext} context @param {number} port @param {CommandResources} resources @param {number | undefined} maxFileBytes */
async function serveQuickTunnel({ command, values, dataDir, docker, signal, stopped }, port, resources, maxFileBytes) {
	console.log('Starting Crate on a temporary Cloudflare address. Your files stay on this computer.');
	if (command === 'setup') await buildIfSource(signal);
	const quickServer = resources.quickServer = await startQuickServer({ dataDir, port, name: values.name, signal, onReadiness: readinessChanged, maxFileBytes });
	await saveQuickSettings(dataDir, port);
	const origin = quickServer.runtime.origin;
	const listener = `127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (quickServer.server.address()).port}`;
	const addressTip = `This address changes each time Crate restarts, and the web app then needs a new setup link. ${docker
		? 'For a permanent address, see "Stable address without a domain: Tailscale Funnel" in the self-hosting guide.'
		: `For a permanent address, run: ${crateCommand(installKind(), 'setup --tailscale')}`}`;
	console.log(`\nServer address to paste into Obsidian: ${origin}\n${quickServer.pairingCode ? formatPairing(quickServer.pairingCode, origin)
		: 'Devices you connected before still work. In Crate, select Server details → Update server address and paste the address above.\n'}\n${await startFooter({ dataDir, docker, listener, addressTip })}`);
	const result = await Promise.race([stopped.then(() => null), quickServer.tunnel.exited, quickServer.runtime.failed]);
	if (result && !signal.aborted) throw new Error(`Cloudflare Quick Tunnel stopped (${result.error?.code ?? result.signal ?? result.code}). Restart Crate to get a new address.`);
}

/** Serves through the saved Tailscale Funnel or named tunnel, or locally without one.
 * @param {CommandContext} context
 * @param {{ remote: RemoteSettings | null, tailscale: boolean, port: number, host: string, maxFileBytes: number | undefined }} mode
 * @param {CommandResources} resources */
async function serve({ values, dataDir, docker, signal, stopped }, { remote, tailscale, port, host, maxFileBytes }, resources) {
	signal.throwIfAborted();
	const origin = resolveServerOrigin({ remote, tailscale, origin: values.origin, port, host });
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, origin, administrative: false, handleSignals: false, maxFileBytes });
	signal.throwIfAborted();
	const instance = randomUUID();
	const pairing = createPairing({ db: () => runtime.db });
	resources.server = await listenLocalServer(runtime, { host, port, pairing, instance, tunnel: remote ? (tailscale ? 'tailscale' : 'cloudflare') : null, maxFileBytes });
	const control = resources.control = await startLocalControl({ dataDir, pairing, origin, runtime });
	/** @type {{ count: number }} */
	const existing = await runtime.db.prepare("SELECT COUNT(*) AS count FROM auth_tokens WHERE scope = 'vault'").first();
	const firstPairing = existing.count === 0 ? pairing.issue(values.name?.trim() || computerName().slice(0, 128)) : null;
	signal.throwIfAborted();
	/** @type {import('../local-server-process.mjs').StartedProcess | undefined} */
	let tunnel;
	if (remote) tunnel = resources.tunnel = tailscale ? await startTailscaleFunnel(remote, signal) : await startTunnel(dataDir, remote, signal);
	// One write, so setup's log follower sees the pairing code together with the address.
	console.log(`\nServer address to paste into Obsidian: ${runtime.origin}\n${firstPairing ? formatPairing(firstPairing, origin) : ''}\n${await startFooter({ dataDir, docker, listener: `${host}:${port}` })}`);
	if (origin.startsWith('https://')) {
		resources.readiness = monitorPublicReadiness({ origin, instance, signal, onChange: ready => { control.onReadiness(ready); readinessChanged(ready); } });
	}
	if (remote) console.log(tailscale ? 'Tailscale Funnel is starting. The first time, approve Funnel at the link Tailscale prints; a new address can take up to 10 minutes to work.'
		: 'The tunnel is starting. A new address can take a few minutes to work.');
	const result = await Promise.race([stopped.then(() => null), runtime.failed, ...(tunnel ? [tunnel.exited] : [])]);
	if (result && !signal.aborted) throw new Error(tailscale
		? `Tailscale Funnel stopped (${result.error?.code ?? result.signal ?? result.code}). Crate is stopping too; check the Tailscale output above. On Linux, allow your user once with: sudo tailscale set --operator=$USER`
		: `Cloudflare Tunnel stopped (${result.error?.code ?? result.signal ?? result.code}). Crate is stopping too; check cloudflared output and restart.`);
}
