import { MAX_ENCRYPTED_REMINDER_REQUEST_BYTES, isReceiptEnvelope } from '../../../encryption/receipt-format';

import { ENCRYPTED_INVENTORY_PAGE, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES } from '../../../encryption/file-inventory';
import { ENCRYPTED_FILE_CONTENT_TYPE, MAX_ENCRYPTED_FILE_BYTES } from '../../../encryption/file-format';
import { fileFolderArgs } from '../sync/file-identity';
import { corsHeaders, corsResponse } from '../http/cors';
import { parseJsonObject, sanitizePath } from '../http/request-validation';
import { readEncryptionState, prepareEncryptedFileCommit, EncryptionStateError } from './state';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { getStoredFileRow, loadStoredFileRows, MAX_BATCH_DOWNLOAD_BYTES, MAX_BATCH_DOWNLOAD_FILES, storedObjectMatchesMetadata } from '../sync/storage';
import { changedPathsSince, deltaBase, parseDeltaBase, readVaultChangeState, vaultChangeToken } from '../sync/change-token';
import { portablePathKey } from '../../../protocol/portable-path';
import { mapBounded } from '../../../platform/map-bounded';
import { SIMULTANEOUS_OPEN_CONNECTIONS } from '../d1/platform-limits';
import { stageMarkdownFile, stageMarkdownFiles } from '../sync/markdown-file-staging';
import { writeCommittedMarkdownFilePair } from '../sync/atomic-markdown-write';
import { writeCommittedMarkdownMove } from '../sync/atomic-markdown-move';
import { commitFileDelete, commitFileDeletes, commitStagedFile } from '../sync/mutations';
import { FileVersionConflictError } from '../sync/markdown-files';
import { beginReminderOperation, reminderOperationEffects } from '../reminders/operations';
import { isSyncRevision } from '../../../protocol/sync-validation';
import { FILE_HASH_HEADER, REVISION_HEADER } from '../../../protocol/http-headers';
import type { Env } from '../types';
import { isSha256Hex } from '../../../platform/validation';
import { isMarkdownNoteInFolder, isMarkdownPath, isPathInFolder } from '../../../protocol/note-paths';

interface EncryptedWebFile { path: string; content: string; expectedHash: string | null; expectedRevision?: string }

/** `anyFile` also accepts files that are not notes, such as an article's saved images. */
function scopedPath(value: unknown, folder: string, anyFile = false): string | null {
	if (typeof value !== 'string') return null;
	const path = sanitizePath(value);
	return path && path === value && (anyFile ? isPathInFolder(path, folder) : isMarkdownNoteInFolder(path, folder)) ? path : null;
}

const isFolder = (value: unknown): value is string => typeof value === 'string' && !!value && sanitizePath(value) === value;

const FEATURE_LABELS = { reminders: 'reminders', reading: 'Reading' } as const;

