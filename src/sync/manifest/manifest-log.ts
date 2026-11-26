import { isRecord } from '../../platform/validation';
import { isSyncSequence, isSyncPath, parseSyncFiles } from '../../protocol/sync-validation';
import type { FileEntry } from '../../protocol/sync-types';
import { CHECKPOINT_VERSION, parseCheckpoint, type ManifestCheckpoint } from './manifest-checkpoint';
import { MAX_UPLOAD_DIAGNOSTICS, normalizeUploadDiagnostics, type UploadDiagnostic } from '../diagnostics/upload-diagnostics';
import { getSyncPathIssue } from '../../protocol/portable-path';
import { reminderOperationDay } from '../../protocol/reminder-operation';

/**
 * Append-only changes since a full manifest checkpoint. A save writes only the
 * entries it changed, so a large vault does not rewrite its whole baseline on
 * every queue flush. The header binds the log to one base generation: a log
 * whose base differs from the selected checkpoint predates a compaction and is
 * ignored, because that checkpoint already contains its records.
 */
const LOG_VERSION = 1;

export type ManifestLogState = Omit<ManifestCheckpoint, 'manifest' | 'generation' | 'authority'>;

/** Persisted checkpoint key -> owner field, for the small non-file recovery state each
 * record repeats when it changes. Rename dependencies and upload receipts can hold one
 * row per file of a large move, so records carry only their changed rows; upload
 * diagnostics only their new rows. */
const STATE_FIELDS = {
	initialConfigPull: 'initialConfigPull', initialImportToken: 'initialImportToken', restoreIntents: 'restoreIntents',
} as const satisfies Record<string, keyof ManifestLogState>;

/** Each recovery field as JSON text, with `null` for an absent or empty value. */
export type EncodedLogState = Record<keyof typeof STATE_FIELDS, string>;

/** Replay appends a record's new diagnostic rows. */
const APPENDED_DIAGNOSTICS = 'appendedUploadDiagnostics';
const RENAME_CHANGES = 'renameChanges';
const RECEIPT_CHANGES = 'settledUploadChanges';

export function encodeLogState(state: Pick<ManifestLogState, keyof EncodedLogState>): EncodedLogState {
	const json = (value: unknown, present: unknown) => present ? JSON.stringify(value) : 'null';
	return {
		initialConfigPull: json(state.initialConfigPull, state.initialConfigPull),
		initialImportToken: json(state.initialImportToken, state.initialImportToken),
		restoreIntents: json(state.restoreIntents, state.restoreIntents.length),
	};
}

/** Rows that turn one ordered map into another. Replay deletes `delete`, then sets `set`
 * in order, which also reproduces the map's insertion order. */
export interface OrderedChanges { delete: string[]; set: Array<[string, string]> }

/** The changes from `before` to `after`, or null when they are equal. Keys both keep in
 * their old order stay in place; every key after the first one out of order was inserted
 * since, so replay deletes it and appends it again. */
export function diffOrdered(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): OrderedChanges | null {
	const position = new Map<string, number>();
	for (const key of before.keys()) position.set(key, position.size);
	const changes: OrderedChanges = { delete: [], set: [] };
	let last = -1, appending = false;
	for (const [key, value] of after) {
		const at = position.get(key);
		if (!appending && at !== undefined && at > last) {
			last = at;
			if (before.get(key) !== value) changes.set.push([key, value]);
			continue;
		}
		appending = true;
		if (at !== undefined) changes.delete.push(key);
		changes.set.push([key, value]);
	}
	for (const key of before.keys()) if (!after.has(key)) changes.delete.push(key);
	return changes.delete.length || changes.set.length ? changes : null;
}

function applyOrdered(map: Map<string, string>, changes: OrderedChanges): void {
	for (const key of changes.delete) map.delete(key);
	for (const [key, value] of changes.set) map.set(key, value);
}

export interface ManifestLogRecord {
	generation: number;
	set: Record<string, FileEntry>;
	deleted: string[];
	/**
	 * Recovery fields that differ from `previous` (the state already on disk), so
	 * large rename or receipt state is not repeated by every file change. `null`
	 * clears a field.
	 */
	state: EncodedLogState;
	previous: EncodedLogState | undefined;
	/** Rename dependency rows changed since the previous record. */
	renames: OrderedChanges | null;
	/** Upload receipts added or removed since the previous record. */
	settledUploads: OrderedChanges | null;
	/** Diagnostic rows recorded since the previous record. */
	uploadDiagnostics: readonly UploadDiagnostic[];
}

export function encodeLogHeader(base: number, authority: string | undefined): string {
	return `${JSON.stringify({ version: LOG_VERSION, base, ...(authority === undefined ? {} : { authority }) })}\n`;
}

