/** Files and folders sync keeps in the plugin folder. Connection changes back up the
 * checkpoint files and checkpoint cleanup recognizes those backups, so all three share
 * these names. */
export function syncStoragePaths(pluginDir: string) {
	const manifest = `${pluginDir}/file-manifest.json`;
	const conflicts = `${pluginDir}/conflicts.json`;
	return {
		manifest,
		manifestTmp: `${manifest}.tmp`,
		manifestLog: `${pluginDir}/file-manifest.log`,
		uploadJournal: `${pluginDir}/pending-uploads`,
		conflicts,
		conflictsTmp: `${conflicts}.tmp`,
		contentVerification: `${pluginDir}/content-verification.json`,
		markdownBaseCache: `${pluginDir}/markdown-base-cache`,
		/** Originals saved while discarding local changes. */
		discardRecovery: `${pluginDir}/discard-recovery`,
		/** Originals saved while restoring a history checkpoint. */
		stateRecovery: `${pluginDir}/state-recovery`,
	};
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Copy preserved when a connection change invalidates a checkpoint file. */
export const previousCheckpointCopy = (path: string, recoveryId: string): string => `${path}.previous-${recoveryId}`;

/** Retired upload journal entries are copied beside the plugin data before they are invalidated. */
export const retiredUploadPath = (pluginDir: string, journalFile: string): string => `${pluginDir}/upload-${journalFile}`;

/** Matches a retired upload backup name and captures its upload operation id. */
export const RETIRED_UPLOAD_BACKUP = new RegExp(`^upload-(e1_[0-9]{8}_${UUID})\\.json\\.previous-${UUID}$`);
