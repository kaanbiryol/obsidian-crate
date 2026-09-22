import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertCompatibleLocalMetadata, localBuildInfo, lockLocalData, openLocalRuntime } from './local-server-runtime.mjs';

const ephemeral = new Set(['server.lock', 'control.json', 'status.json', '.DS_Store']);
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
async function digest(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}
async function inventory(directory, prefix = '') {
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
async function copyInventory(source, target, files) {
	for (const file of files) {
		await mkdir(dirname(join(target, file.path)), { recursive: true, mode: 0o700 });
		await copyFile(join(source, file.path), join(target, file.path));
	}
}

export async function checkLocalUpgrade(dataDir) {
	const current = JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8'));
	const next = await localBuildInfo();
	const migration = next.previousSchemas.some(item => item.sha256 === current.schemaHash);
  assertCompatibleLocalMetadata(migration ? { ...current, schemaHash: next.schemaHash } : current, next);
	return { from: current.serverRevision, to: next.serverRevision, runtime: next.runtimeVersion, requiresMigration: migration };
}

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
		await writeFile(join(staging, 'backup.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), metadata, data, remote }), { mode: 0o600 });
		await rename(staging, output);
		return output;
	} finally { await rm(staging, { recursive: true, force: true }); await unlock(); }
}

export async function restoreLocalServer(dataDir, backup) {
	dataDir = resolve(dataDir);
	backup = await realpath(backup);
	if (inside(dataDir, backup) || inside(backup, dataDir)) throw new Error('Choose a restore directory separate from the backup.');
	const manifest = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'));
	if (manifest.format !== 1 || !Array.isArray(manifest.data) || !Array.isArray(manifest.remote)) throw new Error('Unsupported backup format.');
	assertCompatibleLocalMetadata(manifest.metadata, await localBuildInfo());
	for (const key of ['data', 'remote']) {
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
		await verified.close();
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
