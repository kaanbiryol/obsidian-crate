import { assertLocalMigrationPath, migrateLocalDatabase } from './local-server-migrations.mjs';
import { watchRuntime } from './local-server-watchdog.mjs';
import { coordinatorPath, packaged, revocationPath, runtimeVersion, serverAssetPath, workerPath } from './assets.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { uptime as osUptime } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
/** @type {typeof import('miniflare')} */
const { Miniflare, convertV4MiniflareOptions } = await import(packaged
	? '../vendor/miniflare/dist/src/index.js' : 'miniflare');
/** @type {typeof import('../../../src/cloudflare/worker/auth/revocation.ts')} */
const { RESET_GENERATION_SQL, revokeCredential } = await import(pathToFileURL(revocationPath).href);
/** @type {typeof import('../../../src/cloudflare/worker/coordinator/coordinator.ts')} */
const { armReminderDispatcher, revokeCoordinatedCredential, sendHostAlert } = await import(pathToFileURL(coordinatorPath).href);

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
 * @typedef {{ get(key: string): Promise<{ body: AsyncIterable<Uint8Array> } | null> }} LocalR2Bucket
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
 * @property {(kind: string) => Promise<number>} alert Pushes a host alert; returns how many devices received it.
 * @property {Promise<never>} failed Rejects when a serving runtime stops responding; never settles for administrative runtimes.
 * @property {number} crashes Unexpected workerd exits Miniflare recovered from.
 * @property {RequestGate['request']} request Hold the result while using `mf` or `db`; a pause waits for it.
 * @property {() => Promise<() => Promise<void>>} pause Stops workerd once running requests finish, so its files
 * can be copied. The returned resume starts it again; a failed resume rejects `failed`.
 * @property {() => Promise<void>} close
 */

/** @typedef {ReturnType<typeof createRequestGate>} RequestGate */

/** Admits requests to the runtime. Closing waits for admitted ones and holds new ones
 * until it opens again.
 * @param {{ hold?: number, drain?: number }} [options] Milliseconds a new request waits
 * for a closed gate, and a closing gate waits for running requests. */
export function createRequestGate({ hold = 30_000, drain = 15_000 } = {}) {
	let running = 0;
	/** @type {Promise<void> | null} */
	let closed = null;
	let reopen = () => {};
	let idle = () => {};
	/** @param {Promise<unknown>} promise @param {number} ms */
	const within = async (promise, ms) => {
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(resolve, ms, false); })]); }
		finally { clearTimeout(timer); }
	};
	return {
		/** @returns {Promise<(() => void) | null>} A release, or null when the gate stayed closed too long. */
		async request() {
			while (closed) if (!await within(closed, hold)) return null;
			running++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--running === 0) idle();
			};
		},
		async close() {
			if (closed) throw new Error('The runtime is already paused.');
			closed = new Promise(resolve => { reopen = resolve; });
			if (running) await within(new Promise(resolve => { idle = () => resolve(undefined); }), drain);
			idle = () => {};
		},
		open() { closed = null; reopen(); },
	};
}

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
 * @param {string} [dataDir] The data directory being opened; omitted when checking a backup.
 */
export function assertCompatibleLocalMetadata(previous, expected, dataDir) {
	const compatible = previous && previous.format === 1 && Number.isSafeInteger(previous.serverRevision)
		&& previous.serverRevision >= 1 && typeof previous.instanceId === 'string' && previous.schemaHash === expected.schemaHash
		&& previous.serverRevision <= expected.serverRevision;
	if (compatible && dataDir && runtimeAdvances(previous.runtimeVersion, expected.runtimeVersion)) {
		throw new Error(`The server data in ${dataDir} was written by an older storage runtime. Stop the server and run upgrade with a new --output backup directory before starting. The update command and the Docker image do this for you.`);
	}
	if (!compatible || previous.runtimeVersion !== expected.runtimeVersion) {
		throw new Error(dataDir
			? `The server data in ${dataDir} is damaged or comes from a different Crate server version, so this version can't open it. To start fresh, choose another folder with --data-dir or move this one aside. To keep the data, run the version that created it. Don't edit server.json.`
			: "This backup is damaged or comes from a different Crate server version, so this version can't restore it. Restore it with the version that created it.");
	}
}

