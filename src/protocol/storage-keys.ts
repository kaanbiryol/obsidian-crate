/**
 * R2 object keys that Crate generates. Server reset deletes only keys matching
 * these formats or referenced by the database, so generators and matchers share
 * this module. `cloudflare/worker/standalone/reset-worker.js` embeds copies of the
 * patterns; storage-keys.test.ts keeps them identical.
 */
const MANAGED_FILES_PREFIX = '__crate__/files/';
export const SHARED_SETTINGS_KEY = '__crate__/settings.json';
export const HISTORY_INDEX_KEY = '__crate__/history/index.json';
export const HISTORY_CHECKPOINT_PREFIX = '__crate__/history/checkpoints/';
export const BACKUPS_PREFIX = '__crate__/backups/';
export const UPGRADE_BACKUP_PREFIX = `${BACKUPS_PREFIX}schema-upgrade-`;
/**
 * Content-addressed file copies shared by upgrade backups. The reserved all-f
 * identifier keeps the generated backup key format, so reset and recovery tools
 * recognize these keys, and sorts after every random backup prefix in listings.
 */
export const UPGRADE_BACKUP_STORE = `${UPGRADE_BACKUP_PREFIX}ffffffff-ffff-ffff-ffff-ffffffffffff`;
export const upgradeBackupStoreKey = (sha256: string) => `${UPGRADE_BACKUP_STORE}/objects/${sha256}`;

export const MANAGED_FILE_OBJECT = /^__crate__\/files\/[a-f0-9]{64}\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const UPGRADE_BACKUP_OBJECT = /^__crate__\/backups\/schema-upgrade-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/(?:archive\.json|database\.sql|objects\/[a-f0-9]{64})$/;
export const HISTORY_CHECKPOINT_OBJECT = /^__crate__\/history\/checkpoints\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/;

export function createManagedObjectKey(hash: string): string {
	return `${MANAGED_FILES_PREFIX}${hash}/${crypto.randomUUID()}`;
}

/** Keys owned by Crate without a database reference. */
export function isGeneratedCrateObjectKey(key: string): boolean {
	return MANAGED_FILE_OBJECT.test(key) || UPGRADE_BACKUP_OBJECT.test(key) || HISTORY_CHECKPOINT_OBJECT.test(key)
		|| key === SHARED_SETTINGS_KEY || key === HISTORY_INDEX_KEY;
}
