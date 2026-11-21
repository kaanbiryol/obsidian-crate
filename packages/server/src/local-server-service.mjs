// Starts Crate at login and restarts it after a failure: a launchd agent on macOS, a
// systemd user service on Linux. The file names exact Node and Crate paths, since
// version-manager shims on PATH do not work for background services.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const SERVICE_LABEL = 'local.crate.server';
const SYSTEMD_UNIT = 'crate';
const execFileAsync = promisify(execFile);

/**
 * @typedef {object} ServiceEnvironment
 * @property {NodeJS.Platform} [platform]
 * @property {string} [home]
 * @property {number} [uid]
 * @property {(command: string, args: string[]) => Promise<{ stdout: string }>} [run]
 */

/** @param {ServiceEnvironment} [environment] */
function resolveEnvironment({ platform = process.platform, home = homedir(), uid = process.getuid?.() ?? 0, run = execFileAsync } = {}) {
	return { platform, home, uid, run };
}

/** Where the service definition and its log live, or null where Crate cannot install one.
 * @param {ServiceEnvironment} [environment] */
export function servicePaths(environment) {
	const { platform, home } = resolveEnvironment(environment);
	if (platform === 'darwin') return { file: join(home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`), log: join(home, 'Library/Logs/crate-server.log') };
	if (platform === 'linux') return { file: join(home, '.config/systemd/user', `${SYSTEMD_UNIT}.service`), log: join(home, '.local/state/crate/server.log') };
	return null;
}

/** @param {string} value */
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** systemd splits ExecStart on spaces; quote each argument. @param {string} value */
const quoted = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * @typedef {object} ServiceCommand
 * @property {string} node Absolute Node executable.
 * @property {string} script Absolute Crate CLI script.
 * @property {string} dataDir
 * @property {boolean} keepAwake
 * @property {string} log
 */

/** @param {ServiceCommand} command */
function serviceArguments({ node, script, dataDir, keepAwake }) {
	return [node, script, 'start', '--data-dir', dataDir, ...(keepAwake ? ['--keep-awake'] : [])];
}

/** PATH lets Crate find cloudflared or tailscale from a service. @param {string} node */
const servicePath = node => [...new Set([dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':');

/** @param {ServiceCommand} command */
export function launchdPlist(command) {
	const args = serviceArguments(command).map(arg => `\t\t<string>${xml(arg)}</string>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SERVICE_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(servicePath(command.node))}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>StandardOutPath</key>
	<string>${xml(command.log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(command.log)}</string>
</dict>
</plist>
`;
}

/** @param {ServiceCommand} command */
export function systemdUnit(command) {
	return `[Unit]
Description=Crate server

[Service]
ExecStart=${serviceArguments(command).map(quoted).join(' ')}
Environment=${quoted(`PATH=${servicePath(command.node)}`)}
StandardOutput=append:${command.log}
StandardError=append:${command.log}
Restart=on-failure
RestartSec=30
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

/** macOS asks before a background service reads these folders, so a service there fails.
 * @param {string} path @param {ServiceEnvironment} [environment] */
export function protectedMacFolder(path, environment) {
	const { platform, home } = resolveEnvironment(environment);
	if (platform !== 'darwin') return null;
	for (const folder of ['Documents', 'Desktop', 'Downloads']) {
		const inside = relative(join(home, folder), path);
		if (!inside.startsWith('..') && !isAbsolute(inside)) return folder;
	}
	return null;
}

/** Whether a service is installed, and for which data directory, and whether it runs.
 * @param {ServiceEnvironment} [environment]
 * @returns {Promise<{ supported: boolean, installed: boolean, running: boolean, keepAwake: boolean, dataDir: string | null, file: string | null, log: string | null }>} */
export async function serviceState(environment) {
	const env = resolveEnvironment(environment);
	const paths = servicePaths(env);
	if (!paths) return { supported: false, installed: false, running: false, keepAwake: false, dataDir: null, file: null, log: null };
	let text;
	try { text = await readFile(paths.file, 'utf8'); }
	catch (error) { if (error.code === 'ENOENT') return { supported: true, installed: false, running: false, keepAwake: false, dataDir: null, ...paths }; throw error; }
	const dataDir = env.platform === 'darwin'
		? text.match(/<string>--data-dir<\/string>\s*<string>([^<]*)<\/string>/)?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') ?? null
		: text.match(/"--data-dir" "((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\(.)/g, '$1') ?? null;
	let running = false;
	try {
		if (env.platform === 'darwin') running = /\bstate = running\b/.test((await env.run('launchctl', ['print', `gui/${env.uid}/${SERVICE_LABEL}`])).stdout);
		else running = (await env.run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT])).stdout.trim() === 'active';
	} catch { /* Not loaded, or not active: both exit non-zero. */ }
	return { supported: true, installed: true, running, keepAwake: text.includes('--keep-awake'), dataDir, ...paths };
}

/** Loads the installed service, which starts Crate. @param {ServiceEnvironment} [environment] */
export async function startService(environment) {
	const env = resolveEnvironment(environment);
	const paths = /** @type {{ file: string }} */ (servicePaths(env));
	if (env.platform === 'darwin') await env.run('launchctl', ['bootstrap', `gui/${env.uid}`, paths.file]);
	else await env.run('systemctl', ['--user', 'start', SYSTEMD_UNIT]);
}

/** Stops Crate cleanly; launchd and systemd send SIGTERM and wait. @param {ServiceEnvironment} [environment] */
export async function stopService(environment) {
	const env = resolveEnvironment(environment);
	try {
		if (env.platform === 'darwin') await env.run('launchctl', ['bootout', `gui/${env.uid}/${SERVICE_LABEL}`]);
		else await env.run('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
	} catch { /* Already stopped. */ }
}

/** Writes the service for this data directory, replacing an earlier one, and starts it.
 * @param {{ dataDir: string, keepAwake: boolean, node?: string, script?: string }} options
 * @param {ServiceEnvironment} [environment]
 * @returns {Promise<{ file: string, log: string }>} */
export async function installService({ dataDir, keepAwake, node = process.execPath, script = process.argv[1] }, environment) {
	const env = resolveEnvironment(environment);
	const paths = servicePaths(env);
	if (!paths) throw new Error('Starting Crate automatically is supported on macOS and Linux. On Windows, use Docker Desktop.');
	const resolvedScript = await realpath(script);
	const folder = protectedMacFolder(resolvedScript, env) ?? protectedMacFolder(dataDir, env);
	if (folder) throw new Error(`macOS blocks background services from reading ${folder}. Install Crate with npm install -g @kaanbiryol/crate-server, or move the checkout and data out of ${folder}.`);
	const command = { node, script: resolvedScript, dataDir, keepAwake, log: paths.log };
	await mkdir(dirname(paths.file), { recursive: true });
	await mkdir(dirname(paths.log), { recursive: true, mode: 0o700 });
	await stopService(env);
	await writeFile(paths.file, env.platform === 'darwin' ? launchdPlist(command) : systemdUnit(command), { mode: 0o644 });
	if (env.platform === 'darwin') await startService(env);
	else {
		await env.run('systemctl', ['--user', 'daemon-reload']);
		await env.run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
	}
	return paths;
}

/** @param {ServiceEnvironment} [environment] @returns {Promise<boolean>} Whether one was installed. */
export async function uninstallService(environment) {
	const env = resolveEnvironment(environment);
	const paths = servicePaths(env);
	if (!paths) return false;
	await stopService(env);
	if (env.platform === 'linux') await env.run('systemctl', ['--user', 'disable', SYSTEMD_UNIT]).catch(() => {});
	try { await unlink(paths.file); }
	catch (error) { if (error.code === 'ENOENT') return false; throw error; }
	if (env.platform === 'linux') await env.run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
	return true;
}

/** Keeps a Mac from idle sleep while this process serves. `-w` ends caffeinate with it.
 * @param {{ platform?: NodeJS.Platform, start?: typeof spawn }} [options] @returns {boolean} */
export function keepAwake({ platform = process.platform, start = spawn } = {}) {
	if (platform !== 'darwin') return false;
	const child = start('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
	child.on('error', () => console.warn('Could not keep this Mac awake: caffeinate did not start.'));
	child.unref();
	return true;
}
