import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertLocalMigrationPath } from './local-server-migrations.mjs';
import { assertCompatibleLocalMetadata, localBuildInfo, lockLocalData, openLocalRuntime } from './local-server-runtime.mjs';

/**
 * One backed-up file, relative to its directory.
 * @typedef {{ path: string, size: number, sha256: string }} BackupFile
 */

/**
 * A verified backup's inventory (`backup.json`).
 * @typedef {object} BackupManifest
 * @property {number} format
 * @property {string} createdAt
 * @property {import('./local-server-runtime.mjs').ServerMetadata} metadata
 * @property {BackupFile[]} data
 * @property {BackupFile[]} remote
 */

// A backup describes its own source, so the record of the last backup stays out of it.
const ephemeral = new Set(['server.lock', 'control.json', 'control.sock', 'status.json', 'last-backup.json', '.DS_Store']);
const inside = (/** @type {string} */ parent, /** @type {string} */ child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
/** @param {string} path */
async function digest(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}
/** @param {string} directory @param {string} [prefix] @returns {Promise<BackupFile[]>} */
async function inventory(directory, prefix = '') {
	/** @type {BackupFile[]} */
	const files = [];
	for (const name of (await readdir(join(directory, prefix))).sort()) {
		const path = prefix ? `${prefix}/${name}` : name;
		if (!prefix && ephemeral.has(name)) continue;
		const stat = await lstat(join(directory, path));
		if (stat.isDirectory()) files.push(...await inventory(directory, path));
		else if (stat.isFile()) files.push({ path, size: stat.size, sha256: await digest(join(directory, path)) });
		else throw new Error('Backups cannot contain symlinks or special files.');
	}
	return files;
}
/** @param {string} source @param {string} target @param {BackupFile[]} files */
async function copyInventory(source, target, files) {
	for (const file of files) {
		await mkdir(dirname(join(target, file.path)), { recursive: true, mode: 0o700 });
		await copyFile(join(source, file.path), join(target, file.path));
	}
}

/** @param {string} dataDir */
export async function checkLocalUpgrade(dataDir) {
	/** @type {import('./local-server-runtime.mjs').ServerMetadata} */
	const current = JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8'));
	const next = await localBuildInfo();
	const migration = current?.schemaHash !== next.schemaHash;
	if (migration) assertLocalMigrationPath(current?.schemaVersion, next.release);
  assertCompatibleLocalMetadata(migration ? { ...current, schemaHash: next.schemaHash } : current, next);
	return { from: current.serverRevision, to: next.serverRevision, runtime: next.runtimeVersion, requiresMigration: migration };
}

/** @param {string} dataDir @param {string} output @param {boolean} [alreadyLocked] @returns {Promise<string>} The backup directory. */
export async function backupLocalServer(dataDir, output, alreadyLocked = false) {
	dataDir = await realpath(dataDir);
	output = resolve(output);
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	output = join(await realpath(dirname(output)), basename(output));
	if (inside(dataDir, output) || inside(`${dataDir}.remote`, output)) throw new Error('Choose a backup location outside the server data and remote directories.');
	if (await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('The backup destination already exists. Choose a new directory.');
	const unlock = alreadyLocked ? async () => {} : await lockLocalData(dataDir);
	const staging = `${output}.tmp-${randomUUID()}`;
	try {
		/** @type {import('./local-server-runtime.mjs').ServerMetadata} */
		const metadata = JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8'));
		const data = await inventory(dataDir);
		const remote = await inventory(`${dataDir}.remote`).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
		await mkdir(staging, { mode: 0o700 });
		await mkdir(join(staging, 'data'), { mode: 0o700 });
		await mkdir(join(staging, 'remote'), { mode: 0o700 });
		await copyInventory(dataDir, join(staging, 'data'), data);
		await copyInventory(`${dataDir}.remote`, join(staging, 'remote'), remote);
		// Re-read copied bytes before publishing a completed backup.
		if (JSON.stringify(await inventory(join(staging, 'data'))) !== JSON.stringify(data)
			|| JSON.stringify(await inventory(join(staging, 'remote'))) !== JSON.stringify(remote)) throw new Error('Backup verification failed. No completed backup was created.');
		const createdAt = new Date().toISOString();
		await writeFile(join(staging, 'backup.json'), JSON.stringify({ format: 1, createdAt, metadata, data, remote }), { mode: 0o600 });
		await rename(staging, output);
		// Only a status report reads this; the completed backup stands even if recording it fails.
		await writeFile(join(dataDir, 'last-backup.json'), `${JSON.stringify({ createdAt, output })}\n`, { mode: 0o600 })
			.catch(error => console.warn(`Backup completed, but its time could not be recorded: ${error.message}`));
		return output;
	} finally { await rm(staging, { recursive: true, force: true }); await unlock(); }
}

/** The most recent verified backup of this data directory, or null if none was recorded.
 * @param {string} dataDir @returns {Promise<{ createdAt: string, output: string } | null>} */
export async function readLastBackup(dataDir) {
	try {
		const record = JSON.parse(await readFile(join(dataDir, 'last-backup.json'), 'utf8'));
		return typeof record?.createdAt === 'string' && typeof record.output === 'string' ? { createdAt: record.createdAt, output: record.output } : null;
	} catch { return null; }
}

/** @param {string} dataDir @param {string} backup */
export async function restoreLocalServer(dataDir, backup) {
	dataDir = resolve(dataDir);
	backup = await realpath(backup);
	if (inside(dataDir, backup) || inside(backup, dataDir)) throw new Error('Choose a restore directory separate from the backup.');
	/** @type {BackupManifest} */
	const manifest = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'));
	if (manifest.format !== 1 || !Array.isArray(manifest.data) || !Array.isArray(manifest.remote)) throw new Error('Unsupported backup format.');
	assertCompatibleLocalMetadata(manifest.metadata, await localBuildInfo());
	for (const key of /** @type {const} */ (['data', 'remote'])) {
		for (const file of manifest[key]) {
			if (typeof file.path !== 'string' || !file.path || file.path.includes('\\')
				|| file.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid backup file path.');
		}
		if (JSON.stringify(await inventory(join(backup, key))) !== JSON.stringify(manifest[key])) throw new Error('Backup files are missing, changed, or damaged. Restore was not started.');
	}
	const metadata = JSON.parse(await readFile(join(backup, 'data/server.json'), 'utf8'));
	if (JSON.stringify(metadata) !== JSON.stringify(manifest.metadata)) throw new Error('Backup metadata does not match its inventory.');
	const unlock = await lockLocalData(dataDir);
	const staging = `${dataDir}.restore-${randomUUID()}`;
	try {
		if ((await readdir(dataDir)).some(name => name !== 'server.lock')) throw new Error('Restore requires an empty data directory. Existing data was not changed.');
		if (await lstat(`${dataDir}.remote`).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('Restore requires an unused remote settings directory.');
		await mkdir(staging, { mode: 0o700 });
		await copyInventory(join(backup, 'data'), staging, manifest.data);
		// Validate the restored database with alarms disabled before exposing it.
		const verified = await openLocalRuntime({ dataDir: staging, administrative: true, handleSignals: false });
		// A restored server is another server to its devices, even once its changelog catches
		// up with their cursors. The next sync read creates a new storage identity
		// (STORAGE_ID_SQL in src/cloudflare/worker/sync/storage.ts).
		try { await verified.db.prepare("DELETE FROM maintenance_state WHERE key = 'storage_id'").run(); }
		finally { await verified.close(); }
		const files = await inventory(staging);
		await copyInventory(staging, dataDir, files.filter(file => file.path !== 'server.json'));
		if (manifest.remote.length) {
			await mkdir(`${dataDir}.remote`, { mode: 0o700 });
			await copyInventory(join(backup, 'remote'), `${dataDir}.remote`, manifest.remote);
		}
		// Metadata is the final publication marker; interrupted copies fail closed.
		await copyFile(join(staging, 'server.json'), join(dataDir, 'server.json'));
	} finally { await rm(staging, { recursive: true, force: true }); await unlock(); }
}