/** Whether `recorded` is an older Miniflare version than `current`, in semver order.
 * Anything that is not a plain semver version never advances.
 * @param {unknown} recorded @param {string} current */
export function runtimeAdvances(recorded, current) {
	const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
	const [a, b] = [pattern.exec(String(recorded)), pattern.exec(current)];
	if (!a || !b) return false;
	for (const i of [1, 2, 3]) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
	// A release follows its prereleases; prerelease identifiers compare as semver specifies.
	if (!a[4] || !b[4]) return Boolean(a[4]) && !b[4];
	const [x, y] = [a[4].split('.'), b[4].split('.')];
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const [p, q] = [String(x[i]), String(y[i])];
		if (p === q) continue;
		const [numericP, numericQ] = [/^\d+$/.test(p), /^\d+$/.test(q)];
		if (numericP && numericQ) return Number(p) < Number(q);
		return numericP === numericQ ? p < q : numericP;
	}
	return x.length < y.length;
}

/** Reads every current and retained file back through a new storage runtime and checks its
 * size and SHA-256, so a runtime that cannot read the old layout fails before it owns the data.
 * @param {LocalD1Database} db @param {LocalR2Bucket} bucket @param {string} backup */
async function assertReadableFiles(db, bucket, backup) {
	const page = 64;
	for (const [table, order] of [['files', 'portable_path'], ['file_versions', 'id']]) {
		/** @type {unknown} */
		let after = null;
		for (;;) {
			/** @type {{ results: { position: unknown, storage_key: string, hash: string, size: number }[] }} */
			const { results } = await db.prepare(`SELECT ${order} AS position, storage_key, hash, size FROM ${table}${after === null ? '' : ` WHERE ${order} > ?1`} ORDER BY ${order} LIMIT ${page}`)
				.bind(...(after === null ? [] : [after])).all();
			const unreadable = await Promise.all(results.map(async row => {
				const object = await bucket.get(row.storage_key);
				if (!object) return true;
				const hash = createHash('sha256');
				let size = 0;
				for await (const chunk of object.body) { hash.update(chunk); size += chunk.byteLength; }
				return size !== row.size || hash.digest('hex') !== row.hash;
			}));
			if (unreadable.includes(true)) {
				throw new Error(`After the storage runtime update, a stored file is missing or does not match its checksum, so the data was not upgraded and the previous release still opens it. The backup made before this check is at ${backup}.`);
			}
			if (results.length < page) break;
			after = results.at(-1)?.position;
		}
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

/** Every running process, or null where processes cannot be listed.
 * @returns {Promise<{ pid: number, ppid: number, name: string }[] | null>} */
async function listProcesses() {
	/** @type {{ pid: number, ppid: number, name: string }[]} */
	let processes;
	try {
		if (process.platform === 'linux') {
			processes = [];
			for (const entry of await readdir('/proc')) {
				if (!/^\d+$/.test(entry)) continue;
				// `pid (comm) state ppid ...`; comm may contain spaces and parentheses.
				const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => null);
				const match = stat && /^(\d+) \((.*)\) \S+ (\d+)/s.exec(stat);
				if (match) processes.push({ pid: Number(match[1]), name: match[2], ppid: Number(match[3]) });
			}
		} else if (process.platform === 'darwin') {
			const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
			processes = stdout.split('\n').flatMap(line => {
				const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
				return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), name: basename(match[3].trim()) }] : [];
			});
		} else return null;
	} catch { return null; }
	return processes;
}

/** Whether a process has files open under `directory`, or null when that cannot be read.
 * @param {number} pid @param {string} directory @returns {Promise<boolean | null>} */
