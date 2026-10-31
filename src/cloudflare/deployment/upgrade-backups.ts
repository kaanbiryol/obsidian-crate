import { CloudflareApiError, type CloudflareApiClient } from '../cloudflare-api';
import { UPGRADE_BACKUP_OBJECT, UPGRADE_BACKUP_PREFIX, UPGRADE_BACKUP_STORE, upgradeBackupStoreKey } from '../../protocol/storage-keys';

/** A pending restore on any device records the backup it reads from the original server. */
const RESTORE_HOLD_PREFIX = 'crate_restore_hold:';
// Complete backups kept before a new backup starts; with the new one, two remain.
const KEEP_COMPLETE_BACKUPS = 1;

/** Keys below `prefix` mapped to their reported sizes. */
export async function listBackupObjects(api: Pick<CloudflareApiClient, 'listR2ObjectSizes' | 'throttle'>, account: string, bucket: string, prefix: string): Promise<Map<string, number | null>> {
	const objects = new Map<string, number | null>(), cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		await api.throttle();
		const page = await api.listR2ObjectSizes(account, bucket, cursor, prefix);
		for (const object of page.objects) objects.set(object.key.slice(prefix.length), object.size);
		cursor = page.cursor;
		if (cursor && cursors.has(cursor)) throw new Error('Backup listing did not advance');
		if (cursor) cursors.add(cursor);
	} while (cursor);
	return objects;
}

type BackupQueryApi = Pick<CloudflareApiClient, 'queryD1' | 'getD1Database'>;
interface Source { account: string; database: string }

/** Records that a restore reads `prefix`, before it reads the backup. */
export async function holdUpgradeBackup(api: BackupQueryApi, source: Source, restoreId: string, prefix: string): Promise<void> {
	try {
		await api.queryD1(source.account, source.database, 'INSERT INTO maintenance_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;', [`${RESTORE_HOLD_PREFIX}${restoreId}`, prefix]);
	} catch (error) {
		// Without its database the original server cannot update, so nothing prunes its backups.
		if (!(error instanceof CloudflareApiError && error.status >= 400 && error.status < 500)
			|| await api.getD1Database(source.account, source.database) !== null) throw error;
	}
}

/** A completed restore no longer reads its backup, so ordinary retention applies again. */
export async function releaseUpgradeBackupHold(api: BackupQueryApi, source: Source, restoreId: string, prefix: string): Promise<void> {
	await api.queryD1(source.account, source.database, 'DELETE FROM maintenance_state WHERE key = ? AND value = ?;', [`${RESTORE_HOLD_PREFIX}${restoreId}`, prefix]);
}

/** Backups that an interrupted upgrade or a pending restore still needs. */
async function protectedBackups(api: CloudflareApiClient, account: string, database: string): Promise<Set<string>> {
	const rows = (await api.queryD1(account, database, `SELECT key, value FROM maintenance_state WHERE key IN ('crate_upgrade_checkpoint', 'crate_upgrade_backup') OR (key >= '${RESTORE_HOLD_PREFIX}' AND key < 'crate_restore_hold;');`))
		.flatMap(result => result.results ?? []);
	return new Set(rows.map(row => {
		if (row.key !== 'crate_upgrade_backup') return String(row.value);
		try { return String((JSON.parse(String(row.value)) as { prefix?: unknown }).prefix); } catch { throw new Error('The saved upgrade backup progress is invalid. The update stopped before changing the database schema.'); }
	}));
}

interface Manifest { format: 2; createdAt: string; objects: Array<{ sha256: string }> }
async function readManifest(api: CloudflareApiClient, account: string, bucket: string, prefix: string): Promise<Manifest | null> {
	await api.throttle();
	try {
		const value = JSON.parse(new TextDecoder().decode(await api.getRecoveryObject(account, bucket, `${prefix}/archive.json`))) as Partial<Manifest> & { complete?: unknown };
		return value.format === 2 && value.complete === true && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
			&& Array.isArray(value.objects) && value.objects.every(item => typeof item?.sha256 === 'string') ? value as Manifest : null;
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof CloudflareApiError && error.status === 404) return null;
		throw error;
	}
}

/**
 * Removes older upgrade backups before a new one starts. Keeps the newest
 * complete backup, any backup recorded by an interrupted upgrade or a pending
 * restore, and anything it cannot read. Shared file copies are removed only when
 * no remaining backup lists them. Runs only while no backup is in progress.
 */
export async function pruneUpgradeBackups(input: { api: CloudflareApiClient; accountId: string; databaseId: string; bucketName: string; onProgress?: (message: string) => void }): Promise<void> {
	const { api, accountId, databaseId, bucketName } = input;
	const backups = new Map<string, string[]>(), cursors = new Set<string>();
	let cursor: string | undefined;
	listing: do {
		await api.throttle();
		const page = await api.listR2Objects(accountId, bucketName, cursor, UPGRADE_BACKUP_PREFIX);
		for (const key of page.keys) {
			// Shared copies sort after every backup prefix.
			if (key.startsWith(`${UPGRADE_BACKUP_STORE}/`)) break listing;
			const prefix = key.slice(0, UPGRADE_BACKUP_PREFIX.length + 36);
			backups.set(prefix, [...backups.get(prefix) ?? [], key]);
		}
		cursor = page.cursor;
		if (cursor && cursors.has(cursor)) throw new Error('Backup listing did not advance');
		if (cursor) cursors.add(cursor);
	} while (cursor);

	let unreadable = false;
	const complete: Array<{ prefix: string; manifest: Manifest }> = [], removable: string[] = [];
	for (const [prefix, keys] of backups) {
		if (!keys.includes(`${prefix}/archive.json`)) { removable.push(prefix); continue; }
		const manifest = await readManifest(api, accountId, bucketName, prefix);
		if (manifest) complete.push({ prefix, manifest });
		else unreadable = true;
	}
	complete.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt));
	removable.push(...complete.slice(KEEP_COMPLETE_BACKUPS).map(backup => backup.prefix));
	const removed = new Set<string>();
	if (removable.length) input.onProgress?.('Removing older server backups…');
	for (const prefix of removable) {
		// Read just before deleting: a restore may have started since the listing.
		if ((await protectedBackups(api, accountId, databaseId)).has(prefix)) continue;
		// Deleting the manifest first stops a partly removed backup from being offered for restore.
		const keys = backups.get(prefix)!.filter(key => UPGRADE_BACKUP_OBJECT.test(key))
			.sort((a, b) => Number(b.endsWith('/archive.json')) - Number(a.endsWith('/archive.json')));
		for (const key of keys) {
			await api.throttle();
			await api.deleteRecoveryObject(accountId, bucketName, key);
		}
		removed.add(prefix);
	}
	// An unreadable manifest might list shared copies, so keep all of them.
	if (unreadable) return;
	const listed = new Set(complete.filter(backup => !removed.has(backup.prefix))
		.flatMap(backup => backup.manifest.objects.map(item => item.sha256)));
	for (const sha256 of (await listBackupObjects(api, accountId, bucketName, `${UPGRADE_BACKUP_STORE}/objects/`)).keys()) {
		if (listed.has(sha256) || !UPGRADE_BACKUP_OBJECT.test(upgradeBackupStoreKey(sha256))) continue;
		await api.throttle();
		await api.deleteRecoveryObject(accountId, bucketName, upgradeBackupStoreKey(sha256));
	}
}