/** Serve encrypted note inventory, downloads and commits for the reminders and Reading apps. */
/** `authenticated` is the encryption state authentication already read for this request. */
export async function handleEncryptedFolderFiles(request: Request, env: Env, path: string, feature: keyof typeof FEATURE_LABELS = 'reminders', expectedFolder?: string, authenticated?: EncryptionServerState | null): Promise<Response | null> {
	const prefix = `/${feature}`;
	const label = FEATURE_LABELS[feature];
	if (![`${prefix}/encrypted-files`, `${prefix}/encrypted-files/download`, `${prefix}/encrypted-file`, `${prefix}/encrypted-commit`].includes(path)) return null;
	const state = authenticated !== undefined ? authenticated : await readEncryptionState(env.DB);
	if (!state || state.mode !== 'active') throw new EncryptionStateError(`Finish setting up encryption before using encrypted ${label}`);
	if (path === `${prefix}/encrypted-commit` && request.method === 'POST') return commitEncryptedFiles(request, env, state, expectedFolder, feature === 'reading');
	if (path === `${prefix}/encrypted-files/download` && request.method === 'POST') return downloadEncryptedFiles(request, env, label, expectedFolder);
	if (request.method !== 'GET') return null;
	const params = new URL(request.url).searchParams;
	const folder = params.get('folderPath');
	if (!isFolder(folder) || (expectedFolder && folder !== expectedFolder)) return corsResponse({ error: `Unknown encrypted ${label} folder` }, 403);
	if (path === `${prefix}/encrypted-files`) return listEncryptedFiles(request, env, state, folder, params);
	// The Reading app also shows the images saved beside its notes. Their names are tags, so
	// the server sees only that a file in the folder is not a note.
	const filePath = scopedPath(params.get('path'), folder, feature === 'reading');
	if (!filePath) return corsResponse({ error: 'File is outside this enrollment' }, 403);
	const file = await getStoredFileRow(env.DB, filePath);
	if (!file) return corsResponse({ error: 'Note not found' }, 404);
	if (params.get('revision') && params.get('revision') !== file.storageKey) return corsResponse({ error: 'Note changed', code: 'version_conflict' }, 409);
	if (file.size > (isMarkdownPath(filePath) ? MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES : MAX_ENCRYPTED_FILE_BYTES)) return corsResponse({ error: `This note is too large for the ${label} app` }, 413);
	const object = await env.BUCKET.get(file.storageKey);
	if (!object || !storedObjectMatchesMetadata(object, file)) return corsResponse({ error: 'Note is unavailable' }, 503);
	return new Response(object.body, { headers: { ...corsHeaders(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE,
		'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', [FILE_HASH_HEADER]: file.hash, [REVISION_HEADER]: file.storageKey } });
}

interface InventoryRow { path: string; portable_path: string; hash: string; size: number; revision: string; modified: string }
// `modified` is the server's own time of the last write, which it already knows; the
// Reading app keeps the most recently changed notes when a library exceeds its limit.
const INVENTORY_COLUMNS = 'path, portable_path, hash, size, storage_key AS revision, modified';
const inventoryEntry = ({ path, hash, size, revision, modified }: InventoryRow) => ({ path, hash, size, revision, modified });

/** One inventory page, or with `since` only the folder notes changed after that delta base.
 * `If-None-Match` with the last change token answers 304 before the folder is read. Rows
 * are read between two equal reads of the vault change state, so each 200 is one snapshot
 * at its `changeToken`, and pages reporting the same token belong to one snapshot. */
async function listEncryptedFiles(request: Request, env: Env, state: EncryptionServerState, folder: string, params: URLSearchParams): Promise<Response> {
	const after = params.get('after') ?? '';
	if (after.length > 1024) return corsResponse({ error: 'Invalid file cursor' }, 400);
	const scope = `encrypted-files\nfolder:${folder}\ngeneration:${state.generation}`;
	const change = await readVaultChangeState(env.DB);
	const changeToken = await vaultChangeToken(env.DB, scope, change);
	const headers = { 'Cache-Control': 'private, no-cache', ETag: `"${changeToken}"` };
	if (!after && request.headers.get('If-None-Match')?.split(',').some(value => value.trim() === headers.ETag)) {
		return new Response(null, { status: 304, headers: { ...corsHeaders(), ...headers } });
	}
	const base = await deltaBase(scope, change);
	const since = after ? null : parseDeltaBase(params.get('since'));
	// The change state already read the changelog bounds, so a delta costs one more query.
	const changed = since && since.scope === base.slice(base.indexOf('.') + 1)
		? await changedPathsSince(env.DB, folder, since.seq, change.bounds) : null;
	const snapshot = { generation: state.generation, changeToken, deltaBase: base };
	// No folder path changed, so no rows were read that a concurrent write could split.
	if (changed?.length === 0) return corsResponse({ delta: true, files: [], removed: [], ...snapshot }, 200, headers);
	let body: Record<string, unknown>;
	if (changed && changed.length <= ENCRYPTED_INVENTORY_PAGE) {
		const rows = await env.DB.prepare(`SELECT ${INVENTORY_COLUMNS} FROM files WHERE portable_path IN (SELECT value FROM json_each(?))`)
			.bind(JSON.stringify([...new Set(changed.map(portablePathKey))])).all<InventoryRow>();
		const listed = new Set(changed);
		const files = rows.results.filter(file => listed.has(file.path) && scopedPath(file.path, folder));
		const present = new Set(files.map(file => file.path));
		body = { delta: true, files: files.map(inventoryEntry), removed: changed.filter(path => !present.has(path) && scopedPath(path, folder)) };
	} else {
		// Page in primary-key order from a single lower bound, so each page reads only
		// its own rows. The cursor is opaque to clients.
		const [keyStart = '', keyEnd, pathStart, pathEnd] = fileFolderArgs(folder);
		const [lower, lowerBound] = after >= keyStart ? ['portable_path > ?', after] : ['portable_path >= ?', keyStart];
		const rows = await env.DB.prepare(`SELECT ${INVENTORY_COLUMNS} FROM files
			WHERE ${lower} AND portable_path < ? AND path >= ? AND path < ? AND lower(path) LIKE '%.md'
			ORDER BY portable_path LIMIT ${ENCRYPTED_INVENTORY_PAGE}`)
			.bind(lowerBound, keyEnd, pathStart, pathEnd).all<InventoryRow>();
		body = { files: rows.results.filter(file => scopedPath(file.path, folder)).map(inventoryEntry),
			nextCursor: rows.results.length === ENCRYPTED_INVENTORY_PAGE ? rows.results.at(-1)!.portable_path : null };
	}
	// A write since the first read could pair these rows with another snapshot.
	if (await vaultChangeToken(env.DB, scope) !== changeToken) {
		return corsResponse({ error: 'Files changed while listing. Refresh again.', code: 'inventory_changed' }, 409);
	}
	return corsResponse({ ...body, ...snapshot }, 200, headers);
}

interface DownloadedNote { path: string; revision: string; hash?: string; size?: number; content?: string; error?: string; code?: string }

/** Up to 50 listed notes and 8 MB in one response, each at the revision the client listed.
 * A note that changed, disappeared or cannot be read is reported on its own entry, so the
 * client decides whether to list again. */
async function downloadEncryptedFiles(request: Request, env: Env, label: string, expectedFolder?: string): Promise<Response> {
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const { folderPath, files: raw } = parsed.value;
	if (Object.keys(parsed.value).some(key => !['folderPath', 'files'].includes(key))) return corsResponse({ error: 'Unexpected download field' }, 400);
	if (!isFolder(folderPath) || (expectedFolder && folderPath !== expectedFolder)) return corsResponse({ error: `Unknown encrypted ${label} folder` }, 403);
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH_DOWNLOAD_FILES) {
		return corsResponse({ error: `files array required (maximum ${MAX_BATCH_DOWNLOAD_FILES})` }, 400);
	}
	const requested: Array<{ path: string; revision: string }> = [];
	for (const entry of raw as unknown[]) {
		const file = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
		if (Object.keys(file).some(key => !['path', 'revision'].includes(key)) || typeof file.path !== 'string' || !isSyncRevision(file.revision)) {
			return corsResponse({ error: 'Invalid note in batch' }, 400);
		}
		const path = scopedPath(file.path, folderPath);
		if (!path) return corsResponse({ error: 'File is outside this enrollment' }, 403);
		requested.push({ path, revision: file.revision });
	}
	if (new Set(requested.map(file => file.path)).size !== requested.length) return corsResponse({ error: 'Duplicate paths are not allowed' }, 400);
	const stored = await loadStoredFileRows(env.DB, requested.map(file => file.path));
	const declared = requested.reduce((total, file) => {
		const row = stored.get(file.path);
		return total + (row?.storageKey === file.revision && row.size <= MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES ? row.size : 0);
	}, 0);
	if (declared > MAX_BATCH_DOWNLOAD_BYTES) return corsResponse({ error: 'Batch download exceeds 8MB limit; download fewer notes' }, 413);
	const download = async (file: { path: string; revision: string }): Promise<DownloadedNote> => {
		const row = stored.get(file.path);
		if (!row) return { ...file, error: 'Note not found', code: 'not_found' };
		if (row.storageKey !== file.revision) return { ...file, error: 'Note changed', code: 'version_conflict' };
		if (row.size > MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES) return { ...file, error: `This note is too large for the ${label} app`, code: 'file_too_large' };
		const object = await env.BUCKET.get(row.storageKey);
		if (!object || !storedObjectMatchesMetadata(object, row)) return { ...file, error: 'Note is unavailable', code: 'unavailable' };
		// Encrypted files are UTF-8 text, so they travel as JSON strings without base64.
		// The client encodes each again and checks it against the listed size and hash.
		try {
			return { ...file, hash: row.hash, size: row.size, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await object.arrayBuffer()) };
		} catch {
			return { ...file, error: 'Note is unavailable', code: 'unavailable' };
		}
	};
	// A rolling pool keeps as many R2 reads in flight as the invocation may open.
	return corsResponse({ files: await mapBounded(requested, SIMULTANEOUS_OPEN_CONNECTIONS, download) }, 200, { 'Cache-Control': 'private, no-store' });
}

