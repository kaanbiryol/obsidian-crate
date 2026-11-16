// Stopped-server data maintenance: backup, restore, upgrade and the upgrade check.
import { resolve } from 'node:path';
import { backupLocalServer, checkLocalUpgrade, restoreLocalServer } from '../local-server-backup.mjs';
import { openLocalRuntime } from '../local-server-runtime.mjs';

/** @typedef {import('../local-server-options.mjs').Command} Command */

/** @type {Command} */
export async function backup({ dataDir, values }) {
	if (!values.output) throw new Error('Provide --output with a new backup directory. Stop the server before backing up.');
	console.log(`Backup verified: ${await backupLocalServer(dataDir, values.output)}`);
}

/** @type {Command} */
export async function upgrade({ dataDir, values }) {
	if (!values.output) throw new Error('Stop the server and provide --output with a new backup directory.');
	const upgraded = await openLocalRuntime({ dataDir, administrative: true, upgradeBackup: values.output });
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
export async function checkUpgrade({ dataDir }) {
	const checked = await checkLocalUpgrade(dataDir);
	console.log(`Compatible: server revision ${checked.from} → ${checked.to}, runtime ${checked.runtime}.${checked.requiresMigration ? ' The database needs a migration: run upgrade with a new --output backup directory before starting.' : ''} Back up before updating; no data was changed by this check.`);
}
