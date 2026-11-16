import { assertLocalMigrationPath, migrateLocalDatabase } from './local-server-migrations.mjs';
import { coordinatorPath, packaged, revocationPath, runtimeVersion, serverAssetPath, workerPath } from './assets.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { uptime as osUptime } from 'node:os';
import { pathToFileURL } from 'node:url';
/** @type {typeof import('miniflare')} */
const { Miniflare, convertV4MiniflareOptions } = await import(packaged
	? '../vendor/miniflare/dist/src/index.js' : 'miniflare');
/** @type {typeof import('../../../src/cloudflare/worker/auth/revocation.ts')} */
const { RESET_GENERATION_SQL, revokeCredential } = await import(pathToFileURL(revocationPath).href);
/** @type {typeof import('../../../src/cloudflare/worker/coordinator/coordinator.ts')} */
const { revokeCoordinatedCredential } = await import(pathToFileURL(coordinatorPath).href);

/**
 * The D1 subset the server uses. Miniflare types its bindings with workers types this
 * repository does not install. Rows stay untyped because JavaScript callers cannot pass
 * a row type; declare the columns where a row is read.
 * @typedef {any} D1Row
 * @typedef {{
 * 	bind(...values: unknown[]): LocalD1Statement,
 * 	first(): Promise<D1Row | null>,
 * 	run(): Promise<{ meta: { changes: number } }>,
 * 	all(): Promise<{ results: D1Row[] }>,
 * }} LocalD1Statement
 * @typedef {{
 * 	prepare(query: string): LocalD1Statement,
 * 	batch<T = unknown>(statements: LocalD1Statement[]): Promise<T[]>,
 * 	exec(query: string): Promise<unknown>,
 * }} LocalD1Database
 */

/**
 * The Worker's binding names and runtime settings (`src/cloudflare/worker-runtime.json`).
 * @typedef {object} WorkerRuntimeConfig
 * @property {string} compatibilityDate
 * @property {string[]} compatibilityFlags
 * @property {{ database: string, bucket: string, reminderAlarms: string, notificationRateLimiter: string }} bindings
 * @property {string} durableObjectClass
 * @property {{ limit: number, period: 10 | 60 }} notificationRateLimit
 */

/**
 * The release manifest (`src/cloudflare/server-release.json`).
 * @typedef {import('../../../src/cloudflare/deployment/database-upgrade-rules.ts').DatabaseRelease} ServerRelease
 */

/**
 * What a data directory was last opened with (`server.json`).
 * @typedef {object} ServerMetadata
 * @property {number} format
 * @property {string} instanceId
 * @property {string} schemaHash
 * @property {number} schemaVersion
 * @property {string} runtimeVersion
 * @property {number} serverRevision
 */

/** The owner of a data directory lock (`server.lock`).
 * @typedef {{ pid: number, startedAt: string }} ServerLock */

/**
 * An open data directory. `close` disposes Miniflare, then releases the lock.
 * @typedef {object} LocalRuntime
 * @property {import('miniflare').Miniflare} mf
 * @property {LocalD1Database} db
 * @property {string} dataDir
 * @property {string} origin
 * @property {(id: string) => Promise<boolean>} revoke
 * @property {() => Promise<void>} close
 */

/** @param {string} value */
const digest = value => createHash('sha256').update(value).digest('hex');

// Miniflare's default outbound service permits private networks even when the
// Worker uses global_fetch_strictly_public. Enforce the boundary natively for
// both explicit article/title fetches and any other Worker fetch (such as push).
/** @returns {Pick<import('miniflare').V4WorkerOptionsShape, 'outboundService' | 'serviceBindings'>} */
export function localNetworkOptions() {
	const publicNetwork = { network: { allow: ['public'], deny: ['private', 'local', '100.64.0.0/10', '198.18.0.0/15', '192.0.0.0/24', '240.0.0.0/4'], tlsOptions: { trustBrowserCas: true } } };
	return {
		// The v5 adapter does not accept a network as outboundService. Forward
		// through its supported hook to the same native network binding instead.
		outboundService: async (request, runtime) => (/** @type {{ READING_FETCH: { fetch(request: import('miniflare').Request): Promise<import('miniflare').Response> } }} */ (await runtime.getBindings())).READING_FETCH.fetch(request),
		serviceBindings: { READING_FETCH: publicNetwork },
	};
}

