// The status command: whether the server runs, how often its runtime recovered and
// when this data directory was last backed up.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { readLastBackup } from '../local-server-backup.mjs';
import { requestLocalControl } from '../local-server-pairing.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */

/** @param {{ createdAt: string, output: string } | null} backup */
export function describeLastBackup(backup) {
	return backup ? `Last backup: ${backup.createdAt} at ${backup.output}`
		: 'Last backup: none recorded. See "Nightly backups" in docs/self-hosting.md.';
}

/** @param {number} seconds */
function duration(seconds) {
	const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
	return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/** @type {Command} */
export async function status({ dataDir }) {
	await access(join(dataDir, 'server.json')).catch(() => { throw new Error(`No Crate server data in ${dataDir}. Pass the server's --data-dir.`); });
	/** @type {{ origin: string, uptimeSeconds: number, crashes: number } | null} */
	let running = null;
	try { running = await requestLocalControl(dataDir, 'GET', '/status'); }
	catch (error) {
		// A control file nobody answers was left by a server that did not stop cleanly.
		if (error.code !== 'ENOENT') {
			console.log(`Status: not responding. If Crate was force-quit, start it again.\n${describeLastBackup(await readLastBackup(dataDir))}`);
			process.exitCode = 1;
			return;
		}
	}
	console.log(running
		? `Status: running at ${running.origin} for ${duration(running.uptimeSeconds)}\nRuntime crashes recovered: ${running.crashes}`
		: 'Status: stopped');
	console.log(describeLastBackup(await readLastBackup(dataDir)));
}
