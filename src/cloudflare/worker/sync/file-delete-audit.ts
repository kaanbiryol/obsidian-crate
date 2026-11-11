export interface FileDeletionReceipt {
	revision: string;
	consumedRevision: string;
	deleteRequestId: string;
}

/** Selects at most one `FileDeletionReceipt`: the retained copy of the deleted revision. */
export function fileDeletionReceiptStatement(db: D1Database, path: string, hash: string, consumedRevision: string): D1PreparedStatement {
	return db.prepare(`SELECT deletion_revision AS revision, storage_key AS consumedRevision, request_id AS deleteRequestId
		FROM file_versions WHERE storage_key = ? AND path = ? AND hash = ? AND deletion_revision IS NOT NULL`)
		.bind(consumedRevision, path, hash);
}

export async function findFileDeletionReceipt(db: D1Database, path: string, hash: string, consumedRevision: string): Promise<FileDeletionReceipt | null> {
	return fileDeletionReceiptStatement(db, path, hash, consumedRevision).first<FileDeletionReceipt>();
}
