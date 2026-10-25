import type { EncryptionServerState } from '../../../encryption/server-state';
import { isWirePath } from '../../../protocol/encrypted-path';
import { putMaintenanceValue } from '../db';

const PREFIX = 'e2ee:folder:';
const MAX_LABEL_LENGTH = 8192;

/** In an encrypted vault a feature folder arrives as its tagged path with the
 * plaintext name sealed under the vault key; a plaintext vault sends neither. */
export function folderLabelIssue(encryption: EncryptionServerState | null, folder: string, label: unknown): string | null {
	if (!encryption) return label === undefined ? null : 'This vault is not encrypted';
	return isWirePath(folder) && typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL_LENGTH ? null
		: 'Update Crate: this encrypted vault needs encrypted folder names';
}

export function saveFolderLabel(db: D1Database, folder: string, label: string): D1PreparedStatement {
	return putMaintenanceValue(db, PREFIX + folder, label);
}

export async function readFolderLabel(db: D1Database, folder: string | null | undefined): Promise<string | null> {
	if (!folder) return null;
	return (await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(PREFIX + folder).first<{ value: string }>())?.value ?? null;
}
