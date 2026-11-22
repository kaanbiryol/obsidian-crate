// The doctor command: checks what keeps a self-hosted server working and prints one fix
// for each problem. It changes nothing.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readLastBackup } from '../local-server-backup.mjs';
import { readAutoBackup } from '../local-server-backup-schedule.mjs';
import { LOW_DISK_BYTES } from '../local-server-alerts.mjs';
import { freeBytes } from '../local-server-host-status.mjs';
import { crateCommand, installKind } from '../local-server-install.mjs';
import { requestLocalControl } from '../local-server-pairing.mjs';
import { serviceState } from '../local-server-service.mjs';
import { findTailscale, tailscaleHostname } from '../local-server-tailscale.mjs';
import { readRemoteSettings } from '../local-server-tunnel.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */
/** @typedef {{ status: 'pass' | 'warn' | 'fail', name: string, detail: string }} Check */

const execFileAsync = promisify(execFile);
const DAY = 24 * 60 * 60_000;

/**
 * Everything doctor looks at; tests replace each probe.
 * @typedef {object} DoctorProbes
 * @property {string} node
 * @property {boolean} hasData
 * @property {() => Promise<{ origin: string, autoBackup: { settings: unknown, lastFailure: { at: string } | null } } | null>} running
 * @property {() => Promise<{ mode?: string, hostname?: string } | null>} remote
 * @property {(origin: string) => Promise<boolean>} reachable
 * @property {() => Promise<string>} tailscale Rejects with the reason when Funnel cannot serve.
 * @property {() => Promise<boolean>} cloudflared
 * @property {() => Promise<{ supported: boolean, installed: boolean, running: boolean, keepAwake: boolean, dataDir: string | null }>} service
 * @property {() => Promise<{ dir: string } | null>} autoBackup
 * @property {() => Promise<{ createdAt: string } | null>} lastBackup
 * @property {(path: string) => Promise<number | null>} free
 * @property {() => Promise<number | null>} sleepMinutes System sleep in minutes on macOS; null elsewhere.
 * @property {string} dataDir
 * @property {(args: string) => string} command
 * @property {() => number} now
 */

