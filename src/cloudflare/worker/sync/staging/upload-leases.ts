import { portablePathKey } from '../../../../protocol/portable-path';
import type { ObjectReference } from '../../d1/storage-references';
import { ENCRYPTION_STATE_SQL, EncryptionStateError, encryptionWriteGuard } from '../../encryption/state';
import { validateEncryptionState, type EncryptionServerState } from '../../../../encryption/server-state';
import { syncResetGenerationGuard } from '../reset-generation';
import type { SqlGuard } from '../../d1/db';

/** A publication lease. Cleanup may claim it after 24 hours, never before. */
export const UPLOAD_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

const leaseEncryptionGuard = `${ENCRYPTION_STATE_SQL} IS NULL
  OR (? = 1 AND json_extract(${ENCRYPTION_STATE_SQL}, '$.mode') = 'active')`;

export interface UploadLeaseOptions {
	/** Every object is encrypted file content. Plaintext leases require a plaintext vault. */
	encrypted?: boolean;
	/** The encryption state the request was validated against, checked in the same insert. */
	expectedEncryption?: EncryptionServerState | null;
	/** The reset generation read with the request's token. */
	resetGeneration?: string | null;
}

/** One durable lease row for every object of a request, before any R2 put. Each
 * request attempt owns distinct immutable keys, including any whose put fails. Returns
 * the lease ID and the encryption state the insert saw. */
export async function trackUploadLease(db: D1Database, objects: ObjectReference[], options: UploadLeaseOptions = {}): Promise<{ id: string; encryptionState: EncryptionServerState | null }> {
	if (!objects.length) throw new Error('An upload lease needs at least one object');
	const id = crypto.randomUUID();
	const authority = options.expectedEncryption === undefined ? { sql: '1', args: [] } : encryptionWriteGuard(options.expectedEncryption);
	const resetGuard = syncResetGenerationGuard(options.resetGeneration);
	const { results: [row] } = await db.prepare(`INSERT INTO upload_leases(id, keys, expires_at)
    SELECT ?, ?, unixepoch('now') * 1000 + ? WHERE (${leaseEncryptionGuard}) AND (${authority.sql}) AND ${resetGuard.sql}
    RETURNING ${ENCRYPTION_STATE_SQL} AS encryption_state`)
		.bind(id, JSON.stringify(objects.map(object => ({ storageKey: object.storageKey, path: object.path }))), UPLOAD_LEASE_TTL_MS,
			options.encrypted ? 1 : 0, ...authority.args, ...resetGuard.args)
		.all<{ encryption_state: string | null }>();
	if (!row) throw new EncryptionStateError('Encryption changed before this upload. Reconnect before syncing.', 428);
	if (!row.encryption_state) return { id, encryptionState: null };
	const state: unknown = JSON.parse(row.encryption_state); validateEncryptionState(state);
	return { id, encryptionState: state };
}

/** Publication requires this pending, unexpired lease to name the object. Evaluate it
 * inside the publishing statement. */
export function uploadLeaseGuard(id: string, storageKey: string): SqlGuard {
	return { sql: `EXISTS (SELECT 1 FROM upload_leases l WHERE l.id = ?
    AND l.state = 'pending' AND l.expires_at > unixepoch('now') * 1000
    AND EXISTS (SELECT 1 FROM json_each(l.keys) WHERE json_extract(value, '$.storageKey') = ?))`, args: [id, storageKey] };
}

export interface LeasedObject { path: string; objectKey: string; leaseId: string }

/** Settles the objects a commit attempted, after its publishing statements and in the
 * same transaction: an object that did not become live is queued for reference-aware
 * cleanup, and every attempted object leaves its lease, which is deleted once empty.
 * Objects whose R2 put failed are never passed here and stay leased, because a lost
 * response may hide a late put. */
export function finishUploadLeases(db: D1Database, files: readonly LeasedObject[]): D1PreparedStatement[] {
	if (!files.length) return [];
	const json = JSON.stringify(files.map(file => ({ id: file.leaseId, key: file.objectKey, path: file.path, portable: portablePathKey(file.path) })));
	const input = `WITH input AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.key') AS key, json_extract(value, '$.path') AS path, json_extract(value, '$.portable') AS portable FROM json_each(?)) `;
	const remaining = `SELECT value FROM json_each(upload_leases.keys) k
    WHERE NOT EXISTS (SELECT 1 FROM input i WHERE i.id = upload_leases.id AND i.key = json_extract(k.value, '$.storageKey'))`;
	return [
		db.prepare(input + `INSERT OR IGNORE INTO object_cleanup_queue(storage_key, file_path)
      SELECT key, path FROM input WHERE NOT EXISTS (SELECT 1 FROM files WHERE portable_path = input.portable AND storage_key = input.key)`).bind(json),
		db.prepare(input + `DELETE FROM upload_leases WHERE id IN (SELECT id FROM input) AND NOT EXISTS (${remaining})`).bind(json),
		db.prepare(input + `UPDATE upload_leases SET keys = (SELECT json_group_array(json(value)) FROM (${remaining}))
      WHERE id IN (SELECT id FROM input)`).bind(json),
	];
}
