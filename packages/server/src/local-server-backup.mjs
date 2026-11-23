import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
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

// A backup describes its own source, so the record of the last backup stays out of it, and so
// do automatic backup settings: a restored copy must not prune the original server's backups.
const ephemeral = new Set(['server.lock', 'workerd.json', 'control.json', 'control.sock', 'status.json', 'last-backup.json', 'auto-backup.json', 'alerts.json', '.DS_Store']);
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

// Miniflare stores R2 object bytes in write-once files with unguessable names: a blob is
// only ever created or deleted, never changed (BlobStore in miniflare's shared worker).
const isBlob = (/** @type {string} */ path) => /(?:^|\/)blobs\/[^/]+$/.test(path);
const GiB = 1024 ** 3;

/** @param {string} directory @param {string} [prefix]
 * @returns {Promise<{ path: string, size: number, mtimeMs: number }[]>} Files in `inventory` order. */
async function listFiles(directory, prefix = '') {
	/** @type {{ path: string, size: number, mtimeMs: number }[]} */
	const files = [];
	for (const name of (await readdir(join(directory, prefix))).sort()) {
		const path = prefix ? `${prefix}/${name}` : name;
		if (!prefix && ephemeral.has(name)) continue;
		const stat = await lstat(join(directory, path));
		if (stat.isDirectory()) files.push(...await listFiles(directory, path));
		else if (stat.isFile()) files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
		else throw new Error('Backups cannot contain symlinks or special files.');
	}
	return files;
}
/** @param {string} directory */
const listOptional = directory => listFiles(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });

/** Copies a file, hashing the bytes read from the source. Never writes through an existing
 * target: it may be a hard link into an earlier backup. @param {string} source @param {string} target @param {AbortSignal} [signal] */
