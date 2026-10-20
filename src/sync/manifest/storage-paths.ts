/** Files sync keeps in the plugin folder. Connection changes back them up and
 * checkpoint cleanup recognizes those backups, so all three share these names. */
export function syncStoragePaths(pluginDir: string) {
	const manifest = `${pluginDir}/file-manifest.json`;
	return {
		manifest,
		manifestTmp: `${manifest}.tmp`,
		manifestLog: `${pluginDir}/file-manifest.log`,
		uploadJournal: `${pluginDir}/pending-uploads`,
	};
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Copy preserved when a connection change invalidates a checkpoint file. */
export const previousCheckpointCopy = (path: string, recoveryId: string): string => `${path}.previous-${recoveryId}`;

/** Retired upload journal entries are copied beside the plugin data before they are invalidated. */
export const retiredUploadPath = (pluginDir: string, journalFile: string): string => `${pluginDir}/upload-${journalFile}`;

/** Matches a retired upload backup name and captures its upload operation id. */
export const RETIRED_UPLOAD_BACKUP = new RegExp(`^upload-(e1_[0-9]{8}_${UUID})\\.json\\.previous-${UUID}$`);
