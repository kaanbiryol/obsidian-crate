import { isRecord } from '../platform/validation';
import { isSyncSequence, isSyncPath, parseSyncFiles } from '../protocol/sync-validation';
import type { FileEntry } from '../protocol/sync-types';
import { CHECKPOINT_VERSION, parseCheckpoint, type ManifestCheckpoint } from './manifest-checkpoint';

/**
 * Append-only changes since a full manifest checkpoint. A save writes only the
 * entries it changed, so a large vault does not rewrite its whole baseline on
 * every queue flush. The header binds the log to one base generation: a log
 * whose base differs from the selected checkpoint predates a compaction and is
 * ignored, because that checkpoint already contains its records.
 */
const LOG_VERSION = 1;

export interface ManifestLogRecord {
	generation: number;
	set: Record<string, FileEntry>;
	deleted: string[];
	/** Every non-file checkpoint field, replacing the previous values. */
	state: Omit<ManifestCheckpoint, 'manifest' | 'generation' | 'authority'>;
}

export function encodeLogHeader(base: number, authority: string | undefined): string {
	return `${JSON.stringify({ version: LOG_VERSION, base, ...(authority === undefined ? {} : { authority }) })}\n`;
}

export function encodeLogRecord(record: ManifestLogRecord): string {
	const { state } = record;
	return `${JSON.stringify({
		generation: record.generation,
		set: record.set,
		deleted: record.deleted,
		state: {
			...(state.appliedRename ? { appliedRename: state.appliedRename } : {}),
			...(state.initialConfigPull ? { initialConfigPull: state.initialConfigPull } : {}),
			...(state.restoreIntents.length ? { restoreIntents: state.restoreIntents } : {}),
			...(state.uploadDiagnostics.length ? { uploadDiagnostics: state.uploadDiagnostics } : {}),
			...(state.settledUploads.length ? { settledUploads: state.settledUploads } : {}),
			...(state.renames.size ? { renameDependencies: Object.fromEntries(state.renames) } : {}),
		},
	})}\n`;
}

/**
 * Applies the log's consecutive records to `checkpoint` in place, or returns null
 * when the log belongs to a different base. Only the final line can be torn by an
 * interrupted append; it is dropped, and `appendable` is false so the owner
 * compacts before writing after it.
 */
export function replayManifestLog(checkpoint: ManifestCheckpoint, text: string): { applied: number; appendable: boolean } | null {
	const lines = text.split('\n');
	const header = parseLine(lines[0] ?? '');
	if (!isRecord(header) || header.version !== LOG_VERSION || header.base !== checkpoint.generation
		|| (header.authority ?? undefined) !== checkpoint.authority) return null;
	let applied = 0;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line) continue;
		const value = parseLine(line);
		if (value === undefined) {
			if (lines.slice(index + 1).some(Boolean)) throw new Error('Invalid manifest change log. Preserve this vault and its metadata before recovering sync.');
			break;
		}
		const record = parseRecord(value, checkpoint);
		if (record.generation !== checkpoint.generation + 1) throw new Error('Invalid manifest change log. Preserve this vault and its metadata before recovering sync.');
		for (const [path, entry] of Object.entries(record.set)) checkpoint.manifest.files[path] = entry;
		for (const path of record.deleted) delete checkpoint.manifest.files[path];
		Object.assign(checkpoint, record.state, { generation: record.generation });
		applied++;
	}
	return { applied, appendable: text.endsWith('\n') };
}

function parseLine(line: string): unknown {
	try { return JSON.parse(line) as unknown; } catch { return undefined; }
}

function parseRecord(value: unknown, checkpoint: ManifestCheckpoint): ManifestLogRecord {
	if (!isRecord(value) || !isSyncSequence(value.generation) || !Array.isArray(value.deleted)
		|| !value.deleted.every((path: unknown) => typeof path === 'string' && isSyncPath(path)) || !isRecord(value.state)) {
		throw new Error('Invalid manifest change log. Preserve this vault and its metadata before recovering sync.');
	}
	// Reuse the checkpoint validators for the non-file state.
	const { manifest: _files, generation: _generation, authority: _authority, ...state } = parseCheckpoint({
		...value.state, version: CHECKPOINT_VERSION, files: {}, generation: value.generation,
		...(checkpoint.authority === undefined ? {} : { authority: checkpoint.authority }),
	});
	return { generation: value.generation, set: parseSyncFiles(value.set, true), deleted: value.deleted, state };
}
