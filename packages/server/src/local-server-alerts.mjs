// Push alerts to enrolled devices when this server needs its owner: an automatic backup
// failed, the public address stopped working, or the disk is nearly full. Each kind is
// sent at most once a day; `alerts.json` in the data directory remembers when.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DAY = 24 * 60 * 60_000;
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

/** @typedef {'backup-failed' | 'public-access-lost' | 'low-disk'} AlertKind */

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(kind: AlertKind) => Promise<number>} options.send Returns how many devices received it.
 * @param {() => number} [options.now]
 * @param {number} [options.lossDelay] How long public access must stay lost before an alert.
 */
export function createAlerts({ dataDir, send, now = Date.now, lossDelay = 15 * 60_000 }) {
	const file = join(dataDir, 'alerts.json');
	/** @type {NodeJS.Timeout | undefined} */
	let lost;
	let queue = Promise.resolve();
	let closed = false;

	/** @param {AlertKind} kind */
	function notify(kind) {
		queue = queue.then(async () => {
			if (closed) return;
			/** @type {Record<string, number>} */
			const sent = await readFile(file, 'utf8').then(text => JSON.parse(text), () => ({}));
			if (typeof sent[kind] === 'number' && now() - sent[kind] < DAY) return;
			const devices = await send(kind);
			sent[kind] = now();
			await writeFile(file, `${JSON.stringify(sent)}\n`, { mode: 0o600 });
			console.warn(`Sent a "${kind}" alert to ${devices} device${devices === 1 ? '' : 's'}.`);
		}).catch(error => { console.warn(`Could not send a "${kind}" alert: ${error.message}`); });
		return queue;
	}

	return {
		notify,
		/** @param {boolean} ready */
		publicAccess(ready) {
			clearTimeout(lost);
			lost = undefined;
			if (!ready && !closed) { lost = setTimeout(() => { void notify('public-access-lost'); }, lossDelay); lost.unref(); }
		},
		/** @param {number | null} bytes Free space on the fuller of the data and backup disks. */
		disk(bytes) { if (bytes !== null && bytes < LOW_DISK_BYTES) void notify('low-disk'); },
		async close() { closed = true; clearTimeout(lost); await queue; },
	};
}
