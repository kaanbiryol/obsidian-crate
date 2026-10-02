import { MAX_ENCRYPTED_REMINDER_REQUEST_BYTES, isReceiptEnvelope } from '../../encryption/receipt-format';
import { FILE_FOLDER_MATCH, fileFolderArgs } from './file-identity';
import { corsHeaders, corsResponse } from './cors';
import { parseJsonObject, sanitizePath, isSha256Hex } from './utils';
import { readEncryptionState, prepareEncryptedFileCommit, EncryptionStateError } from './encryption-state';
import { encryptionScopeForPath, type EncryptionServerState } from '../../encryption/server-state';
import { getStoredFileRow, storedObjectMatchesMetadata } from './sync-storage';
import { stageMarkdownFile } from './markdown-file-staging';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { commitStagedFile } from './sync-mutations';
import { FileVersionConflictError } from './storage';
import { beginReminderOperation, reminderOperationEffects } from './reminders-web/operations';
import { isSyncRevision } from '../../protocol/sync-validation';
import type { Env } from './types';

const MAX_WEB_FILE_BYTES = 4 * 1024 * 1024;
interface EncryptedWebFile { path: string; content: string; expectedHash: string | null; expectedRevision?: string }

function scopedPath(value: unknown, folder: string, state: EncryptionServerState): string | null {
	if (typeof value !== 'string') return null;
	const path = sanitizePath(value);
	const scope = state.scopes.find(scope => scope.folderPath === folder);
	return path && path === value && path.startsWith(`${folder}/`) && path.toLowerCase().endsWith('.md')
		&& scope && encryptionScopeForPath(state, path).id === scope.id ? path : null;
}

export async function handleEncryptedReminders(request: Request, env: Env, path: string, prefix = '/reminders', expectedFolder?: string): Promise<Response | null> {
	if (![`${prefix}/encrypted-files`, `${prefix}/encrypted-file`, `${prefix}/encrypted-commit`].includes(path)) return null;
	const state = await readEncryptionState(env.DB);
	if (!state || state.mode !== 'active') throw new EncryptionStateError('Finish setting up encryption before using encrypted reminders');
	if (path === `${prefix}/encrypted-commit` && request.method === 'POST') return commitReminderFiles(request, env, state, expectedFolder);
	if (request.method !== 'GET') return null;
	const params = new URL(request.url).searchParams;
	const folder = params.get('folderPath');
	if (!folder || (expectedFolder && folder !== expectedFolder) || !state.scopes.some(scope => scope.folderPath === folder)) return corsResponse({ error: 'Unknown encrypted reminders folder' }, 403);
	if (path === `${prefix}/encrypted-files`) {
		const after = params.get('after') ?? '';
		if (after.length > 1024) return corsResponse({ error: 'Invalid file cursor' }, 400);
		const sequence = await env.DB.prepare("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'changelog'), 0), COALESCE((SELECT snapshot_seq FROM initial_import), 0)) AS seq").first<{ seq: number }>();
		const rows = await env.DB.prepare(`SELECT path, hash, size, storage_key AS revision FROM files
			WHERE ${FILE_FOLDER_MATCH} AND lower(path) LIKE '%.md' AND path > ? ORDER BY path LIMIT 100`)
			.bind(...fileFolderArgs(folder), after).all<{ path: string; hash: string; size: number; revision: string }>();
		const files = rows.results.filter(file => scopedPath(file.path, folder, state));
		return corsResponse({ files, sequence: sequence?.seq ?? 0, generation: state.generation,
			nextCursor: rows.results.length === 100 ? rows.results.at(-1)!.path : null });
	}
	const filePath = scopedPath(params.get('path'), folder, state);
	if (!filePath) return corsResponse({ error: 'File is outside this enrollment' }, 403);
	const file = await getStoredFileRow(env.DB, filePath);
	if (!file) return corsResponse({ error: 'Reminder file not found' }, 404);
	if (params.get('revision') && params.get('revision') !== file.storageKey) return corsResponse({ error: 'Reminder file changed', code: 'version_conflict' }, 409);
	if (file.size > MAX_WEB_FILE_BYTES) return corsResponse({ error: 'This note is too large for the reminders app' }, 413);
	const object = await env.BUCKET.get(file.storageKey);
	if (!object || !storedObjectMatchesMetadata(object, file)) return corsResponse({ error: 'Reminder file is unavailable' }, 503);
	return new Response(object.body, { headers: { ...corsHeaders(), 'Content-Type': 'application/vnd.crate.encrypted-file',
		'Content-Length': String(file.size), 'Cache-Control': 'private, no-store', 'X-File-Hash': file.hash, 'X-Crate-Revision': file.storageKey } });
}

