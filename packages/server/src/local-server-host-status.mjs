// What this computer reports to connected devices about itself: how Crate was installed,
// when it started and last backed up, and whether its public address works. It is written
// to `maintenance_state` (key HOST_STATUS_KEY in src/protocol/host-status.ts), where the
// Worker's /server/host-status route reads it with the device's own authorization.
// Paths and error text stay on this computer.
import { statfs } from 'node:fs/promises';
import { readLastBackup } from './local-server-backup.mjs';

const HOST_STATUS_KEY = 'crate_host_status';

/** @param {string} path @returns {Promise<number | null>} */
export async function freeBytes(path) {
	try { const stats = await statfs(path); return Number(stats.bavail) * Number(stats.bsize); }
	catch { return null; }
}

/**
 * @typedef {object} HostStatusRecord
 * @property {import('./local-server-install.mjs').InstallKind} install
 * @property {string} startedAt
 * @property {string | null} lastBackupAt
 * @property {{ on: boolean, lastFailureAt: string | null }} autoBackup
 * @property {'ready' | 'waiting' | null} publicAccess
 * @property {number | null} diskFreeBytes
 */

/**
 * @param {object} options
 * @param {Pick<import('./local-server-runtime.mjs').LocalRuntime, 'request' | 'db'>} options.runtime
 * @param {string} options.dataDir
 * @param {import('./local-server-install.mjs').InstallKind} options.install
 * @param {boolean} options.public Whether an HTTPS address is being checked.
 * @param {() => Promise<{ settings: { dir: string } | null, lastFailure: { at: string } | null }>} options.autoBackup
 * @param {(bytes: number | null) => void} [options.onDisk] Free space on the fuller of the data and backup disks.
 * @param {() => Date} [options.now]
 */
export function createHostStatus({ runtime, dataDir, install, public: isPublic, autoBackup, onDisk = () => {}, now = () => new Date() }) {
	/** @type {HostStatusRecord} */
	const record = { install, startedAt: now().toISOString(), lastBackupAt: null, autoBackup: { on: false, lastFailureAt: null },
		publicAccess: isPublic ? 'waiting' : null, diskFreeBytes: null };
	let queue = Promise.resolve();

	async function write() {
		// A backup pauses the runtime; the write waits for it to resume.
		const release = await runtime.request();
		if (!release) return;
		try {
			await runtime.db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
				.bind(HOST_STATUS_KEY, JSON.stringify(record)).run();
		} finally { release(); }
	}

	return {
		record,
		/** Rereads backups and disk space, applies `patch`, and writes the record in order.
		 * @param {Partial<Pick<HostStatusRecord, 'publicAccess'>>} [patch] */
		refresh(patch = {}) {
			queue = queue.then(async () => {
				const [last, auto] = await Promise.all([readLastBackup(dataDir), autoBackup()]);
				const sizes = (await Promise.all([dataDir, ...(auto.settings ? [auto.settings.dir] : [])].map(freeBytes))).filter(size => size !== null);
				const disk = sizes.length ? Math.min(...sizes) : null;
				onDisk(disk);
				Object.assign(record, patch, { lastBackupAt: last?.createdAt ?? null, diskFreeBytes: disk,
					autoBackup: { on: Boolean(auto.settings), lastFailureAt: auto.lastFailure?.at ?? null } });
				await write();
			}).catch(error => { console.warn(`Could not record server status for devices: ${error.message}`); });
			return queue;
		},
		/** Waits for pending writes, before storage closes. */
		settled: () => queue,
	};
}