async function copyHashed(source, target, signal) {
	signal?.throwIfAborted();
	await rm(target, { force: true });
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const hash = createHash('sha256');
	await pipeline(createReadStream(source), async function* (chunks) { for await (const chunk of chunks) { hash.update(chunk); yield chunk; } }, createWriteStream(target, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
	return hash.digest('hex');
}

/** @param {string} source @param {string} target @returns {Promise<boolean>} False when the filesystem cannot link them. */
async function tryLink(source, target) {
	await rm(target, { force: true });
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	try { await link(source, target); return true; }
	catch (error) { if (['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'ENOENT'].includes(error.code)) return false; throw error; }
}

/** @param {string} directory */
async function freeBytes(directory) {
	const stats = await statfs(directory);
	return stats.bavail * stats.bsize;
}

/**
 * Creates a verified backup. A running server passes `pause`: write-once blobs are copied
 * while it serves, and only the rest is copied while its runtime is stopped.
 * @param {string} dataDir
 * @param {string} output A new directory.
 * @param {object} [options]
 * @param {boolean} [options.alreadyLocked] The caller holds the data directory lock.
 * @param {() => Promise<() => Promise<void>>} [options.pause] Stops writes; returns a resume.
 * @param {string} [options.linkFrom] An earlier backup whose unchanged blobs are hard-linked, not copied.
 * @param {AbortSignal} [options.signal] Stops the backup between and during copies; nothing is published.
 * @param {(directory: string) => Promise<number>} [options.available] Free bytes where the backup goes.
 * @returns {Promise<string>} The backup directory.
 */
export async function backupLocalServer(dataDir, output, { alreadyLocked = false, pause, linkFrom, signal, available = freeBytes } = {}) {
	dataDir = await realpath(dataDir);
	output = resolve(output);
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	output = join(await realpath(dirname(output)), basename(output));
	if (inside(dataDir, output) || inside(`${dataDir}.remote`, output)) throw new Error('Choose a backup location outside the server data and remote directories.');
	if (await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('The backup destination already exists. Choose a new directory.');
	const unlock = alreadyLocked ? async () => {} : await lockLocalData(dataDir);
	const staging = `${output}.tmp-${randomUUID()}`;
	try {
		/** @type {Map<string, BackupFile>} Blobs an earlier backup holds, by path. */
		const linkable = new Map();
		if (linkFrom) {
			const previous = await readBackupManifest(linkFrom).catch(() => null);
			for (const file of previous?.data ?? []) if (isBlob(file.path)) linkable.set(file.path, file);
		}
		/** @param {{ path: string, size: number }} file @returns {Promise<string>} Its SHA-256. */
		const place = async file => {
			const target = join(staging, 'data', file.path);
			const earlier = linkable.get(file.path);
			if (linkFrom && earlier?.size === file.size && await tryLink(join(linkFrom, 'data', file.path), target)) return earlier.sha256;
			return copyHashed(join(dataDir, file.path), target, signal);
		};
		const before = await listFiles(dataDir);
		const needed = [...before, ...await listOptional(`${dataDir}.remote`)]
			.reduce((sum, file) => sum + (linkable.get(file.path)?.size === file.size ? 0 : file.size), 0);
		const free = await available(dirname(output));
		if (free < needed + GiB) throw new Error(`Not enough free space for a backup at ${dirname(output)}: it needs about ${Math.ceil(needed / 1024 ** 2)} MB plus 1 GB to spare, and ${Math.floor(free / 1024 ** 2)} MB is free.`);
		await mkdir(staging, { mode: 0o700 });
		await mkdir(join(staging, 'data'), { mode: 0o700 });
		await mkdir(join(staging, 'remote'), { mode: 0o700 });
		/** @type {Map<string, { size: number, mtimeMs: number, sha256: string }>} */
		const early = new Map();
		if (pause) for (const file of before.filter(file => isBlob(file.path))) {
			// Maintenance may delete an expired blob meanwhile; the listing taken while paused decides what the backup holds.
			try { early.set(file.path, { ...file, sha256: await place(file) }); }
			catch (error) { if (error.code !== 'ENOENT') throw error; await rm(join(staging, 'data', file.path), { force: true }); }
		}
		const resume = pause ? await pause() : null;
		/** @type {import('./local-server-runtime.mjs').ServerMetadata} */
		let metadata;
		/** @type {BackupFile[]} */
		const data = [];
		/** @type {BackupFile[]} */
		const remote = [];
		try {
			metadata = JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8'));
			for (const file of await listFiles(dataDir)) {
				const copied = early.get(file.path);
				early.delete(file.path);
				const unchanged = copied && copied.size === file.size && copied.mtimeMs === file.mtimeMs;
				data.push({ path: file.path, size: file.size, sha256: unchanged ? copied.sha256 : await place(file) });
			}
			for (const file of await listOptional(`${dataDir}.remote`)) {
				remote.push({ path: file.path, size: file.size, sha256: await copyHashed(join(`${dataDir}.remote`, file.path), join(staging, 'remote', file.path), signal) });
			}
		} finally { await resume?.(); }
		// Blobs deleted after they were copied.
		for (const path of early.keys()) await rm(join(staging, 'data', path), { force: true });
		// Re-read copied bytes before publishing a completed backup.
		if (JSON.stringify(await inventory(join(staging, 'data'))) !== JSON.stringify(data)
			|| JSON.stringify(await inventory(join(staging, 'remote'))) !== JSON.stringify(remote)) throw new Error('Backup verification failed. No completed backup was created.');
		signal?.throwIfAborted();
		const createdAt = new Date().toISOString();
		await writeFile(join(staging, 'backup.json'), JSON.stringify({ format: 1, createdAt, metadata, data, remote }), { mode: 0o600 });
		await rename(staging, output);
		// Only a status report reads this; the completed backup stands even if recording it fails.
		await writeFile(join(dataDir, 'last-backup.json'), `${JSON.stringify({ createdAt, output })}\n`, { mode: 0o600 })
			.catch(error => console.warn(`Backup completed, but its time could not be recorded: ${error.message}`));
		return output;
	} finally { await rm(staging, { recursive: true, force: true }); await unlock(); }
}

/** Backs up stopped data before a migration into `output`, or reuses the backup already
 * there while it is this data directory's latest backup: Compose restarts a failing
 * migration, which must not copy the data each time. A backup that is no longer the latest
 * (a restore, a later backup, or a lost record) is kept, and a new one is made beside it.
 * @param {string} dataDir @param {string} output @returns {Promise<string>} The backup used. */
export async function prepareMigrationBackup(dataDir, output) {
	const latest = await readLastBackup(dataDir);
	const existing = await realpath(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
	if (existing && latest?.output === existing && await readBackupManifest(existing).then(() => true, () => false)) return existing;
	const target = existing ? `${output}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}` : output;
	return backupLocalServer(dataDir, target, { alreadyLocked: true });
}

/** @param {string} backup @returns {Promise<BackupManifest>} */
export async function readBackupManifest(backup) {
	const manifest = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'));
	if (manifest?.format !== 1 || !Array.isArray(manifest.data) || !Array.isArray(manifest.remote) || typeof manifest.createdAt !== 'string') throw new Error('Unsupported backup format.');
	return manifest;
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
