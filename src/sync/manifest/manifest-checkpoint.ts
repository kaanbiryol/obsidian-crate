import { isRecord } from '../../platform/validation';
import { isSyncSequence, parseSyncFiles } from '../../protocol/sync-validation';
import { reminderOperationDay } from '../../protocol/reminder-operation';
import type { FileManifest } from '../../protocol/sync-types';
import { parseRenameDependencies } from './rename-dependencies';
import { normalizeUploadDiagnostics, type UploadDiagnostic } from '../diagnostics/upload-diagnostics';
import { parseRestoreIntents, type RestoreIntent } from '../durability/restore-intent';
import { parseInitialConfigPull, type InitialConfigPull } from './initial-config-pull';

export const CHECKPOINT_VERSION = 1;

/** Validated state adopted by the manifest owner after selecting a generation. */
export interface ManifestCheckpoint {
	manifest: FileManifest;
	generation: number;
	authority: string | undefined;
	settledUploads: string[];
	renames: ReadonlyMap<string, string>;
	uploadDiagnostics: UploadDiagnostic[];
	restoreIntents: RestoreIntent[];
	initialConfigPull: InitialConfigPull | undefined;
	/** The unfinished initial import this device uploads and prunes for. */
	initialImportToken: string | undefined;
}

/** Only a complete, known checkpoint can carry common-ancestor authority. */
export function parseCheckpoint(value: unknown): ManifestCheckpoint {
	if (!isRecord(value) || value.version !== CHECKPOINT_VERSION) {
		throw new Error('Unsupported manifest checkpoint. Preserve this vault and its metadata; use a compatible Crate version.');
	}
	if (!isSyncSequence(value.generation) || (value.lastSeq !== undefined && !isSyncSequence(value.lastSeq))
		|| (value.authority !== undefined && (typeof value.authority !== 'string' || !value.authority))
		|| (value.truncated !== undefined && value.truncated !== false)) throw new Error('Invalid manifest checkpoint. Preserve this vault and its metadata before recovering sync.');
	const settled = value.settledUploads ?? [];
	if (!Array.isArray(settled) || !settled.every((id: unknown): id is string => typeof id === 'string' && reminderOperationDay(id) !== null)
		|| new Set(settled).size !== settled.length) throw new Error('Invalid upload receipt checkpoint');
	if (value.initialImportToken !== undefined && (typeof value.initialImportToken !== 'string' || !value.initialImportToken || value.initialImportToken.length > 128)) throw new Error('Invalid initial import checkpoint');
	return {
		manifest: parseLocalManifest(value), generation: value.generation, authority: value.authority,
		settledUploads: settled, renames: parseRenameDependencies(value.renameDependencies),
		uploadDiagnostics: normalizeUploadDiagnostics(value.uploadDiagnostics),
		restoreIntents: parseRestoreIntents(value.restoreIntents),
		initialConfigPull: parseInitialConfigPull(value.initialConfigPull),
		initialImportToken: value.initialImportToken,
	};
}

/** Preserve the persisted format and omission rules for optional recovery state. */
export function encodeCheckpoint(checkpoint: ManifestCheckpoint): string {
	return JSON.stringify({
		...checkpoint.manifest,
		version: CHECKPOINT_VERSION,
		...(checkpoint.initialConfigPull ? { initialConfigPull: checkpoint.initialConfigPull } : {}),
		...(checkpoint.initialImportToken ? { initialImportToken: checkpoint.initialImportToken } : {}),
		...(checkpoint.restoreIntents.length ? { restoreIntents: checkpoint.restoreIntents } : {}),
		...(checkpoint.uploadDiagnostics.length ? { uploadDiagnostics: checkpoint.uploadDiagnostics } : {}),
		...(checkpoint.settledUploads.length ? { settledUploads: checkpoint.settledUploads } : {}),
		...(checkpoint.renames.size ? { renameDependencies: Object.fromEntries(checkpoint.renames) } : {}),
		generation: checkpoint.generation,
		...(checkpoint.authority === undefined ? {} : { authority: checkpoint.authority }),
	});
}

/** Compare equal-generation recovery authority; diagnostics never decide recovery. */
export function sameCheckpointRecoveryState(left: ManifestCheckpoint, right: ManifestCheckpoint): boolean {
	return left.authority === right.authority
		&& JSON.stringify(left.manifest) === JSON.stringify(right.manifest)
		&& JSON.stringify(left.settledUploads) === JSON.stringify(right.settledUploads)
		&& JSON.stringify(left.restoreIntents) === JSON.stringify(right.restoreIntents)
		&& JSON.stringify(left.initialConfigPull) === JSON.stringify(right.initialConfigPull)
		&& left.initialImportToken === right.initialImportToken
		&& JSON.stringify([...left.renames]) === JSON.stringify([...right.renames]);
}

export function parseLocalManifest(value: unknown): FileManifest {
	if (!isRecord(value) || value.version !== CHECKPOINT_VERSION
		|| (value.lastSeq !== undefined && !isSyncSequence(value.lastSeq))
		|| (value.truncated !== undefined && value.truncated !== false)) throw new Error('Invalid manifest checkpoint');
	return { version: 1, files: parseSyncFiles(value.files, true),
		...(value.lastSeq === undefined ? {} : { lastSeq: value.lastSeq }) };
}