export function encodeLogRecord(record: ManifestLogRecord): string {
	const changes = (Object.keys(record.state) as Array<keyof EncodedLogState>)
		.filter(key => record.state[key] !== record.previous?.[key])
		.map(key => `${JSON.stringify(key)}:${record.state[key]}`);
	if (record.renames) changes.push(`"${RENAME_CHANGES}":${JSON.stringify(record.renames)}`);
	if (record.settledUploads) changes.push(`"${RECEIPT_CHANGES}":${JSON.stringify({ delete: record.settledUploads.delete, add: record.settledUploads.set.map(([id]) => id) })}`);
	if (record.uploadDiagnostics.length) changes.push(`"${APPENDED_DIAGNOSTICS}":${JSON.stringify(record.uploadDiagnostics)}`);
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
		if (record.renames) {
			const renames = new Map(checkpoint.renames);
			applyOrdered(renames, record.renames);
			checkpoint.renames = renames;
		}
		if (record.settledUploads) {
			const receipts = new Map(checkpoint.settledUploads.map(id => [id, id]));
			applyOrdered(receipts, record.settledUploads);
			checkpoint.settledUploads = [...receipts.keys()];
		}
		if (record.appendedDiagnostics.length) checkpoint.uploadDiagnostics = [...checkpoint.uploadDiagnostics, ...record.appendedDiagnostics].slice(-MAX_UPLOAD_DIAGNOSTICS);
		applied++;
	}
	return { applied, appendable: text.endsWith('\n') };
}

function parseLine(line: string): unknown {
	try { return JSON.parse(line) as unknown; } catch { return undefined; }
}

const invalidLog = () => new Error('Invalid manifest change log. Preserve this vault and its metadata before recovering sync.');
const isStringArray = (value: unknown, valid: (item: string) => boolean): value is string[] =>
	Array.isArray(value) && value.every(item => typeof item === 'string' && valid(item));
const isPath = (path: string) => !getSyncPathIssue(path);
const isReceipt = (id: string) => reminderOperationDay(id) !== null;

function parseRenameChanges(value: unknown): OrderedChanges | null {
	if (value === undefined) return null;
	if (!isRecord(value) || !isStringArray(value.delete, isPath) || !Array.isArray(value.set)
		|| !value.set.every((row: unknown) => Array.isArray(row) && row.length === 2 && isStringArray(row, isPath))) throw invalidLog();
	return { delete: value.delete, set: value.set as Array<[string, string]> };
}

function parseReceiptChanges(value: unknown): OrderedChanges | null {
	if (value === undefined) return null;
	if (!isRecord(value) || !isStringArray(value.delete, isReceipt) || !isStringArray(value.add, isReceipt)) throw invalidLog();
	return { delete: value.delete, set: value.add.map(id => [id, id]) };
}

function parseRecord(value: unknown, checkpoint: ManifestCheckpoint): {
	generation: number; set: Record<string, FileEntry>; deleted: string[]; state: Partial<ManifestLogState>;
	renames: OrderedChanges | null; settledUploads: OrderedChanges | null; appendedDiagnostics: UploadDiagnostic[];
} {
	const changes = isRecord(value) ? value.changes : undefined;
	if (!isRecord(value) || !isSyncSequence(value.generation) || !Array.isArray(value.deleted)
		|| !value.deleted.every((path: unknown) => typeof path === 'string' && isSyncPath(path)) || !isRecord(changes)) {
		throw new Error('Invalid manifest change log. Preserve this vault and its metadata before recovering sync.');
	}
	// Reuse the checkpoint validators for the non-file state; `null` parses as empty.
	const present = Object.fromEntries(Object.entries(changes).filter(([key, field]) => key in STATE_FIELDS && field !== null));
	const { manifest: _files, generation: _generation, authority: _authority, ...parsed } = parseCheckpoint({
		...present, version: CHECKPOINT_VERSION, files: {}, generation: value.generation,
		...(checkpoint.authority === undefined ? {} : { authority: checkpoint.authority }),
	});
	// A record replaces only the fields it names.
	const state = Object.fromEntries((Object.keys(STATE_FIELDS) as Array<keyof typeof STATE_FIELDS>)
		.filter(key => key in changes).map(key => [STATE_FIELDS[key], parsed[STATE_FIELDS[key]]])) as Partial<ManifestLogState>;
	return { generation: value.generation, set: parseSyncFiles(value.set, true), deleted: value.deleted, state,
		renames: parseRenameChanges(changes[RENAME_CHANGES]), settledUploads: parseReceiptChanges(changes[RECEIPT_CHANGES]),
		appendedDiagnostics: normalizeUploadDiagnostics(changes[APPENDED_DIAGNOSTICS]) };
}