export async function localBuildInfo() {
	const [schema, releaseText] = await Promise.all([
		readFile(serverAssetPath('schema.sql'), 'utf8'),
		readFile(serverAssetPath('server-release.json'), 'utf8'),
	]);
	/** @type {ServerRelease} */
	const release = JSON.parse(releaseText);
	return { runtimeVersion,
		schemaHash: digest(schema), serverRevision: release.revision, release };
}

/** Matches the plugin's embedded artifact fingerprint (scripts/vite/cloudflare-artifacts-vite-plugin.mjs),
 * so a connected plugin can tell whether this server runs the build it bundles. */
/** @param {{ worker: string, schema: string, release: ServerRelease }} build */
function localDeploymentFingerprint({ worker, schema, release }) {
	return digest(JSON.stringify({ workerBundleSha256: digest(worker), d1SchemaSha256: digest(schema), serverRelease: release }));
}

/**
 * @param {ServerMetadata | null | undefined} previous
 * @param {Pick<ServerMetadata, 'schemaHash' | 'runtimeVersion' | 'serverRevision'>} expected
 */
export function assertCompatibleLocalMetadata(previous, expected) {
	if (!previous || previous.format !== 1 || !Number.isSafeInteger(previous.serverRevision)
		|| previous.serverRevision < 1 || typeof previous.instanceId !== 'string' || previous.schemaHash !== expected.schemaHash
		|| previous.runtimeVersion !== expected.runtimeVersion || previous.serverRevision > expected.serverRevision) {
		throw new Error('This data directory requires a matching schema/runtime and an equal or newer server revision. Keep the previous installation and backup; this change requires a tested migration. Do not edit server.json.');
	}
}

/** @param {string} value */
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
/** A lock is left over from an earlier boot only when it predates this boot and its
 * process is gone. Both are required: a clock corrected after boot can make a live
 * server's lock look old, and a reused process ID keeps a stale one. Every
 * process from before a restart has exited, so no workerd can still use the data.
 * @param {string} text
 * @param {{ now?: number, uptime?: number, isRunning?: (pid: number) => boolean }} [options] */
export function isLockFromEarlierBoot(text, { now = Date.now(), uptime = osUptime(), isRunning = pidIsRunning } = {}) {
	/** @type {ServerLock} */
	let lock;
	try { lock = JSON.parse(text); } catch { return false; }
	const startedAt = Date.parse(lock?.startedAt);
	return Number.isSafeInteger(lock?.pid) && Number.isFinite(startedAt)
		&& startedAt < now - uptime * 1000 && !isRunning(lock.pid);
}

/** @param {number} pid */
function pidIsRunning(pid) {
	try { process.kill(pid, 0); return true; }
	catch (error) { return error.code !== 'ESRCH'; }
}

/** @param {string} dataDir @returns {Promise<() => Promise<void>>} Releases the lock. */
export async function lockLocalData(dataDir) {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, 'server.lock');
	/** @type {import('node:fs/promises').FileHandle | undefined} */
	let handle;
	for (let attempt = 0; !handle; attempt++) {
		try { handle = await open(path, 'wx', 0o600); }
		catch (error) {
			if (error.code !== 'EEXIST') throw error;
			const previous = await readFile(path, 'utf8').catch(() => '');
			if (attempt === 0 && isLockFromEarlierBoot(previous)) { await unlink(path).catch(() => {}); continue; }
			throw new Error(`Data directory is locked. Stop its Crate server first. After a crash, verify no Crate/workerd process uses this directory before removing ${path}.`);
		}
	}
	await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
	await handle.close();
	return () => unlink(path);
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.origin]
 * @param {boolean} [options.administrative] Registers no Durable Objects, so no alarm runs.
 * @param {boolean} [options.handleSignals] Keeps Miniflare's own signal handlers.
 * @param {string} [options.upgradeBackup] Migrates the database after backing up here.
 * @returns {Promise<LocalRuntime>}
 */