async function processUsesDirectory(pid, directory) {
	const inside = (/** @type {string} */ path) => path === directory || path.startsWith(`${directory}/`);
	try {
		if (process.platform === 'linux') {
			const fds = await readdir(`/proc/${pid}/fd`);
			const paths = await Promise.all(fds.map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')));
			return paths.some(inside);
		}
		if (process.platform === 'darwin') {
			// lsof exits 1 when it lists nothing for a running process.
			/** @type {string} */
			const stdout = await promisify(execFile)('lsof', ['-w', '-Fn', '-p', String(pid)]).then(result => result.stdout, error => {
				if (error.code === 1 && typeof error.stdout === 'string') return error.stdout;
				throw error;
			});
			return stdout.split('\n').some(line => line.startsWith('n') && inside(line.slice(1)));
		}
	} catch { /* Unreadable: the caller assumes it may use the directory. */ }
	return null;
}

/** Running workerd processes that lost their parent, or null where processes cannot be
 * listed. A force-quit server leaves its workerd running on the same files, adopted by
 * init or a subreaper. Workerd whose parent is a live Node process belongs to another
 * server or tool that still runs, never to the dead lock holder. With `dataDir`, only
 * workerd with files open in its storage counts, so another server's leftover runtime
 * never blocks this one; one whose files cannot be read still counts.
 * @param {string} [dataDir] @returns {Promise<number[] | null>} */
async function otherWorkerdProcesses(dataDir) {
	const processes = await listProcesses();
	if (!processes) return null;
	const names = new Map(processes.map(entry => [entry.pid, entry.name]));
	const orphans = processes.filter(entry => entry.name === 'workerd' && names.get(entry.ppid) !== 'node').map(entry => entry.pid);
	if (dataDir === undefined || !orphans.length) return orphans;
	const storage = join(await realpath(dataDir).catch(() => resolve(dataDir)), 'resources');
	const uses = await Promise.all(orphans.map(pid => processUsesDirectory(pid, storage)));
	return orphans.filter((_, index) => uses[index] !== false);
}

/** The workerd processes a server started on its data directory (`workerd.json`), so a
 * start after a force-quit can stop the ones it left running there.
 * @typedef {{ serverPid: number, workerd: number[] }} WorkerdRecord */
const WORKERD_RECORD = 'workerd.json';

/** Records this process's workerd children. Miniflare starts a new one on each restart.
 * @param {string} dataDir */
async function recordWorkerd(dataDir) {
	const processes = await listProcesses();
	if (!processes) return;
	const workerd = processes.filter(entry => entry.name === 'workerd' && entry.ppid === process.pid).map(entry => entry.pid);
	await writePrivateJson(join(dataDir, WORKERD_RECORD), { serverPid: process.pid, workerd });
}

/** @param {string} dataDir @returns {Promise<WorkerdRecord | null>} */
async function readWorkerdRecord(dataDir) {
	try {
		const record = JSON.parse(await readFile(join(dataDir, WORKERD_RECORD), 'utf8'));
		return Number.isSafeInteger(record?.serverPid) && Array.isArray(record.workerd) ? record : null;
	} catch { return null; }
}

/** Asks processes to stop, then kills those that keep running.
 * @param {number[]} pids @returns {Promise<boolean>} True once all have exited. */
async function stopProcesses(pids) {
	/** @param {NodeJS.Signals} signal */
	const send = signal => { for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } } };
	/** @param {number} ms */
	const exited = async ms => {
		for (const deadline = Date.now() + ms; pids.some(pidIsRunning);) {
			if (Date.now() > deadline) return false;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return true;
	};
	send('SIGTERM');
	if (await exited(10_000)) return true;
	send('SIGKILL');
	return exited(5_000);
}

/** Without a reboot, a lock is stale once its process is gone and no workerd it may
 * have started is still running. Workerd the dead server recorded as its own is
 * stopped first. Throws while any other may still use the data.
 * @param {string} text
 * @param {{ isRunning?: (pid: number) => boolean, listWorkerd?: () => Promise<number[] | null>,
 * 	record?: WorkerdRecord | null, stop?: (pids: number[]) => Promise<boolean> }} [options] */
