import type { MutationAuditContext } from './request-diagnostics';

export interface FileDeletionReceipt {
	revision: string;
	consumedRevision: string;
	deleteRequestId: string;
}

/** The changelog row and receipt must be in the same batch as the deletion. */
export function recordFileDeletion(
	db: D1Database,
	path: string,
	consumedHash: string,
	consumedRevision: string,
	revision: string,
	context: MutationAuditContext,
): D1PreparedStatement {
	return db.prepare(`INSERT INTO file_deletion_receipts
		(consumed_revision, revision, changelog_seq, path, consumed_hash, request_id, device_id, client_session, operation_id)
		SELECT ?, revision, seq, path, ?, ?, ?, ?, ? FROM changelog
		WHERE seq = (SELECT MAX(seq) FROM changelog) AND revision = ? AND action = 'delete' AND path = ?`)
		.bind(consumedRevision, consumedHash, context.requestId, context.deviceId, context.clientSession, context.operationId, revision, path);
}

export async function findFileDeletionReceipt(db: D1Database, path: string, hash: string, consumedRevision: string): Promise<FileDeletionReceipt | null> {
	return db.prepare(`SELECT revision, consumed_revision AS consumedRevision, request_id AS deleteRequestId
		FROM file_deletion_receipts WHERE consumed_revision = ? AND path = ? AND consumed_hash = ?`)
		.bind(consumedRevision, path, hash).first<FileDeletionReceipt>();
}

export async function pruneFileDeletionReceipts(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM file_deletion_receipts WHERE created_at < datetime('now', '-30 days')").run();
}
