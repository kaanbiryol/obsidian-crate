import { isRecord } from '../platform/validation';
import { isSyncSequence, parseSyncFiles } from '../protocol/sync-validation';
import { reminderOperationDay } from '../protocol/reminder-operation';
import type { FileManifest } from '../protocol/sync-types';
import { parseRenameDependencies } from './rename-dependencies';
import { normalizeUploadDiagnostics } from './upload-diagnostics';
import { parseRestoreIntents } from './restore-intent';
import { parseInitialConfigPull } from './initial-config-pull';

export const CHECKPOINT_VERSION = 3;

/** Only a complete, known checkpoint can carry common-ancestor authority. */
export function parseCheckpoint(value: unknown) {
	if (!isRecord(value) || ![1, 2, CHECKPOINT_VERSION].includes(Number(value.version)) || typeof value.version !== 'number') {
		throw new Error('Unsupported manifest checkpoint. Preserve this vault and its metadata; use a compatible Crate version.');
	}
	if (!isSyncSequence(value.generation) || (value.lastSeq !== undefined && !isSyncSequence(value.lastSeq))
		|| (value.authority !== undefined && (typeof value.authority !== 'string' || !value.authority))
		|| (value.truncated !== undefined && value.truncated !== false)) throw new Error('Invalid manifest checkpoint. Preserve this vault and its metadata before recovering sync.');
	const settled = value.settledUploads ?? [];
	if (value.appliedRename !== undefined && (typeof value.appliedRename !== 'string' || !value.appliedRename || value.appliedRename.length > 128)) throw new Error('Invalid rename receipt checkpoint');
	if (!Array.isArray(settled) || settled.some(id => typeof id !== 'string' || reminderOperationDay(id) === null)
		|| new Set(settled).size !== settled.length) throw new Error('Invalid upload receipt checkpoint');
	return {
		manifest: parseLocalManifest(value), generation: value.generation, authority: value.authority,
		settledUploads: settled, renames: parseRenameDependencies(value.renameDependencies),
		appliedRename: value.appliedRename,
		uploadDiagnostics: normalizeUploadDiagnostics(value.uploadDiagnostics),
		restoreIntents: parseRestoreIntents(value.restoreIntents),
		initialConfigPull: parseInitialConfigPull(value.initialConfigPull),
	};
}

export function parseLocalManifest(value: unknown): FileManifest {
	if (!isRecord(value) || ![1, 2, CHECKPOINT_VERSION].includes(Number(value.version)) || typeof value.version !== 'number'
		|| (value.lastSeq !== undefined && !isSyncSequence(value.lastSeq))
		|| (value.truncated !== undefined && value.truncated !== false)) throw new Error('Invalid manifest checkpoint');
	return { version: 1, files: parseSyncFiles(value.files, true),
		...(value.lastSeq === undefined ? {} : { lastSeq: value.lastSeq }) };
}