export async function isAbandonedLock(text, { isRunning = pidIsRunning, listWorkerd = otherWorkerdProcesses, record = null, stop = stopProcesses } = {}) {
	/** @type {ServerLock} */
	let lock;
	try { lock = JSON.parse(text); } catch { return false; }
	if (!Number.isSafeInteger(lock?.pid) || isRunning(lock.pid)) return false;
	let workerd = await listWorkerd();
	if (workerd === null) return false;
	// Only workerd that lost its parent and that the dead lock holder recorded is stopped.
	const owned = record?.serverPid === lock.pid ? workerd.filter(pid => record.workerd.includes(pid)) : [];
	if (owned.length) {
		if (!await stop(owned)) throw new Error(`Data directory is locked by a Crate server that was force-quit, and its workerd did not stop (PID ${owned.join(', ')}). Stop it with: kill -9 ${owned.join(' ')}. Then start Crate again.`);
		console.warn(`Stopped workerd left running by a force-quit Crate server (PID ${owned.join(', ')}).`);
		workerd = workerd.filter(pid => !owned.includes(pid));
	}
	if (workerd.length) {
		throw new Error(`Data directory is locked by a Crate server that was force-quit, and workerd it may have started is still running without it (PID ${workerd.join(', ')}). Stop it with: kill ${workerd.join(' ')}. Then start Crate again.`);
	}
	return true;
}

/** @param {string} dataDir @param {Parameters<typeof isAbandonedLock>[1]} [options]
 * @returns {Promise<() => Promise<void>>} Releases the lock. */
export async function lockLocalData(dataDir, options) {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, 'server.lock');
	const locked = () => new Error(`Data directory is locked. Stop its Crate server first. After a crash, verify no Crate/workerd process uses this directory before removing ${path}.`);
	/** @type {import('node:fs/promises').FileHandle | undefined} */
	let handle;
	for (let attempt = 0; !handle; attempt++) {
		try { handle = await open(path, 'wx', 0o600); }
		catch (error) {
			if (error.code !== 'EEXIST') throw error;
			const previous = await readFile(path, 'utf8').catch(() => '');
			if (attempt === 0 && (isLockFromEarlierBoot(previous) || await isAbandonedLock(previous, { record: await readWorkerdRecord(dataDir), listWorkerd: () => otherWorkerdProcesses(dataDir), ...options }))) {
				if (!await removeStaleLock(path, previous)) throw locked();
				continue;
			}
			throw locked();
		}
	}
	const lock = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
	await handle.writeFile(lock);
	await handle.close();
	// Another start may have taken the lock over after a crash; only our own is removed.
	return async () => { if (await readFile(path, 'utf8').catch(() => null) === lock) await unlink(path); };
}

/** Removes the stale lock that was checked, not one another start wrote after removing it first.
 * Moving it aside is atomic, so only one start can take each lock file.
 * @param {string} path @param {string} previous @returns {Promise<boolean>} False when another start owns the lock. */
async function removeStaleLock(path, previous) {
	const claimed = `${path}.stale-${randomUUID()}`;
	try { await rename(path, claimed); }
	catch (error) { if (error.code === 'ENOENT') return true; throw error; }
	try {
		if (await readFile(claimed, 'utf8') === previous) return true;
		await link(claimed, path).catch(() => {});
		return false;
	} finally { await unlink(claimed).catch(() => {}); }
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.origin]
 * @param {boolean} [options.administrative] Registers no Durable Objects, so no alarm runs.
 * @param {boolean} [options.handleSignals] Keeps Miniflare's own signal handlers.
 * @param {string} [options.upgradeBackup] Migrates the database after backing up here.
 * @param {boolean} [options.reuseUpgradeBackup] Keeps a complete backup already at `upgradeBackup`.
 * @param {number} [options.maxFileBytes] Largest synced file; the Worker's default when unset.
 * @returns {Promise<LocalRuntime>}
 */
