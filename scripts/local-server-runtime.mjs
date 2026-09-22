import { migrateLocalDatabase } from './local-server-migrations.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const { Miniflare, convertV4MiniflareOptions } = await import(packageInfo.crateServerAssets
	? '../vendor/miniflare/dist/src/index.js' : 'miniflare');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

export async function localBuildInfo() {
	const packaged = packageInfo.crateServerAssets === true;
	const [schema, release] = await Promise.all([
		readFile(join(root, packaged ? 'assets/schema.sql' : 'src/cloudflare/schema.sql'), 'utf8'),
		readFile(join(root, packaged ? 'assets/server-release.json' : 'src/cloudflare/server-release.json'), 'utf8'),
	]);
	return { runtimeVersion: packageInfo.crateServerRuntime ?? packageInfo.devDependencies.miniflare,
		schemaHash: digest(schema), serverRevision: JSON.parse(release).revision, previousSchemas: JSON.parse(release).previousSchemas ?? [] };
}

export function assertCompatibleLocalMetadata(previous, expected) {
	if (!previous || previous.format !== 1 || !Number.isSafeInteger(previous.serverRevision)
		|| previous.serverRevision < 1 || typeof previous.instanceId !== 'string' || previous.schemaHash !== expected.schemaHash
		|| previous.runtimeVersion !== expected.runtimeVersion || previous.serverRevision > expected.serverRevision) {
		throw new Error('This data directory requires a matching schema/runtime and an equal or newer server revision. Keep the previous installation and backup; this change requires a tested migration. Do not edit server.json.');
	}
}

export function normalizeLocalOrigin(value) {
	const url = new URL(value);
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
		|| url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Origin must be an HTTPS origin, or HTTP on localhost, without a path or credentials.');
	}
	return url.origin;
}

// Every command owns the complete data directory. Never run two workerd
// processes against the same SQLite files, including administrative commands.
export async function lockLocalData(dataDir) {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, 'server.lock');
	let handle;
	try { handle = await open(path, 'wx', 0o600); }
	catch (error) {
		if (error.code !== 'EEXIST') throw error;
		throw new Error(`Data directory is locked. Stop its Crate server first. After a crash, verify no Crate/workerd process uses this directory before removing ${path}.`);
	}
	await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
	await handle.close();
	return () => unlink(path);
}

