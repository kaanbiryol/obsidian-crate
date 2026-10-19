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

export type ManifestLogState = Omit<ManifestCheckpoint, 'manifest' | 'generation' | 'authority'>;

/** Persisted checkpoint key -> owner field, for the non-file recovery state. */
const STATE_FIELDS = {
	appliedRename: 'appliedRename', initialConfigPull: 'initialConfigPull', restoreIntents: 'restoreIntents',
	uploadDiagnostics: 'uploadDiagnostics', settledUploads: 'settledUploads', renameDependencies: 'renames',
} as const satisfies Record<string, keyof ManifestLogState>;

/** Each recovery field as JSON text, with `null` for an absent or empty value. */
export type EncodedLogState = Record<keyof typeof STATE_FIELDS, string>;

export function encodeLogState(state: ManifestLogState): EncodedLogState {
	const json = (value: unknown, present: unknown) => present ? JSON.stringify(value) : 'null';
	return {
		appliedRename: json(state.appliedRename, state.appliedRename),
		initialConfigPull: json(state.initialConfigPull, state.initialConfigPull),
		restoreIntents: json(state.restoreIntents, state.restoreIntents.length),
		uploadDiagnostics: json(state.uploadDiagnostics, state.uploadDiagnostics.length),
		settledUploads: json(state.settledUploads, state.settledUploads.length),
		renameDependencies: state.renames.size ? JSON.stringify(Object.fromEntries(state.renames)) : 'null',
	};
}

export interface ManifestLogRecord {
	generation: number;
	set: Record<string, FileEntry>;
	deleted: string[];
	/**
	 * Recovery fields that differ from `previous` (the state already on disk), so
	 * large rename or receipt state is not repeated by every file change. `null`
	 * clears a field. Records from before this format carry the full `state`.
	 */
	state: EncodedLogState;
	previous: EncodedLogState | undefined;
}

export function encodeLogHeader(base: number, authority: string | undefined): string {
	return `${JSON.stringify({ version: LOG_VERSION, base, ...(authority === undefined ? {} : { authority }) })}\n`;
}

export function encodeLogRecord(record: ManifestLogRecord): string {
	const changes = (Object.keys(record.state) as Array<keyof EncodedLogState>)
		.filter(key => record.state[key] !== record.previous?.[key])
		.map(key => `${JSON.stringify(key)}:${record.state[key]}`);
	const head = JSON.stringify({ generation: record.generation, set: record.set, deleted: record.deleted });
	return `${head.slice(0, -1)},"changes":{${changes.join(',')}}}\n`;
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

function parseRecord(value: unknown, checkpoint: ManifestCheckpoint): { generation: number; set: Record<string, FileEntry>; deleted: string[]; state: Partial<ManifestLogState> } {
	const changes = isRecord(value) ? value.changes ?? value.state : undefined;
	if (!isRecord(value) || !isSyncSequence(value.generation) || !Array.isArray(value.deleted)
		|| !value.deleted.every((path: unknown) => typeof path === 'string' && isSyncPath(path)) || !isRecord(changes)) {
		throw new Error('Invalid manifest change log. Preserve this vault and its metadata before recovering sync.');
	}
	// Reuse the checkpoint validators for the non-file state; `null` parses as empty.
	const present = Object.fromEntries(Object.entries(changes).filter(([, field]) => field !== null));
	const { manifest: _files, generation: _generation, authority: _authority, ...parsed } = parseCheckpoint({
		...present, version: CHECKPOINT_VERSION, files: {}, generation: value.generation,
		...(checkpoint.authority === undefined ? {} : { authority: checkpoint.authority }),
	});
	// A full `state` record replaces every field; a `changes` record only the ones it names.
	const state = 'changes' in value ? Object.fromEntries((Object.keys(STATE_FIELDS) as Array<keyof typeof STATE_FIELDS>)
		.filter(key => key in changes).map(key => [STATE_FIELDS[key], parsed[STATE_FIELDS[key]]])) as Partial<ManifestLogState> : parsed;
	return { generation: value.generation, set: parseSyncFiles(value.set, true), deleted: value.deleted, state };
}
