import { capturePath } from './captures';
import { updatePolicy } from './access';
import { createReadingNote, parseReadingNote } from '@/reading/core/notes';
import { MAX_READING_TITLE_LENGTH, readingUrl, readingUrlIdentity } from '@/reading/core/model';
import { planReadingFileCommand, readingFileCommandRefusal } from '@/reading/core/reading-file-command';
import { patchReadingFrontmatter, readReadingFrontmatter } from '@/reading/core/frontmatter';
import { sha256Hex } from '@/platform/sha256';
import { stageMarkdownFile } from '../sync/markdown-file-staging';
import { commitFileDelete, commitStagedFile } from '../sync/mutations';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import { beginOperation, operationEffects, operationReceiptStatement, operationStatement, type ReadingReceiptRow } from './operations';
import { ReadingError, readingResponse, readSourceRow, readStoredNote, readingItemId, sourceById, sourceRowsStatement, uniqueSourceRow, type ReadingSourceRow } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { ensureReadingIndex, readingIndexStatement, type ReadingIndexRow } from './library-index';
import { readingItemEtag } from './queries';

/** What a mutation reads before it changes anything, read in one round trip by `loadReadingMutation`. */
export interface LoadedReadingMutation { index: ReadingIndexRow | null; receipt: ReadingReceiptRow | null; source?: ReadingSourceRow[] }

/** Reads the policy row with `policyRow` and, for a mutation's request body, its index row,
 * receipt and the rows of the note it names. */
export async function loadReadingMutation(db: D1Database, policyRow: D1PreparedStatement, body: Record<string, unknown>, action: string) {
	const receipt = operationReceiptStatement(db, body);
	let id: string | undefined;
	try { if (action !== 'capture') id = readingItemId(body.id); } catch { /* Reported where the note is read. */ }
	const [policy, index, saved, source] = await db.batch<{ results: unknown[] }>([policyRow, readingIndexStatement(db),
		receipt ?? db.prepare('SELECT NULL'), ...id !== undefined ? [sourceRowsStatement(db, id)] : []]);
	return { policy: (policy!.results[0] ?? null) as ReadingPolicy | null, mutation: { index: (index!.results[0] ?? null) as ReadingIndexRow | null,
		receipt: receipt ? (saved!.results[0] ?? null) as ReadingReceiptRow | null : null,
		...source ? { source: source.results as ReadingSourceRow[] } : {} } satisfies LoadedReadingMutation };
}

