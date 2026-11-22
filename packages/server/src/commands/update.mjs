// The update command. A global npm install updates itself: verified backup, install,
// compatibility check and any migration, restart, and rollback when a step fails before
// data changed. Other installs print their own steps.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { packageVersion } from '../assets.mjs';
import { backupLocalServer } from '../local-server-backup.mjs';
import { readAutoBackup } from '../local-server-backup-schedule.mjs';
import { PACKAGE_NAME, installKind } from '../local-server-install.mjs';
import { requestLocalControl } from '../local-server-pairing.mjs';
import { runProcess } from '../local-server-process.mjs';
import { serviceState, startService, stopService } from '../local-server-service.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */
const execFileAsync = promisify(execFile);

/** @param {string} left @param {string} right @returns {number} Negative when left is older. */
export function compareVersions(left, right) {
	const a = left.split('.').map(Number), b = right.split('.').map(Number);
	for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
	return 0;
}

/**
 * What an automatic update needs from the computer; tests replace each one.
 * @typedef {object} UpdateSteps
 * @property {() => Promise<string>} latest The newest published version.
 * @property {() => Promise<boolean>} running Whether a server answers this data directory.
 * @property {() => Promise<{ installed: boolean, running: boolean, dataDir: string | null }>} service
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} start
 * @property {(output: string) => Promise<string>} backup
 * @property {(version: string) => Promise<void>} install
 * @property {(args: string[]) => Promise<string>} crate Runs the installed Crate CLI.
 * @property {() => Promise<boolean>} waitRunning
 * @property {(message: string) => void} log
 */

/**
 * @param {{ dataDir: string, current: string, backupRoot: string, now?: () => Date }} options
 * @param {UpdateSteps} steps
 * @returns {Promise<'current' | 'updated'>}
 */
export async function updateGlobalInstall({ dataDir, current, backupRoot, now = () => new Date() }, steps) {
	const latest = await steps.latest();
	if (compareVersions(latest, current) <= 0) { steps.log(`Crate ${current} is up to date.`); return 'current'; }
	const service = await steps.service();
	const managed = service.installed && service.dataDir === dataDir;
	if (!managed && await steps.running()) throw new Error('Crate is running in a terminal. Stop it with Ctrl+C, then run update again.');
	const wasRunning = managed && service.running;
	steps.log(`Updating Crate ${current} → ${latest}.`);
	if (wasRunning) await steps.stop();
	const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	let backup;
	try { backup = await steps.backup(join(backupRoot, `before-update-${latest}-${stamp}`)); }
	catch (error) {
		if (wasRunning) await steps.start();
		throw new Error(`Could not back up before updating, so nothing changed: ${error.message}`);
	}
	steps.log(`Backup verified: ${backup}`);
	let migrated = false;
	try {
		await steps.install(latest);
		const check = JSON.parse(await steps.crate(['check-upgrade', '--json', '--data-dir', dataDir]));
		if (check.requiresMigration) {
			steps.log('Migrating the database; the upgrade makes its own verified backup first.');
			// Once the migration starts, the data may already be past what the old release reads.
			migrated = true;
			await steps.crate(['upgrade', '--output', join(backupRoot, `before-migration-${latest}-${stamp}`), '--data-dir', dataDir]);
		}
	} catch (error) {
		if (migrated) throw new Error(`Crate ${latest} could not finish migrating your data: ${error.message}\nRun crate-server upgrade --output <new backup directory> to resume with Crate ${latest}, or restore ${backup} into an empty directory with the restore command of Crate ${current}.`);
		steps.log(`Update failed: ${error.message}\nReinstalling Crate ${current}.`);
		const reinstalled = await steps.install(current).then(() => true, reinstallError => {
			steps.log(`Could not reinstall Crate ${current}: ${reinstallError.message}`);
			return false;
		});
		// npm keeps the previous install when an install fails, so the service can still start.
		if (wasRunning) await steps.start().catch(startError => steps.log(`Could not restart Crate: ${startError.message}`));
		throw new Error(reinstalled
			? `Crate stayed at ${current} and your data is unchanged. The backup is at ${backup}.`
			: `Your data is unchanged, but Crate ${current} could not be reinstalled. Run npm install -g ${PACKAGE_NAME}@${current}. The backup is at ${backup}.`);
	}
	if (!wasRunning) { steps.log(`Crate ${latest} is installed. Start it with crate-server start.`); return 'updated'; }
	await steps.start();
	if (await steps.waitRunning()) { steps.log(`Crate ${latest} is running.`); return 'updated'; }
	if (migrated) throw new Error(`Crate ${latest} migrated your data but did not start. Check its log. To go back, stop the service, restore ${backup} into an empty directory with the restore command of Crate ${current}, and start that.`);
	steps.log(`Crate ${latest} did not start. Reinstalling Crate ${current}.`);
	await steps.stop();
	await steps.install(current);
	await steps.start();
	throw new Error(`Crate stayed at ${current} and your data is unchanged. The backup is at ${backup}.`);
}

/** @param {string} dataDir */
const running = dataDir => requestLocalControl(dataDir, 'GET', '/status').then(() => true, () => false);

/** @type {Command} */
export async function update({ dataDir, signal }) {
	const kind = installKind();
	if (kind === 'docker') { console.log('Update the container from the computer running Docker:\n  docker compose pull && docker compose up -d\nIt checks the data and migrates it with a verified backup before starting.'); return; }
	if (kind === 'source') { console.log('Update a source checkout: stop Crate, back up, then run git pull, npm ci, npm run build:worker and npm run server -- check-upgrade. Start it again if the check passes. See docs/self-hosting.md.'); return; }
	if (kind === 'npx') { console.log(`Stop Crate, then start the newest version: npx ${PACKAGE_NAME}@latest\nIt refuses data it cannot read. Run npm install -g ${PACKAGE_NAME} for one-command updates.`); return; }
	const root = (await execFileAsync('npm', ['root', '-g'])).stdout.trim();
	const script = join(root, PACKAGE_NAME, 'scripts/crate-server.mjs');
	const inside = relative(await realpath(root), await realpath(process.argv[1]));
	if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`This copy of Crate is not the global npm install. Update it with npm in its own folder, or install it globally: npm install -g ${PACKAGE_NAME}`);
	const backupRoot = (await readAutoBackup(dataDir))?.dir ?? join(homedir(), '.crate', 'backups');
	await updateGlobalInstall({ dataDir, current: packageVersion, backupRoot }, {
		latest: async () => (await execFileAsync('npm', ['view', PACKAGE_NAME, 'version'])).stdout.trim(),
		running: () => running(dataDir),
		service: () => serviceState(),
		stop: () => stopService(),
		start: () => startService(),
		backup: output => backupLocalServer(dataDir, output),
		install: version => runProcess('npm', ['install', '-g', `${PACKAGE_NAME}@${version}`], { signal }),
		crate: async args => (await execFileAsync(process.execPath, [script, ...args])).stdout,
		waitRunning: async () => {
			for (let attempt = 0; attempt < 60; attempt++) {
				if (await running(dataDir)) return true;
				await delay(2000, undefined, { signal });
			}
			return false;
		},
		log: message => console.log(message),
	});
}