export async function openLocalRuntime({ dataDir, origin = 'http://localhost:8787', administrative = false, handleSignals = true, upgradeBackup }) {
	dataDir = resolve(dataDir);
	origin = normalizeLocalOrigin(origin);
	const [schema, releaseText, runtimeText, worker] = await Promise.all([
		readFile(serverAssetPath('schema.sql'), 'utf8'),
		readFile(serverAssetPath('server-release.json'), 'utf8'),
		readFile(serverAssetPath('worker-runtime.json'), 'utf8'),
		readFile(workerPath, 'utf8').catch(() => {
			throw new Error('Build the server first with npm run build:worker.');
		}),
	]);
	/** @type {ServerRelease} */
	const release = JSON.parse(releaseText);
	/** @type {WorkerRuntimeConfig} */
	const { compatibilityDate, compatibilityFlags, bindings, durableObjectClass, notificationRateLimit } = JSON.parse(runtimeText);
	const unlock = await lockLocalData(dataDir);
	/** @type {import('miniflare').Miniflare | undefined} */
	let mf;
	/** @param {import('miniflare').V4MiniflareOptions} options */
	const createRuntime = options => {
		// The CLI drains HTTP and storage even when interrupted during startup.
		// Miniflare's synchronous exit handlers would bypass that cleanup.
		const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
		const previous = new Map(signals.map(signal => [signal, process.listeners(signal)]));
		const instance = new Miniflare(convertV4MiniflareOptions(options));
		if (!handleSignals) for (const signal of signals) {
			for (const listener of process.listeners(signal)) {
				if (!/** @type {Function[]} */ (previous.get(signal)).includes(listener)) process.removeListener(signal, listener);
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
		/** @type {ServerMetadata | null} */
		const previous = previousText === null ? null : JSON.parse(previousText);

    const expected = { schemaHash: digest(schema), runtimeVersion, serverRevision: release.revision };
    if (previousText !== null) {
      if (!upgradeBackup) assertCompatibleLocalMetadata(previous, expected);
      else {
        const current = /** @type {ServerMetadata} */ (previous);
        if (current.schemaHash !== expected.schemaHash) assertLocalMigrationPath(current.schemaVersion, release);
        assertCompatibleLocalMetadata({ ...current, schemaHash: expected.schemaHash }, expected);
        const { backupLocalServer } = await import('./local-server-backup.mjs');
        await backupLocalServer(dataDir, upgradeBackup, true);
      }
    }

		if (previousText === null && (await readdir(dataDir)).some(name => !['server.lock', '.DS_Store'].includes(name))) {
			throw new Error('This directory contains data without server.json. Restore a complete backup or choose a new empty directory.');
		}
		const metadata = { format: 1, instanceId: previous?.instanceId ?? randomUUID(),
			schemaHash: digest(schema), schemaVersion: release.schemaVersion, runtimeVersion, serverRevision: release.revision };
		const options = {
			name: 'crate-local', modules: true, script: worker,
			compatibilityDate, compatibilityFlags,
			...localNetworkOptions(),
			host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
			resourcePersistencePath: join(dataDir, 'resources'),
			isolatedResourcePersistencePath: join(dataDir, 'isolated'),
			bindings: { CRATE_PUBLIC_ORIGIN: origin, CRATE_DEPLOYMENT_FINGERPRINT: localDeploymentFingerprint({ worker, schema, release }) },
			d1Databases: { [bindings.database]: 'crate-local-db' },
		};
		// Validate and initialize with no Durable Objects registered: overdue
		// alarms must not execute against an unverified database or during admin.
		mf = createRuntime(options);
		await mf.ready;
		const info = /** @type {{ serverRevision?: unknown, schemaVersion?: unknown }} */ (await (await mf.dispatchFetch(`${origin}/.well-known/crate`)).json());
		if (info.serverRevision !== release.revision || info.schemaVersion !== release.schemaVersion) {
			throw new Error('The Worker build is out of date. Run npm run build:worker before starting the server.');
		}
		/** @type {LocalD1Database} */
		let db = await mf.getD1Database(bindings.database);
		const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
		if (tables.length === 0) {
			if (previous) throw new Error('The existing server database is missing. Restore a complete backup; refusing to create an empty replacement.');
			// Our versioned schema contains no triggers or semicolons in literals.
			// D1 batch initializes it atomically, including the schema marker.
			await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
		} else {
			if (!tables.some(table => table.name === 'crate_schema')) throw new Error('Refusing to initialize a non-empty, unrecognized database.');
			const marker = await db.prepare('SELECT version FROM crate_schema WHERE id = 1').first();
			if (upgradeBackup) await migrateLocalDatabase(db, release);
 else if (marker?.version !== release.schemaVersion) throw new Error('Unsupported local database schema. Run the stopped-server upgrade command with a new backup directory.');
		}
		await writePrivateJson(metadataPath, metadata);
		if (!administrative) {
			await mf.dispose();
			mf = createRuntime({ ...options,
				r2Buckets: { [bindings.bucket]: 'crate-local-files' },
				durableObjects: { [bindings.reminderAlarms]: { className: durableObjectClass, useSQLite: true } },
				ratelimits: { [bindings.notificationRateLimiter]: { namespace_id: '1001', simple: notificationRateLimit } },
			});
			await mf.ready;
			db = await mf.getD1Database(bindings.database);
		}
		let closed = false;
		// Administrative runtimes register no Durable Objects, so they revoke directly.
		/** @type {(id: string) => Promise<boolean>} */
		const revoke = administrative ? id => revokeCredential(db, id)
			// Miniflare types the namespace with workers types this repository does not install.
			: async id => revokeCoordinatedCredential({ REMINDER_ALARMS: /** @type {DurableObjectNamespace} */ (/** @type {unknown} */ (
				await /** @type {import('miniflare').Miniflare} */ (mf).getDurableObjectNamespace(bindings.reminderAlarms))) }, id);
		return { mf, db, dataDir, origin, revoke, async close() {
			if (closed) return;
			closed = true;
			await /** @type {import('miniflare').Miniflare} */ (mf).dispose();
			await unlock();
		} };
	} catch (error) {
		await mf?.dispose();
		await unlock();
		throw error;
	}
}

/** @param {string} path @param {unknown} value */
async function writePrivateJson(path, value) {
	const temporary = `${path}.tmp`;
	const file = await open(temporary, 'w', 0o600);
	try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
	finally { await file.close(); }
	await rename(temporary, path);
}

/** @param {LocalD1Database} db @returns {Promise<string>} */
export async function readResetGeneration(db) {
	const row = await db.prepare('SELECT reset_generation AS generation FROM server_state WHERE id = 1').first();
	return row?.generation ?? '';
}

/** With `resetGeneration`, the device is added only while no encryption reset has
 * happened since it was read, as the Worker's pairing does. Returns null otherwise.
 * @param {LocalD1Database} db
 * @param {string | undefined} name
 * @param {string} [resetGeneration]
 * @returns {Promise<{ id: string, token: string } | null>} */
export async function issueLocalDevice(db, name, resetGeneration) {
	name = name?.trim();
	if (!name || name.length > 128) throw new Error('Provide a device name between 1 and 128 characters.');
	const token = randomBytes(32).toString('hex');
	const id = randomUUID();
	if (resetGeneration === undefined) {
		await db.prepare("INSERT INTO auth_tokens (id, token_hash, device_name, platform, scope) VALUES (?, ?, ?, 'self-hosted', 'vault')")
			.bind(id, digest(token), name).run();
		return { id, token };
	}
	const result = await db.prepare(`INSERT INTO auth_tokens (id, token_hash, device_name, platform, scope)
		SELECT ?, ?, ?, 'self-hosted', 'vault' WHERE ${RESET_GENERATION_SQL} = ?`)
		.bind(id, digest(token), name, resetGeneration).run();
	return result.meta.changes === 1 ? { id, token } : null;
}

/**
 * A credential row as the devices command and control socket report it.
 * @typedef {object} LocalDevice
 * @property {string} id
 * @property {string | null} name
 * @property {string | null} platform
 * @property {string} scope
 * @property {string} createdAt
 * @property {string | null} lastSeenAt
 */

/** Every credential the server holds, newest activity first. Shortcut capture
 * credentials are listed too; revoking their issuing device removes them.
 * @param {LocalD1Database} db
 * @returns {Promise<LocalDevice[]>} */
export async function listLocalDevices(db) {
	const { results } = await db.prepare(`SELECT id, device_name AS name, platform, scope, created_at AS createdAt, last_seen_at AS lastSeenAt
		FROM auth_tokens ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC`).all();
	return results;
}

/** The Worker's device revocation: the credential, its push subscriptions and the
 * shortcut capture credentials it issued go together. A running server revokes under
 * the coordinator lock, like the Worker, so no request the credential authenticated
 * there commits after this returns.
 * @param {Pick<LocalRuntime, 'revoke'>} runtime
 * @param {unknown} id */
export async function revokeLocalDevice(runtime, id) {
	if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('Provide --id with a token ID from the devices command.');
	return runtime.revoke(id);
}