/** @param {DoctorProbes} probes @returns {Promise<Check[]>} */
export async function diagnose(probes) {
	/** @type {Check[]} */
	const checks = [];
	const check = (/** @type {Check['status']} */ status, /** @type {string} */ name, /** @type {string} */ detail) => { checks.push({ status, name, detail }); };
	const [major, minor] = probes.node.split('.').map(Number);
	check(major === 26 && minor >= 8 ? 'pass' : 'fail', 'Node.js', major === 26 && minor >= 8 ? probes.node : `${probes.node}: install Node.js 26.8.2 or a later 26.x release.`);
	if (!probes.hasData) {
		check('fail', 'Server data', `No Crate server in ${probes.dataDir}. Run ${probes.command('setup')}, or pass the server's --data-dir.`);
		return checks;
	}
	check('pass', 'Server data', probes.dataDir);
	const running = await probes.running();
	const service = await probes.service();
	const managed = service.installed && service.dataDir === probes.dataDir;
	check(running ? 'pass' : 'fail', 'Running', running ? `at ${running.origin}` : managed ? 'The service is installed but Crate is not running. Check its log.' : `Start it with ${probes.command('start')}.`);
	if (!service.supported) check('warn', 'Start at login', 'Not available on this system; use Docker to keep Crate running.');
	else if (!managed) check('warn', 'Start at login', `Crate stops when this terminal closes or the computer restarts. Run ${probes.command('service')}.`);
	else check(service.running ? 'pass' : 'fail', 'Start at login', service.running ? 'Installed and running.' : `Installed but not running. Reinstall it with ${probes.command('service')}.`);
	const remote = await probes.remote().catch(error => { check('fail', 'Remote access', error.message); return undefined; });
	if (remote === null) check('warn', 'Remote access', `Only this computer can connect. For phones, run ${probes.command('setup --tailscale')}.`);
	else if (remote?.mode === 'quick') check('warn', 'Remote access', 'A temporary address changes on every restart. Run setup --tailscale or setup --hostname for a permanent one.');
	else if (remote?.mode === 'tailscale') {
		await probes.tailscale().then(name => check(name === remote.hostname ? 'pass' : 'fail', 'Tailscale', name === remote.hostname ? `Funnel serves ${name}.`
			: `This computer is now ${name} in Tailscale; rename it back to ${remote.hostname}.`), error => check('fail', 'Tailscale', error.message));
	} else if (remote) {
		const installed = await probes.cloudflared();
		check(installed ? 'pass' : 'fail', 'Cloudflare Tunnel', installed ? `Serves ${remote.hostname}.` : 'cloudflared is missing. Install it: https://developers.cloudflare.com/tunnel/downloads/');
	}
	if (running?.origin.startsWith('https://')) {
		const ok = await probes.reachable(running.origin);
		check(ok ? 'pass' : 'fail', 'Public address', ok ? `${running.origin} reaches this server.` : `${running.origin} does not answer. Check the tunnel and this computer's internet connection; a new address can take 10 minutes.`);
	}
	const auto = await probes.autoBackup();
	const last = await probes.lastBackup();
	const failure = running?.autoBackup.lastFailure;
	if (!auto) check('warn', 'Daily backups', `Off. Turn them on with ${probes.command('auto-backup --output PATH')}.`);
	else if (failure) check('fail', 'Daily backups', `The last one failed at ${failure.at}. See the server log; Crate retries hourly.`);
	else check('pass', 'Daily backups', `To ${auto.dir}.`);
	if (last && probes.now() - Date.parse(last.createdAt) > 2 * DAY) check('warn', 'Last backup', `${last.createdAt}, more than two days ago.`);
	else if (last) check('pass', 'Last backup', last.createdAt);
	const free = (await Promise.all([probes.dataDir, ...(auto ? [auto.dir] : [])].map(probes.free))).filter(size => size !== null);
	if (free.length) {
		const least = Math.min(...free);
		check(least < LOW_DISK_BYTES ? 'fail' : 'pass', 'Disk space', `${(least / 1024 ** 3).toFixed(1)} GB free${least < LOW_DISK_BYTES ? '. Free some space so sync and backups keep working.' : '.'}`);
	}
	const sleep = await probes.sleepMinutes();
	if (sleep && !(managed && service.keepAwake)) check('warn', 'Sleep', `This Mac sleeps after ${sleep} minutes idle, which pauses sync. Run ${probes.command('service --keep-awake')}, or change it in System Settings → Energy.`);
	return checks;
}

/** @type {Command} */
export async function doctor({ dataDir }) {
	const kind = installKind();
	const checks = await diagnose({
		node: process.versions.node,
		hasData: await access(join(dataDir, 'server.json')).then(() => true, () => false),
		running: () => requestLocalControl(dataDir, 'GET', '/status').catch(() => null),
		remote: () => readRemoteSettings(dataDir),
		reachable: async origin => {
			try {
				const response = await fetch(`${origin}/.well-known/crate`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
				return response.ok && /** @type {{ service?: unknown }} */ (await response.json()).service === 'crate';
			} catch { return false; }
		},
		tailscale: async () => tailscaleHostname(await findTailscale()),
		cloudflared: () => execFileAsync('cloudflared', ['--version']).then(() => true, () => false),
		service: () => serviceState(),
		autoBackup: () => readAutoBackup(dataDir),
		lastBackup: () => readLastBackup(dataDir),
		free: freeBytes,
		sleepMinutes: async () => {
			if (process.platform !== 'darwin') return null;
			const match = (await execFileAsync('pmset', ['-g']).catch(() => ({ stdout: '' }))).stdout.match(/^\s*sleep\s+(\d+)/m);
			return match ? Number(match[1]) : null;
		},
		dataDir,
		command: args => crateCommand(kind, args),
		now: Date.now,
	});
	const marks = { pass: '✓', warn: '!', fail: '✗' };
	for (const { status, name, detail } of checks) console.log(`${marks[status]} ${name}: ${detail}`);
	if (checks.some(item => item.status === 'fail')) process.exitCode = 1;
	else console.log(checks.some(item => item.status === 'warn') ? '\nCrate works; the notes above make it more reliable.' : '\nEverything looks good.');
}
