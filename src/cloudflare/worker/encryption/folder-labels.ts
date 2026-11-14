import type { EncryptionServerState } from '../../../encryption/server-state';
import { isWirePath } from '../../../protocol/encrypted-path';
import { putMaintenanceValue, readMaintenanceValue } from '../d1/db';

const PREFIX = 'e2ee:folder:';
const END = 'e2ee:folder;';
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
	return readMaintenanceValue(db, PREFIX + folder);
}

/** Deletes the labels of folders that no policy, credential, push subscription or enrollment
 * link names. Every writer saves a label in the batch that first names its folder, or after
 * that statement, so a label in use is never unreferenced here. */
export function pruneFolderLabels(db: D1Database): D1PreparedStatement {
	return db.prepare(`DELETE FROM maintenance_state WHERE key >= ? AND key < ? AND substr(key, ?) NOT IN (
    SELECT folder_path FROM notification_policy UNION ALL SELECT folder_path FROM reading_policy
    UNION ALL SELECT folder_path FROM auth_tokens WHERE folder_path IS NOT NULL
    UNION ALL SELECT folder_path FROM push_subscriptions WHERE folder_path IS NOT NULL
    UNION ALL SELECT json_extract(payload, '$.folderPath') FROM grants WHERE kind = 'web_enrollment'
      AND json_extract(payload, '$.folderPath') IS NOT NULL)`).bind(PREFIX, END, PREFIX.length + 1);
}
