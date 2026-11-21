// Data maintenance: backup (online or stopped), automatic backups, and the stopped-server
// restore, upgrade and upgrade check.
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backupLocalServer, checkLocalUpgrade, restoreLocalServer } from '../local-server-backup.mjs';
import { saveAutoBackup } from '../local-server-backup-schedule.mjs';
import { requestLocalControl } from '../local-server-pairing.mjs';
import { openLocalRuntime } from '../local-server-runtime.mjs';
import { describeAutoBackup } from './status.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */

/** Backs up through the running server, pausing its writes briefly, or directly when it is stopped. @type {Command} */
export async function backup({ dataDir, values }) {
	if (!values.output) throw new Error('Provide --output with a new backup directory.');
	const output = resolve(values.output);
	/** @type {{ output: string, pausedMs: number }} */
	let online;
	try { online = await requestLocalControl(dataDir, 'POST', '/backup', { output }, 60 * 60_000); }
	catch (error) {
		if (error.code !== 'ENOENT') throw new Error(`The running Crate server could not back up: ${error.message}`);
		console.log(`Backup verified: ${await backupLocalServer(dataDir, output)}`);
		return;
	}
	console.log(`Backup verified: ${online.output}\nSync paused for ${(online.pausedMs / 1000).toFixed(1)} s while the database was copied.`);
}

/** Turns daily automatic backups on (`--output`, `--keep`) or off (`--off`). @type {Command} */
export async function autoBackup({ dataDir, values }) {
	if (values.off === Boolean(values.output)) throw new Error('Provide --output with a backup directory, or --off.');
	const keep = values.keep === undefined ? 7 : Number(values.keep);
	const settings = await saveAutoBackup(dataDir, values.off ? null : { dir: /** @type {string} */ (values.output), keep });
	console.log(describeAutoBackup(settings));
	// A running server checks hourly; ask it to check now. A stopped one checks when it starts.
	if (settings) await requestLocalControl(dataDir, 'POST', '/auto-backup').catch(() => {});
}

/** @type {Command} */
export async function upgrade({ dataDir, values }) {
	if (!values.output) throw new Error('Stop the server and provide --output with a new backup directory.');
	// As for every other command, an interrupt waits for the upgrade to close the runtime
	// and release the data directory instead of exiting mid-migration.
	const upgraded = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false, upgradeBackup: values.output });
	await upgraded.close();
	console.log('Server data upgraded. The verified backup is at ' + resolve(values.output));
}

/** @type {Command} */
export async function restore({ dataDir, values }) {
	if (!values.backup) throw new Error('Provide --backup with a verified backup directory. Restore into an empty data directory.');
	await restoreLocalServer(dataDir, values.backup);
	console.log(`Backup restored and database verified: ${dataDir}. Start Crate to resume.`);
}

/** @type {Command} */
export async function checkUpgrade({ dataDir, values }) {
	const checked = await checkLocalUpgrade(dataDir);
	if (values.json) { console.log(JSON.stringify(checked)); return; }
	console.log(`Compatible: server revision ${checked.from} → ${checked.to}, runtime ${checked.runtime}.${checked.requiresMigration ? ' The database needs a migration: run upgrade with a new --output backup directory before starting.' : ''} Back up before updating; no data was changed by this check.`);
}

/** Before Docker serves a newer image, migrates data that needs it, after a verified backup
 * into `backupRoot`. Incompatible data throws the check's reason; a fresh volume has nothing to check.
 * @param {string} dataDir @param {string} backupRoot @param {() => Date} [now]
 * @returns {Promise<string | null>} The migration backup, or null when none was needed. */
export async function migrateBeforeStart(dataDir, backupRoot, now = () => new Date()) {
	if (!await access(join(dataDir, 'server.json')).then(() => true, () => false)) return null;
	if (!(await checkLocalUpgrade(dataDir)).requiresMigration) return null;
	const output = join(backupRoot, `before-migration-${now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`);
	console.log(`This release needs a database migration. Backing up to ${output} first.`);
	const upgraded = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false, upgradeBackup: output });
	await upgraded.close();
	console.log('Server data migrated.');
	return output;
}