/** Images a new Reading note links to, committed with it. */
const MAX_ENCRYPTED_ATTACHMENTS = 10;
/** Images a deleted Reading note linked to, deleted after it: as many as Obsidian saves for one article. */
const MAX_REMOVED_ATTACHMENTS = 30;

async function deleteEncryptedAttachments(db: D1Database, paths: string[]): Promise<void> {
	const stored = await loadStoredFileRows(db, paths);
	await commitFileDeletes(db, [...stored].map(([path, row]) => ({ path, expectedHash: row.hash, expectedRevision: row.storageKey, previousFile: row })));
}

async function commitEncryptedFiles(request: Request, env: Env, state: EncryptionServerState, expectedFolder?: string, allowAttachments = false): Promise<Response> {
	const parsed = await parseJsonObject(request, MAX_ENCRYPTED_REMINDER_REQUEST_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	if (Object.keys(body).some(key => !['folderPath', 'operationId', 'files', 'remove', 'acknowledgment', 'createdId', ...(allowAttachments ? ['attachments', 'removeAttachments'] : [])].includes(key))) return corsResponse({ error: 'Unexpected encrypted mutation field' }, 400);
	if ((expectedFolder && body.folderPath !== expectedFolder) || !isFolder(body.folderPath)
		|| !Array.isArray(body.files) || body.files.length > 2 || (body.files.length < 1 && body.remove === undefined)
		|| !isReceiptEnvelope(body.acknowledgment)) return corsResponse({ error: 'Invalid encrypted mutation' }, 400);
	const operation = await beginReminderOperation(env.DB, body, 'encrypted-files');
	if (operation instanceof Response) return operation;
	if (body.createdId !== undefined && body.createdId !== operation.id) return corsResponse({ error: 'Invalid created reminder identity' }, 400);
	const files: EncryptedWebFile[] = [];
	for (const raw of body.files as unknown[]) {
		if (!raw || typeof raw !== 'object') return corsResponse({ error: 'Invalid encrypted file' }, 400);
		const file = raw as Partial<EncryptedWebFile>;
		const filePath = scopedPath(file.path, body.folderPath);
		if (Object.keys(file).some(key => !['path', 'content', 'expectedHash', 'expectedRevision'].includes(key)) || !filePath
			|| typeof file.content !== 'string' || new TextEncoder().encode(file.content).byteLength > MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES
			|| (file.expectedHash !== null && (typeof file.expectedHash !== 'string' || !isSha256Hex(file.expectedHash)))
			|| (file.expectedHash !== null && !isSyncRevision(file.expectedRevision))) return corsResponse({ error: 'Invalid encrypted file precondition' }, 400);
		await prepareEncryptedFileCommit(env.DB, filePath, file.content, state);
		files.push({ path: filePath, content: file.content, expectedHash: file.expectedHash!, expectedRevision: file.expectedRevision });
	}
	if (new Set(files.map(file => file.path)).size !== files.length) return corsResponse({ error: 'Duplicate file path' }, 400);
	// A rename creates one new note and deletes its source in the same transaction;
	// a delete names only the source.
	let removed: { path: string; expectedHash: string; expectedRevision: string } | undefined;
	if (body.remove !== undefined) {
		const [raw] = Array.isArray(body.remove) && body.remove.length === 1 ? body.remove as unknown[] : [];
		const source = raw && typeof raw === 'object' ? raw as Partial<EncryptedWebFile> : undefined;
		const sourcePath = scopedPath(source?.path, body.folderPath);
		if (!source || !sourcePath || Object.keys(source).some(key => !['path', 'expectedHash', 'expectedRevision'].includes(key))
			|| typeof source.expectedHash !== 'string' || !isSha256Hex(source.expectedHash) || !isSyncRevision(source.expectedRevision)
			|| files.length > 1 || files.length === 1 && (files[0]!.expectedHash !== null || sourcePath === files[0]!.path)) return corsResponse({ error: 'Invalid encrypted rename' }, 400);
		removed = { path: sourcePath, expectedHash: source.expectedHash, expectedRevision: source.expectedRevision };
	}
	// Files that are not notes, such as a saved article's images: new files only, beside one new note.
	const attachments: Array<{ path: string; content: string }> = [];
	if (body.attachments !== undefined) {
		if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ENCRYPTED_ATTACHMENTS || files.length !== 1 || files[0]!.expectedHash !== null || removed)
			return corsResponse({ error: 'Invalid encrypted attachments' }, 400);
		for (const raw of body.attachments as unknown[]) {
			const attachment = raw && typeof raw === 'object' ? raw as Partial<EncryptedWebFile> : undefined;
			const attachmentPath = scopedPath(attachment?.path, body.folderPath, true);
			if (!attachment || !attachmentPath || isMarkdownPath(attachmentPath) || Object.keys(attachment).some(key => !['path', 'content'].includes(key))
				|| typeof attachment.content !== 'string' || attachments.some(other => other.path === attachmentPath)) return corsResponse({ error: 'Invalid encrypted attachment' }, 400);
			await prepareEncryptedFileCommit(env.DB, attachmentPath, attachment.content, state);
			attachments.push({ path: attachmentPath, content: attachment.content });
		}
	}
	// A deleted note's images, by tag: the server cannot tell which files belong to which note.
	const removedAttachments: string[] = [];
	if (body.removeAttachments !== undefined) {
		if (!Array.isArray(body.removeAttachments) || body.removeAttachments.length > MAX_REMOVED_ATTACHMENTS || !removed || files.length)
			return corsResponse({ error: 'Invalid encrypted attachment removal' }, 400);
		for (const raw of body.removeAttachments as unknown[]) {
			const attachmentPath = scopedPath(raw, body.folderPath, true);
			if (!attachmentPath || isMarkdownPath(attachmentPath) || removedAttachments.includes(attachmentPath)) return corsResponse({ error: 'Invalid encrypted attachment removal' }, 400);
			removedAttachments.push(attachmentPath);
		}
	}
	const response = { encrypted: body.acknowledgment };
	const effects = reminderOperationEffects(env.DB, operation, response, typeof body.createdId === 'string' ? body.createdId : undefined);
	try {
		// Attachments publish before the note that links to them. One that already exists is
		// kept: a retry of this attempt finds its own copy, and nothing else is overwritten.
		// One lookup and one lease keep this within the invocation's query limit.
		const stored = await loadStoredFileRows(env.DB, attachments.map(attachment => attachment.path));
		const added = attachments.filter(attachment => !stored.has(attachment.path));
		const staged = added.length ? await stageMarkdownFiles(env.BUCKET, env.DB, added.map(attachment => ({ ...attachment, expectedHash: null })), true) : [];
		for (const [index, file] of staged.entries()) await commitStagedFile(env.BUCKET, env.DB, { ...file, content: added[index]!.content, encryptionState: state });
		if (removed && !files.length) {
			const result = await commitFileDelete(env.DB, { ...removed, previousFile: await getStoredFileRow(env.DB, removed.path), effects });
			if (!result.committed) throw new FileVersionConflictError(removed.path, result.currentHash);
			// Then its images, each at its current revision. A failure leaves them for Obsidian's
			// cleanup; the deleted note is already committed.
			await deleteEncryptedAttachments(env.DB, removedAttachments).catch(() => {});
		} else if (removed) {
			await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: removed, destination: files[0]!, effects, context: { encryptionState: state } });
		} else if (files.length === 2) {
			const [source, destination] = files;
			if (!source?.expectedHash) return corsResponse({ error: 'A move requires an existing source note' }, 400);
			await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, { source: { ...source, expectedHash: source.expectedHash }, destination: destination!, effects, context: { encryptionState: state } });
		} else {
			const file = files[0]!;
			const staged = await stageMarkdownFile(env.BUCKET, env.DB, file.path, file.content, file.expectedHash, true);
			// Publication rechecks this state in its own transaction.
			const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content: file.content,
				expectedRevision: file.expectedRevision, effects, encryptionState: state });
			if (!result.committed) throw new FileVersionConflictError(file.path, result.currentHash);
		}
		return corsResponse(response);
	} catch (error) {
		// A concurrent copy may have committed the same immutable attempt.
		const replay = await beginReminderOperation(env.DB, body, 'encrypted-files');
		if (replay instanceof Response) return replay;
		if (error instanceof FileVersionConflictError) return corsResponse({ error: 'A note changed. Refresh before retrying.', code: 'version_conflict' }, 409);
		throw error;
	}
}
