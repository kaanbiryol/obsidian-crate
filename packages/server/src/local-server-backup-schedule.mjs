// Backups of a running server: one at a time, on request or once a day when automatic
// backups are on. Settings live in `auto-backup.json` in the data directory.
import { mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { backupLocalServer, readBackupManifest } from './local-server-backup.mjs';

/** @typedef {{ dir: string, keep: number }} AutoBackupSettings */
/** @typedef {{ path: string, createdAt: string }} AutomaticBackup */

const DAY = 24 * 60 * 60_000;
const automaticName = /^crate-\d{8}T\d{6}Z$/;
const settingsPath = (/** @type {string} */ dataDir) => join(dataDir, 'auto-backup.json');

/** @param {number} time */
export const automaticBackupName = time => `crate-${new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;

/** @param {string} dataDir @returns {Promise<AutoBackupSettings | null>} */
export async function readAutoBackup(dataDir) {
	try {
		const { dir, keep } = JSON.parse(await readFile(settingsPath(dataDir), 'utf8'));
		return typeof dir === 'string' && isAbsolute(dir) && Number.isInteger(keep) && keep >= 1 && keep <= 30 ? { dir, keep } : null;
	} catch { return null; }
}

/** Turns automatic backups on, or off with `null`.
 * @param {string} dataDir @param {{ dir: string, keep: number } | null} settings
 * @returns {Promise<AutoBackupSettings | null>} */
export async function saveAutoBackup(dataDir, settings) {
	if (!settings) { await unlink(settingsPath(dataDir)).catch(error => { if (error.code !== 'ENOENT') throw error; }); return null; }
	if (!Number.isInteger(settings.keep) || settings.keep < 1 || settings.keep > 30) throw new Error('--keep must be a whole number from 1 to 30.');
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const data = await realpath(dataDir);
	await mkdir(resolve(settings.dir), { recursive: true, mode: 0o700 });
	const dir = await realpath(resolve(settings.dir));
	for (const owned of [data, `${data}.remote`]) {
		const path = relative(owned, dir);
		if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) throw new Error('Choose a backup directory outside the server data and remote directories.');
	}
	const saved = { dir, keep: settings.keep };
	await writeFile(settingsPath(dataDir), `${JSON.stringify(saved)}\n`, { mode: 0o600 });
	return saved;
}

/** Automatic backups in `dir`, newest first. Anything else there is not Crate's to manage.
 * @param {string} dir @returns {Promise<AutomaticBackup[]>} */
export async function listAutomaticBackups(dir) {
	const names = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
	/** @type {AutomaticBackup[]} */
	const backups = [];
	for (const name of names.filter(name => automaticName.test(name)).sort().reverse()) {
		// The name records when the schedule started it, by the same clock that decides the next one.
		const createdAt = name.replace(/^crate-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
		if (await readBackupManifest(join(dir, name)).then(() => true, () => false)) backups.push({ path: join(dir, name), createdAt });
	}
	return backups;
}

/** Deletes the oldest automatic backups beyond `keep`. @param {string} dir @param {number} keep */
async function pruneAutomaticBackups(dir, keep) {
	for (const old of (await listAutomaticBackups(dir)).slice(keep)) await rm(old.path, { recursive: true, force: true });
}

/**
 * Backs up a running server on request, and daily while automatic backups are on.
 * @param {object} options
 * @param {string} options.dataDir
 * @param {Pick<import('./local-server-runtime.mjs').LocalRuntime, 'pause'>} options.runtime
 * @param {() => number} [options.now]
 * @param {number} [options.firstCheck] Milliseconds after start before the first check.
 * @param {number} [options.interval] Milliseconds between checks.
 * @param {typeof backupLocalServer} [options.backup]
 * @param {(automaticFailure: boolean) => void} [options.onChange] After a verified backup, or a failed automatic one.
 */
export function startBackups({ dataDir, runtime, now = Date.now, firstCheck = 5 * 60_000, interval = 60 * 60_000, backup = backupLocalServer, onChange = () => {} }) {
	/** @type {Promise<{ output: string, pausedMs: number }> | null} */
	let running = null;
	/** @type {{ at: string, message: string } | null} */
	let lastFailure = null;
	let closed = false;
	/** @type {NodeJS.Timeout | undefined} */
	let timer;

	/** @param {string} output @param {string} [linkFrom] */
	function run(output, linkFrom) {
		if (running) return Promise.reject(Object.assign(new Error('A backup is already running.'), { code: 'EBUSY' }));
		if (closed) return Promise.reject(new Error('Crate is stopping.'));
		running = (async () => {
			let pausedMs = 0;
			const pause = async () => {
				const resume = await runtime.pause();
				const started = Date.now();
				return async () => { try { await resume(); } finally { pausedMs = Date.now() - started; } };
			};
			const created = await backup(dataDir, output, { alreadyLocked: true, pause, linkFrom });
			onChange(false);
			return { output: created, pausedMs };
		})().finally(() => { running = null; });
		return running;
	}

	/** Backs up if automatic backups are on and the newest is a day old. */
	async function check() {
		const settings = await readAutoBackup(dataDir);
		if (!settings || running || closed) return;
		try {
			const [latest] = await listAutomaticBackups(settings.dir);
			if (latest && now() - Date.parse(latest.createdAt) < DAY) return;
			const result = await run(join(settings.dir, automaticBackupName(now())), latest?.path);
			await pruneAutomaticBackups(settings.dir, settings.keep);
			lastFailure = null;
			console.log(`Automatic backup verified: ${result.output} (writes paused ${(result.pausedMs / 1000).toFixed(1)} s).`);
		} catch (error) {
			if (error?.code === 'EBUSY' || closed) return;
			lastFailure = { at: new Date(now()).toISOString(), message: error instanceof Error ? error.message : String(error) };
			console.warn(`Automatic backup failed; Crate retries within the hour: ${lastFailure.message}`);
			onChange(true);
		}
	}

	/** @param {number} delay */
	const schedule = delay => { timer = setTimeout(() => { void check().finally(() => { if (!closed) schedule(interval); }); }, delay); timer.unref(); };
	schedule(firstCheck);

	return {
		run,
		/** Checks now, after automatic backups were turned on. */
		check,
		async status() {
			return { settings: await readAutoBackup(dataDir), lastFailure, running: running !== null };
		},
		/** Stops scheduling and waits for a running backup, which holds the runtime paused. */
		async close() {
			closed = true;
			clearTimeout(timer);
			await running?.catch(() => {});
		},
	};
}