async function commitReminderFiles(request: Request, env: Env, state: EncryptionServerState, expectedFolder?: string): Promise<Response> {
	const parsed = await parseJsonObject(request, MAX_ENCRYPTED_REMINDER_REQUEST_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.value;
	if (Object.keys(body).some(key => !['folderPath', 'operationId', 'files', 'acknowledgment', 'createdId'].includes(key))) return corsResponse({ error: 'Unexpected encrypted mutation field' }, 400);
	if ((expectedFolder && body.folderPath !== expectedFolder) || typeof body.folderPath !== 'string' || !state.scopes.some(scope => scope.folderPath === body.folderPath)
		|| !Array.isArray(body.files) || body.files.length < 1 || body.files.length > 2
		|| !isReceiptEnvelope(body.acknowledgment)) return corsResponse({ error: 'Invalid encrypted mutation' }, 400);
	const operation = await beginReminderOperation(env.DB, body, 'encrypted-files');
	if (operation instanceof Response) return operation;
	if (body.createdId !== undefined && body.createdId !== operation.id) return corsResponse({ error: 'Invalid created reminder identity' }, 400);
	const files: EncryptedWebFile[] = [];
	for (const raw of body.files as unknown[]) {
		if (!raw || typeof raw !== 'object') return corsResponse({ error: 'Invalid encrypted file' }, 400);
		const file = raw as Partial<EncryptedWebFile>;
		const filePath = scopedPath(file.path, body.folderPath, state);
		if (Object.keys(file).some(key => !['path', 'content', 'expectedHash', 'expectedRevision'].includes(key)) || !filePath
			|| typeof file.content !== 'string' || new TextEncoder().encode(file.content).byteLength > MAX_WEB_FILE_BYTES
			|| (file.expectedHash !== null && (typeof file.expectedHash !== 'string' || !isSha256Hex(file.expectedHash)))
			|| (file.expectedHash !== null && !isSyncRevision(file.expectedRevision))) return corsResponse({ error: 'Invalid encrypted file precondition' }, 400);
		await prepareEncryptedFileCommit(env.DB, filePath, file.content);
		files.push({ path: filePath, content: file.content, expectedHash: file.expectedHash!, expectedRevision: file.expectedRevision });
	}
	if (new Set(files.map(file => file.path)).size !== files.length) return corsResponse({ error: 'Duplicate file path' }, 400);
	const response = { encrypted: body.acknowledgment };
	const effects = reminderOperationEffects(env.DB, operation, response, typeof body.createdId === 'string' ? body.createdId : undefined);
	try {
		if (files.length === 2) {
			const [source, destination] = files;
			if (!source?.expectedHash) return corsResponse({ error: 'A move requires an existing source note' }, 400);
			await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, { source: { ...source, expectedHash: source.expectedHash }, destination: destination!, effects });
		} else {
			const file = files[0]!;
			const previous = await getStoredFileRow(env.DB, file.path);
			const staged = await stageMarkdownFile(env.BUCKET, env.DB, file.path, file.content, file.expectedHash, true);
			const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content: file.content,
				expectedRevision: file.expectedRevision, previousFile: previous, effects });
			if (!result.committed) throw new FileVersionConflictError(file.path, result.currentHash);
		}
		return corsResponse(response);
	} catch (error) {
		// A concurrent copy may have committed the same immutable attempt.
		const replay = await beginReminderOperation(env.DB, body, 'encrypted-files');
		if (replay instanceof Response) return replay;
		if (error instanceof FileVersionConflictError) return corsResponse({ error: 'A reminder note changed. Refresh before retrying.', code: 'version_conflict' }, 409);
		throw error;
	}
}
