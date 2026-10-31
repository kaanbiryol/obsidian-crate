/** R2 object keys that Crate generates. Generators and matchers share this module. */
const MANAGED_FILES_PREFIX = '__crate__/files/';
export const SHARED_SETTINGS_KEY = '__crate__/settings.json';
export const HISTORY_INDEX_KEY = '__crate__/history/index.json';
export const HISTORY_CHECKPOINT_PREFIX = '__crate__/history/checkpoints/';
export const BACKUPS_PREFIX = '__crate__/backups/';
export const UPGRADE_BACKUP_PREFIX = `${BACKUPS_PREFIX}schema-upgrade-`;
/**
 * Content-addressed file copies shared by upgrade backups. The reserved all-f
 * identifier keeps the generated backup key format, so recovery tools recognize
 * these keys, and sorts after every random backup prefix in listings.
 */
export const UPGRADE_BACKUP_STORE = `${UPGRADE_BACKUP_PREFIX}ffffffff-ffff-ffff-ffff-ffffffffffff`;
export const upgradeBackupStoreKey = (sha256: string) => `${UPGRADE_BACKUP_STORE}/objects/${sha256}`;

export const MANAGED_FILE_OBJECT = /^__crate__\/files\/[a-f0-9]{64}\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const UPGRADE_BACKUP_OBJECT = /^__crate__\/backups\/schema-upgrade-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/(?:archive\.json|objects\/[a-f0-9]{64})$/;

export function createManagedObjectKey(hash: string): string {
	return `${MANAGED_FILES_PREFIX}${hash}/${crypto.randomUUID()}`;
}