export async function mutateReading(env: Env, principal: AuthPrincipal, current: ReadingPolicy, body: Record<string, unknown>, action: string, loaded?: LoadedReadingMutation): Promise<Response> {
	const op = await beginOperation(env.DB, principal, current, body, action, loaded ? loaded.receipt : undefined);
	if (op instanceof Response) return op;
	const index = await ensureReadingIndex(env, current, file => readStoredNote(env, file), loaded?.index);
	if (index.state !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Retry this saved change shortly.', 503);
	if (action === 'capture') {
		if (body.destinationFolder !== undefined && body.destinationFolder !== current.folder_path) throw new ReadingError('The Reading folder changed. Restore the original destination to finish this save.', 409);
		let url: string; try { url = readingUrl(body.url); } catch { throw new ReadingError('Enter a complete HTTP or HTTPS link without credentials.'); }
		if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > MAX_READING_TITLE_LENGTH)) throw new ReadingError('Use a title shorter than 1,000 characters.');
		// Saving a full article is the library user's explicit request to download its text.
		if (!current.enabled && body.fetchArticle === true && principal.scope !== 'reading_capture') {
			await updatePolicy(env.DB, { enabled: true, folderPath: current.folder_path, revision: current.revision });
			current = { ...current, enabled: 1 };
		}

		const identity = readingUrlIdentity(url);
		const id = typeof body.captureId === 'string' ? body.captureId : crypto.randomUUID();
		// One round trip answers every check below. A note's link is its `u:` term.
		const [saved, waiting, full, taken] = await env.DB.batch<{ results: Array<{ item_id?: string; id?: string }> }>([
			env.DB.prepare(`SELECT item_id FROM reading_items WHERE portable_path IN (
        SELECT portable_path FROM note_terms WHERE term = ? LIMIT 2)`).bind(`u:${identity}`),
			env.DB.prepare('SELECT id FROM reading_captures WHERE generation=? AND url_identity=?').bind(current.generation, identity),
			env.DB.prepare('SELECT 1 WHERE (SELECT count(*) FROM reading_jobs)+(SELECT count(*) FROM reading_captures)>=1000'),
			env.DB.prepare('SELECT 1 FROM reading_captures WHERE id=? UNION ALL SELECT 1 FROM reading_items WHERE item_id=? LIMIT 1').bind(id, id),
		]);
		const results = saved!.results as Array<{ item_id: string }>;
		if (results.length > 1) throw new ReadingError('Several notes use this link. Review them in Obsidian before saving again.', 409);
		if (results[0]) {
			await sourceById(env, results[0].item_id);
			const response = { saved: true, alreadySaved: true, id: results[0].item_id };
			await env.DB.batch([operationStatement(env.DB, op, response)]);
			return readingResponse(response);
		}
		const queued = waiting!.results[0] as { id: string } | undefined;
		if (queued) {
			const response = { saved: true, alreadySaved: true, id: queued.id };
			await env.DB.batch([operationStatement(env.DB, op, response)]);
			return readingResponse(response);
		}
		if (full!.results.length) throw new ReadingError('Reading has many articles waiting. Retry after some finish.', 429);
		let note: string;
		try { note = createReadingNote({ id, url, title: body.title, savedAt: new Date().toISOString() }); }
		catch { throw new ReadingError('Invalid Reading capture.'); }
		if (parseReadingNote(note)!.crate_reading_id !== id) throw new ReadingError('Use a lowercase Reading ID.');
		if (taken!.results.length) throw new ReadingError('This Reading ID already exists.', 409);
		const response = { saved: true, alreadySaved: false, id };
		if (current.enabled && body.fetchArticle !== false) {
			await env.DB.batch([
				env.DB.prepare('INSERT INTO reading_captures(id,generation,url_identity,note,available_at) VALUES (?,?,?,?,?)')
					.bind(id, current.generation, identity, note, Date.now()),
				operationStatement(env.DB, op, response),
			]);
			return readingResponse(response);
		}
		const content = patchReadingFrontmatter(note, { extraction_status: 'unavailable' });
		const item = parseReadingNote(content)!;
		const path = await capturePath(env, current.folder_path, { title: item.title, url: item.source_url }, id);
		const staged = await stageMarkdownFile(env.BUCKET, env.DB, path, content, null);
		const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, readingPolicy: current, reminderFolder: op.reminderFolder, encryptionState: null, effects: operationEffects(env.DB, op, response) });
		if (!result.committed) throw new ReadingError('This note changed. Retry the same save.', 409);
		return readingResponse(response);
	}
	// A rebuild step can change the rows read before it.
	const source = loaded?.source && !index.rebuilt
		? await readSourceRow(env, readingItemId(body.id), uniqueSourceRow(loaded.source)) : await sourceById(env, body.id);
	if (action === 'retry' && !current.enabled) throw new ReadingError('Allow article fetching in Reading settings before retrying.', 403);
	const command = action === 'delete' || action === 'retry' ? action : 'update';
	const plan = await planReadingFileCommand(source.item, source.content, { action: command, before: body.before, changes: body.changes, markdownHash: body.markdownHash });
	if (plan.kind === 'issue') {
		const refusal = readingFileCommandRefusal(plan, command);
		throw new ReadingError(refusal.message, refusal.status, refusal.code);
	}
	if (plan.kind === 'remove') {
		const response = { deleted: true, id: source.item.crate_reading_id };
		const result = await commitFileDelete(env.DB, { path: source.path, expectedHash: source.file.hash, expectedRevision: source.file.storageKey, previousFile: source.file,
			readingPolicy: current, effects: operationEffects(env.DB, op, response) });
		if (!result.committed) throw new ReadingError('This note changed. Refresh before deleting it.', 409);
		return readingResponse(response);
	}
	const content = plan.content;
	const response = { saved: true, id: source.item.crate_reading_id };
	const staged = await stageMarkdownFile(env.BUCKET, env.DB, source.path, content, source.file.hash);
	const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, expectedRevision: source.file.storageKey, readingPolicy: current, reminderFolder: op.reminderFolder, encryptionState: null, effects: operationEffects(env.DB, op, response) });
	if (!result.committed) throw new ReadingError('This note changed. Refresh before editing it.', 409);
	// The note as committed, so the client needs no `GET /reading/item`: `etag` is that item's
	// ETag and `markdownHash` its body's SHA-256, which tells whether a saved body still matches.
	const saved = parseReadingNote(content)!;
	const article = { item: { ...saved, path: source.path }, etag: await readingItemEtag(current, saved.crate_reading_id, { path: source.path, storage_key: staged.objectKey, hash: staged.hash }),
		markdownHash: await sha256Hex(readReadingFrontmatter(content)?.body ?? '') };
	return readingResponse({ ...response, article });
}