export async function openLocalRuntime({ dataDir, origin = 'http://localhost:8787', administrative = false, handleSignals = true, upgradeBackup }) {
	dataDir = resolve(dataDir);
	origin = normalizeLocalOrigin(origin);
	const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const packaged = packageInfo.crateServerAssets === true;
	const [schema, releaseText, worker] = await Promise.all([
		readFile(join(root, packaged ? 'assets/schema.sql' : 'src/cloudflare/schema.sql'), 'utf8'),
		readFile(join(root, packaged ? 'assets/server-release.json' : 'src/cloudflare/server-release.json'), 'utf8'),
		readFile(join(root, packaged ? 'assets/worker.mjs' : '.generated/cloudflare/worker.mjs'), 'utf8').catch(() => {
			throw new Error('Build the server first with npm run build:worker.');
		}),
	]);
	const release = JSON.parse(releaseText);
	const runtimeVersion = packageInfo.crateServerRuntime ?? packageInfo.devDependencies.miniflare;
	const unlock = await lockLocalData(dataDir);
	let mf;
	const createRuntime = options => {
		// The CLI drains HTTP and storage even when interrupted during startup.
		// Miniflare's synchronous exit handlers would bypass that cleanup.
		const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
		const previous = new Map(signals.map(signal => [signal, process.listeners(signal)]));
		const instance = new Miniflare(convertV4MiniflareOptions(options));
		if (!handleSignals) for (const signal of signals) {
			for (const listener of process.listeners(signal)) {
				if (!previous.get(signal).includes(listener)) process.removeListener(signal, listener);
			}
		}
		return instance;
	};
	try {
		const metadataPath = join(dataDir, 'server.json');
		const previousText = await readFile(metadataPath, 'utf8').catch(error => {
			if (error.code === 'ENOENT') return null;
			throw error;
		});
		const previous = previousText === null ? null : JSON.parse(previousText);

    const expected = { schemaHash: digest(schema), runtimeVersion, serverRevision: release.revision };
    if (previousText !== null) {
      if (!upgradeBackup) assertCompatibleLocalMetadata(previous, expected);
      else {
        if (previous.schemaHash !== expected.schemaHash && !release.previousSchemas?.some(item => item.sha256 === previous.schemaHash)) throw new Error('No tested migration exists for this data directory.');
        assertCompatibleLocalMetadata({ ...previous, schemaHash: expected.schemaHash }, expected);
        const { backupLocalServer } = await import('./local-server-backup.mjs');
        await backupLocalServer(dataDir, upgradeBackup, true);
      }
    }

		if (previousText === null && (await readdir(dataDir)).some(name => !['server.lock', '.DS_Store'].includes(name))) {
			throw new Error('This directory contains data without server.json. Restore a complete backup or choose a new empty directory.');
		}
		const metadata = { format: 1, instanceId: previous?.instanceId ?? randomUUID(),
			schemaHash: digest(schema), runtimeVersion, serverRevision: release.revision };
		const options = {
			name: 'crate-local', modules: true, script: worker,
			compatibilityDate: '2026-08-18',
      compatibilityFlags: ['global_fetch_strictly_public'],
      serviceBindings: { READING_FETCH: { network: { allow: ['public'], deny: ['private', 'local', '100.64.0.0/10', '198.18.0.0/15', '192.0.0.0/24', '240.0.0.0/4'], tlsOptions: { trustBrowserCas: true } } } },
			host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
			resourcePersistencePath: join(dataDir, 'resources'),
			isolatedResourcePersistencePath: join(dataDir, 'isolated'),
			bindings: { CRATE_PUBLIC_ORIGIN: origin },
			d1Databases: { DB: 'crate-local-db' },
		};
		// Validate and initialize with no Durable Objects registered: overdue
		// alarms must not execute against an unverified database or during admin.
		mf = createRuntime(options);
		await mf.ready;
		const info = await (await mf.dispatchFetch(`${origin}/.well-known/crate`)).json();
		if (info.serverRevision !== release.revision || info.schemaVersion !== release.schemaVersion) {
			throw new Error('The Worker build is out of date. Run npm run build:worker before starting the server.');
		}
		let db = await mf.getD1Database('DB');
		const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
		if (tables.length === 0) {
			if (previous) throw new Error('The existing server database is missing. Restore a complete backup; refusing to create an empty replacement.');
			// Our versioned schema contains no triggers or semicolons in literals.
			// D1 batch initializes it atomically, including the schema marker.
			await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
		} else {
			if (!tables.some(table => table.name === 'crate_schema')) throw new Error('Refusing to initialize a non-empty, unrecognized database.');
			const marker = await db.prepare('SELECT version FROM crate_schema WHERE id = 1').first();
			if (upgradeBackup) await migrateLocalDatabase(db, root, packaged, release);
 else if (marker?.version !== release.schemaVersion) throw new Error('Unsupported local database schema. Run the stopped-server upgrade command with a new backup directory.');
		}
		await writePrivateJson(metadataPath, metadata);
		if (!administrative) {
			await mf.dispose();
			mf = createRuntime({ ...options,
				r2Buckets: { BUCKET: 'crate-local-files' },
				durableObjects: { REMINDER_ALARMS: { className: 'ReminderAlarm', useSQLite: true } },
				ratelimits: { NOTIFICATION_REQUEST_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } } },
			});
			await mf.ready;
			db = await mf.getD1Database('DB');
		}
		let closed = false;
		return { mf, db, dataDir, origin, async close() {
			if (closed) return;
			closed = true;
			await mf.dispose();
			await unlock();
		} };
	} catch (error) {
		await mf?.dispose();
		await unlock();
		throw error;
	}
}

async function writePrivateJson(path, value) {
	const temporary = `${path}.tmp`;
	const file = await open(temporary, 'w', 0o600);
	try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
	finally { await file.close(); }
	await rename(temporary, path);
}

export async function issueLocalDevice(db, name) {
	name = name?.trim();
	if (!name || name.length > 128) throw new Error('Provide a device name between 1 and 128 characters.');
	const token = randomBytes(32).toString('hex');
	const id = randomUUID();
	await db.prepare("INSERT INTO auth_tokens (id, token_hash, device_name, platform, scope) VALUES (?, ?, ?, 'self-hosted', 'vault')")
		.bind(id, digest(token), name).run();
	return { id, token };
}
