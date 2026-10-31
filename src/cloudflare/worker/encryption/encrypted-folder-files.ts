import { MAX_ENCRYPTED_REMINDER_REQUEST_BYTES, isReceiptEnvelope } from '../../../encryption/receipt-format';

import { ENCRYPTED_INVENTORY_PAGE, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES } from '../../../encryption/file-inventory';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../encryption/file-format';
import { fileFolderArgs } from '../sync/file-identity';
import { corsHeaders, corsResponse } from '../cors';
import { parseJsonObject, sanitizePath } from '../request-validation';
import { readEncryptionState, prepareEncryptedFileCommit, EncryptionStateError } from './state';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { getStoredFileRow, storedObjectMatchesMetadata } from '../sync/storage';
import { stageMarkdownFile } from '../sync/markdown-file-staging';
import { writeCommittedMarkdownFilePair } from '../sync/atomic-markdown-write';
import { writeCommittedMarkdownMove } from '../sync/atomic-markdown-move';
import { commitFileDelete, commitStagedFile } from '../sync/mutations';
import { FileVersionConflictError } from '../storage';
import { beginReminderOperation, reminderOperationEffects } from '../reminders/operations';
import { isSyncRevision } from '../../../protocol/sync-validation';
import { FILE_HASH_HEADER, REVISION_HEADER } from '../../../protocol/http-headers';
import type { Env } from '../types';
import { isSha256Hex } from '../../../platform/validation';
import { isMarkdownNoteInFolder } from '../../../protocol/note-paths';

interface EncryptedWebFile { path: string; content: string; expectedHash: string | null; expectedRevision?: string }

function scopedPath(value: unknown, folder: string): string | null {
	if (typeof value !== 'string') return null;
	const path = sanitizePath(value);
	return path && path === value && isMarkdownNoteInFolder(path, folder) ? path : null;
}

const isFolder = (value: unknown): value is string => typeof value === 'string' && !!value && sanitizePath(value) === value;

const FEATURE_LABELS = { reminders: 'reminders', reading: 'Reading' } as const;

/** Serve encrypted note inventory, downloads and commits for the reminders and Reading apps. */
/** `authenticated` is the encryption state authentication already read for this request. */
export async function handleEncryptedFolderFiles(request: Request, env: Env, path: string, feature: keyof typeof FEATURE_LABELS = 'reminders', expectedFolder?: string, authenticated?: EncryptionServerState | null): Promise<Response | null> {
	const prefix = `/${feature}`;
	const label = FEATURE_LABELS[feature];
	if (![`${prefix}/encrypted-files`, `${prefix}/encrypted-file`, `${prefix}/encrypted-commit`].includes(path)) return null;
	const state = authenticated !== undefined ? authenticated : await readEncryptionState(env.DB);
	if (!state || state.mode !== 'active') throw new EncryptionStateError(`Finish setting up encryption before using encrypted ${label}`);
	if (path === `${prefix}/encrypted-commit` && request.method === 'POST') return commitEncryptedFiles(request, env, state, expectedFolder);
	if (request.method !== 'GET') return null;
	const params = new URL(request.url).searchParams;
	const folder = params.get('folderPath');
	if (!isFolder(folder) || (expectedFolder && folder !== expectedFolder)) return corsResponse({ error: `Unknown encrypted ${label} folder` }, 403);
	if (path === `${prefix}/encrypted-files`) {
		const after = params.get('after') ?? '';
		if (after.length > 1024) return corsResponse({ error: 'Invalid file cursor' }, 400);
		const sequence = await env.DB.prepare("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'changelog'), 0), COALESCE((SELECT snapshot_seq FROM initial_import), 0)) AS seq").first<{ seq: number }>();
		// Page in primary-key order from a single lower bound, so each page reads only
		// its own rows. The cursor is opaque to clients.
		const [keyStart = '', keyEnd, pathStart, pathEnd] = fileFolderArgs(folder);
		const [lower, lowerBound] = after >= keyStart ? ['portable_path > ?', after] : ['portable_path >= ?', keyStart];
		const rows = await env.DB.prepare(`SELECT path, portable_path, hash, size, storage_key AS revision FROM files
			WHERE ${lower} AND portable_path < ? AND path >= ? AND path < ? AND lower(path) LIKE '%.md'
			ORDER BY portable_path LIMIT ${ENCRYPTED_INVENTORY_PAGE}`)
			.bind(lowerBound, keyEnd, pathStart, pathEnd).all<{ path: string; portable_path: string; hash: string; size: number; revision: string }>();
		const files = rows.results.filter(file => scopedPath(file.path, folder))
			.map(({ path, hash, size, revision }) => ({ path, hash, size, revision }));
		return corsResponse({ files, sequence: sequence?.seq ?? 0, generation: state.generation,
			nextCursor: rows.results.length === ENCRYPTED_INVENTORY_PAGE ? rows.results.at(-1)!.portable_path : null });
	}
	const filePath = scopedPath(params.get('path'), folder);
	if (!filePath) return corsResponse({ error: 'File is outside this enrollment' }, 403);
	const file = await getStoredFileRow(env.DB, filePath);
	if (!file) return corsResponse({ error: 'Note not found' }, 404);
	if (params.get('revision') && params.get('revision') !== file.storageKey) return corsResponse({ error: 'Note changed', code: 'version_conflict' }, 409);
	if (file.size > MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES) return corsResponse({ error: `This note is too large for the ${label} app` }, 413);
	const object = await env.BUCKET.get(file.storageKey);
	if (!object || !storedObjectMatchesMetadata(object, file)) return corsResponse({ error: 'Note is unavailable' }, 503);
	return new Response(object.body, { headers: { ...corsHeaders(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE,
		'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', [FILE_HASH_HEADER]: file.hash, [REVISION_HEADER]: file.storageKey } });
}

async function commitEncryptedFiles(request: Request, env: Env, state: EncryptionServerState, expectedFolder?: string): Promise<Response> {
	const parsed = await parseJsonObject(request, MAX_ENCRYPTED_REMINDER_REQUEST_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	if (Object.keys(body).some(key => !['folderPath', 'operationId', 'files', 'remove', 'acknowledgment', 'createdId'].includes(key))) return corsResponse({ error: 'Unexpected encrypted mutation field' }, 400);
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
		await prepareEncryptedFileCommit(env.DB, filePath, file.content);
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
	const response = { encrypted: body.acknowledgment };
	const effects = reminderOperationEffects(env.DB, operation, response, typeof body.createdId === 'string' ? body.createdId : undefined);
	try {
		if (removed && !files.length) {
			const result = await commitFileDelete(env.DB, { ...removed, previousFile: await getStoredFileRow(env.DB, removed.path), effects });
			if (!result.committed) throw new FileVersionConflictError(removed.path, result.currentHash);
		} else if (removed) {
			await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: removed, destination: files[0]!, effects });
		} else if (files.length === 2) {
			const [source, destination] = files;
			if (!source?.expectedHash) return corsResponse({ error: 'A move requires an existing source note' }, 400);
			await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, { source: { ...source, expectedHash: source.expectedHash }, destination: destination!, effects });
		} else {
			const file = files[0]!;
			const staged = await stageMarkdownFile(env.BUCKET, env.DB, file.path, file.content, file.expectedHash, true);
			const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content: file.content,
				expectedRevision: file.expectedRevision, effects });
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