export async function openLocalRuntime({ dataDir, origin = 'http://localhost:8787', administrative = false, handleSignals = true, upgradeBackup, reuseUpgradeBackup = false, maxFileBytes }) {
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
	// Best effort: without a record, a force-quit still leaves the manual kill.
	const record = () => recordWorkerd(dataDir).catch(() => {});
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
    // Set when upgrade opens data written by an older Miniflare, which this start verifies before recording.
    let runtimeUpgrade = false;
    let usedBackup = '';
    if (previousText !== null) {
      // Damaged metadata (`null` included) fails the same way with or without an upgrade.
      if (!upgradeBackup || !previous) assertCompatibleLocalMetadata(previous, expected, dataDir);
      else {
        const current = /** @type {ServerMetadata} */ (previous);
        if (current.schemaHash !== expected.schemaHash) assertLocalMigrationPath(current.schemaVersion, release);
        runtimeUpgrade = runtimeAdvances(current.runtimeVersion, runtimeVersion);
        assertCompatibleLocalMetadata({ ...current, schemaHash: expected.schemaHash, ...(runtimeUpgrade ? { runtimeVersion } : {}) }, expected, dataDir);
        const { backupLocalServer, prepareMigrationBackup } = await import('./local-server-backup.mjs');
        // A retried migration keeps the backup taken before its first attempt while it still holds this data.
        usedBackup = reuseUpgradeBackup ? await prepareMigrationBackup(dataDir, upgradeBackup)
          : await backupLocalServer(dataDir, upgradeBackup, { alreadyLocked: true });
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
			bindings: { CRATE_PUBLIC_ORIGIN: origin, CRATE_DEPLOYMENT_FINGERPRINT: localDeploymentFingerprint({ worker, schema, release }),
				...(maxFileBytes ? { CRATE_MAX_FILE_BYTES: String(maxFileBytes) } : {}) },
			d1Databases: { [bindings.database]: 'crate-local-db' },
			...(runtimeUpgrade ? { r2Buckets: { [bindings.bucket]: 'crate-local-files' } } : {}),
		};
		// Validate and initialize with no Durable Objects registered: overdue
		// alarms must not execute against an unverified database or during admin.
		mf = createRuntime(options);
		await mf.ready;
		await record();
		const info = /** @type {{ serverRevision?: unknown, schemaVersion?: unknown }} */ (await (await mf.dispatchFetch(`${origin}/.well-known/crate`)).json());
		if (info.serverRevision !== release.revision || info.schemaVersion !== release.schemaVersion) {
			throw new Error('The Worker build is out of date. Run npm run build:worker before starting the server.');
		}
		/** @type {LocalD1Database} */
		let db = await mf.getD1Database(bindings.database);
		await assertIntactDatabase(db);
		const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
		if (tables.length === 0) {
			if (previous) throw new Error('The existing server database is missing. Restore a complete backup; refusing to create an empty replacement.');
			// Our versioned schema contains no triggers or semicolons in literals.
			// D1 batch initializes it atomically, including the schema marker.
			await db.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
		} else {
			if (!tables.some(table => table.name === 'crate_schema')) throw new Error('Refusing to initialize a non-empty, unrecognized database.');
			const marker = await db.prepare('SELECT version FROM crate_schema WHERE id = 1').first();
			// Before any migration and before server.json records the new runtime, so a failed check
			// leaves the data as the previous release wrote it.
			if (runtimeUpgrade) await assertReadableFiles(db, /** @type {LocalR2Bucket} */ (/** @type {unknown} */ (await mf.getR2Bucket(bindings.bucket))), usedBackup);
			if (upgradeBackup) await migrateLocalDatabase(db, release);
 else if (marker?.version !== release.schemaVersion) throw new Error('Unsupported local database schema. Run the stopped-server upgrade command with a new backup directory.');
		}
		await writePrivateJson(metadataPath, metadata);
		let crashes = 0;
		/** @type {() => Promise<void>} */
		let wakeReminders = async () => {};
		const serving = { ...options,
			r2Buckets: { [bindings.bucket]: 'crate-local-files' },
			durableObjects: { [bindings.reminderAlarms]: { className: durableObjectClass, useSQLite: true } },
			ratelimits: { [bindings.notificationRateLimiter]: { namespace_id: '1001', simple: notificationRateLimit } },
			// Miniflare restarted a crashed workerd; reminders may have come due meanwhile.
			unsafeHandleRuntimeRestart: async () => { crashes++; await record(); await wakeReminders(); },
		};
		if (!administrative) {
			await mf.dispose();
			mf = createRuntime(serving);
			await mf.ready;
			await record();
			db = await mf.getD1Database(bindings.database);
		}
		let live = /** @type {import('miniflare').Miniflare} */ (mf);
		// Miniflare types the namespace with workers types this repository does not install.
		const alarms = async () => ({ REMINDER_ALARMS: /** @type {DurableObjectNamespace} */ (/** @type {unknown} */ (
			await live.getDurableObjectNamespace(bindings.reminderAlarms))) });
		let closed = false;
		let disposed = false;
		// Administrative runtimes register no Durable Objects, so they revoke directly.
		/** @type {(id: string) => Promise<boolean>} */
		const revoke = administrative ? id => revokeCredential(db, id) : async id => revokeCoordinatedCredential(await alarms(), id);
		/** @type {(error: unknown) => void} */
		let fail = () => {};
		/** @type {Promise<never>} */
		const failed = new Promise((_, reject) => { fail = reject; });
		failed.catch(() => {});
		/** @type {ReturnType<typeof watchRuntime> | undefined} */
		let watchdog;
		const watch = () => {
			watchdog = watchRuntime({ async probe(signal) {
				const response = await live.dispatchFetch(`${origin}/.well-known/crate`, { signal });
				await response.arrayBuffer();
				if (!response.ok) throw new Error(`health check returned ${response.status}`);
			} });
			watchdog.failed.catch(fail);
		};
		if (!administrative) {
			// Otherwise only a commit or enabling Reminders arms delivery, so a reminder that
			// came due while the server was down would wait for the next sync.
			wakeReminders = async () => {
				if (!await armReminderDispatcher(await alarms())) console.warn('Could not wake reminder delivery. It resumes with the next sync.');
			};
			await wakeReminders();
			watch();
		}
		const gate = createRequestGate();
		/** @type {(kind: string) => Promise<number>} */
		const alert = async kind => {
			if (administrative) throw new Error('Alerts need the serving runtime.');
			return sendHostAlert(await alarms(), kind);
		};
		return { get mf() { return live; }, get db() { return db; }, dataDir, origin, revoke, alert, failed,
			get crashes() { return crashes; },
			request: gate.request,
			async pause() {
				if (administrative) return async () => {};
				await gate.close();
				watchdog?.close();
				disposed = true;
				await live.dispose();
				return async () => {
					try {
						if (closed) return;
						const next = createRuntime(serving);
						await next.ready;
						await record();
						if (closed) { await next.dispose(); return; }
						live = next;
						db = await next.getD1Database(bindings.database);
						disposed = false;
						await wakeReminders();
						watch();
					} catch (error) {
						fail(new Error(`The Workers runtime could not restart after a backup (${error instanceof Error ? error.message : String(error)}). Crate is stopping so its service manager can restart it.`, { cause: error }));
						throw error;
					} finally { gate.open(); }
				};
			},
			async close() {
				if (closed) return;
				closed = true;
				watchdog?.close();
				if (!disposed) await live.dispose();
				await unlink(join(dataDir, WORKERD_RECORD)).catch(() => {});
				await unlock();
			} };
	} catch (error) {
		await mf?.dispose();
		await unlink(join(dataDir, WORKERD_RECORD)).catch(() => {});
		await unlock();
		throw error;
	}
}

/** Refuses to serve, migrate or administer a damaged database. Recovery is a complete
 * backup or a rebuild from devices, never an automatic repair or reset.
 * @param {LocalD1Database} db */
async function assertIntactDatabase(db) {
	/** @type {unknown} */
	let problem;
	try {
		// D1 permits quick_check but not integrity_check.
		const { results } = await db.prepare('PRAGMA quick_check').all();
		if (results.length !== 1 || Object.values(results[0])[0] !== 'ok') problem = results.map(row => String(Object.values(row)[0]).replace(/\s+/g, ' ')).slice(0, 3).join('; ');
	} catch (error) { problem = error instanceof Error ? error.message : String(error); }
	if (problem !== undefined) {
		throw new Error(`The server database failed its integrity check (${problem}). Keep this data directory unchanged, then restore a complete backup into a new directory or rebuild from your devices; see "If the server is lost" in the self-hosting guide.`);
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
