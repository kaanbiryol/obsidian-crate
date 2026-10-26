import { capturePath } from './captures';
import { updatePolicy } from './access';
import { createReadingNote, parseReadingNote, updateReadingNote } from '@/reading/core/notes';
import { readingUrl, readingUrlIdentity } from '@/reading/core/model';
import { isEmptyReadingCapture, readingUpdateIssue } from '@/reading/core/mutation-policy';
import { patchReadingFrontmatter } from '@/reading/core/frontmatter';
import { stageMarkdownFile } from '../sync/markdown-file-staging';
import { commitStagedFile } from '../sync/mutations';
import type { Env } from '../types';
import type { AuthPrincipal } from '../auth/authenticate';
import { beginOperation, operationEffects, operationStatement } from './operations';
import { ReadingError, readingResponse, readStoredNote, sourceById } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { bumpReadingRevision, ensureReadingIndex } from './library-index';
import { readingListEtag } from './queries';

export async function mutateReading(env: Env, principal: AuthPrincipal, current: ReadingPolicy, body: Record<string, unknown>, action: string): Promise<Response> {
  const op = await beginOperation(env.DB, principal, current, body, action);
  if (op instanceof Response) return op;
  const index = await ensureReadingIndex(env, current, file => readStoredNote(env, file));
  if (index.state !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Retry this saved change shortly.', 503);
  if (action === 'capture') {
    if (body.destinationFolder !== undefined && body.destinationFolder !== current.folder_path) throw new ReadingError('The Reading folder changed. Restore the original destination to finish this save.', 409);
    let url: string; try { url = readingUrl(body.url); } catch { throw new ReadingError('Enter a complete HTTP or HTTPS link without credentials.'); }
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 1000)) throw new ReadingError('Use a title shorter than 1,000 characters.');
    // Saving a full article is the library user's explicit request to download its text.
    if (!current.enabled && body.fetchArticle === true && principal.scope !== 'reading_capture') {
      await updatePolicy(env.DB, { enabled: true, folderPath: current.folder_path, revision: current.revision });
      current = { ...current, enabled: 1 };
    }

    const { results } = await env.DB.prepare('SELECT item_id FROM reading_items WHERE url_identity=? LIMIT 2')
      .bind(readingUrlIdentity(url)).all<{ item_id: string }>();
    if (results.length > 1) throw new ReadingError('Several notes use this link. Review them in Obsidian before saving again.', 409);
    if (results[0]) {
      await sourceById(env, results[0].item_id);
      const response = { saved: true, alreadySaved: true, id: results[0].item_id };
      await env.DB.batch([operationStatement(env.DB, op, response)]);
      return readingResponse(response);
    }
    const identity = readingUrlIdentity(url);
    const queued = await env.DB.prepare('SELECT id FROM reading_captures WHERE generation=? AND url_identity=?')
      .bind(current.generation, identity).first<{ id: string }>();
    if (queued) {
      const response = { saved: true, alreadySaved: true, id: queued.id };
      await env.DB.batch([operationStatement(env.DB, op, response)]);
      return readingResponse(response);
    }
    if (await env.DB.prepare('SELECT 1 WHERE (SELECT count(*) FROM reading_jobs)+(SELECT count(*) FROM reading_captures)>=1000').first()) throw new ReadingError('Reading has many articles waiting. Retry after some finish.', 429);
    const id = typeof body.captureId === 'string' ? body.captureId : crypto.randomUUID();
    let note: string;
    try { note = createReadingNote({ id, url, title: body.title, savedAt: new Date().toISOString() }); }
    catch { throw new ReadingError('Invalid Reading capture.'); }
    if (parseReadingNote(note)!.crate_reading_id !== id) throw new ReadingError('Use a lowercase Reading ID.');
    if (await env.DB.prepare('SELECT 1 FROM reading_captures WHERE id=? UNION ALL SELECT 1 FROM reading_items WHERE item_id=? LIMIT 1').bind(id, id).first()) throw new ReadingError('This Reading ID already exists.', 409);
    const response = { saved: true, alreadySaved: false, id };
    if (current.enabled && body.fetchArticle !== false) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO reading_captures(id,generation,url_identity,note,available_at) VALUES (?,?,?,?,?)')
          .bind(id, current.generation, readingUrlIdentity(url), note, Date.now()),
        operationStatement(env.DB, op, response),
        bumpReadingRevision(env.DB),
      ]);
      return readingResponse(response);
    }
    const content = patchReadingFrontmatter(note, { extraction_status: 'unavailable' });
    const item = parseReadingNote(content)!;
    const path = await capturePath(env, current.folder_path, { title: item.title, url: item.source_url }, id);
    const staged = await stageMarkdownFile(env.BUCKET, env.DB, path, content, null);
    const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, readingPolicy: current, encryptionState: null, effects: operationEffects(env.DB, op, response) });
    if (!result.committed) throw new ReadingError('This note changed. Retry the same save.', 409);
    return readingResponse(response);
  }
  const source = await sourceById(env, body.id);
  let content: string;
  if (action === 'retry') {
    if (!current.enabled) throw new ReadingError('Allow article fetching in Reading settings before retrying.', 403);
    if (!isEmptyReadingCapture(source.content, source.item)) throw new ReadingError('Only URL captures with an unchanged article section can be extracted.');
    content = patchReadingFrontmatter(source.content, { extraction_status: 'pending' });
  } else {
    const changes = body.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !body.before || typeof body.before !== 'object') throw new ReadingError('Choose a Reading change.');
    const issue = readingUpdateIssue(source.item, body.before, changes);
    if (issue === 'unsupported') throw new ReadingError('Unsupported Reading change.');
    if (issue === 'conflict') throw new ReadingError('This item changed on another device. Refresh before editing it.', 409, 'reading_conflict');
    try { content = updateReadingNote(source.content, source.item.crate_reading_id, changes); }
    catch (error) { throw new ReadingError(error instanceof Error ? error.message : 'Invalid Reading change.'); }
  }
  const response = { saved: true, id: source.item.crate_reading_id };
  // Reading writes run under the coordinator lock, so the library revision cannot move
  // between the index check above and this commit. A client whose cached library has the
  // `before` revision then needs only this item again, not the whole library.
  const revision = crypto.randomUUID().replaceAll('-', '');
  const staged = await stageMarkdownFile(env.BUCKET, env.DB, source.path, content, source.file.hash);
  const result = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, expectedRevision: source.file.storageKey, readingPolicy: current, readingRevision: revision, encryptionState: null, effects: operationEffects(env.DB, op, response) });
  if (!result.committed) throw new ReadingError('This note changed. Refresh before editing it.', 409);
  return readingResponse({ ...response, library: { before: await readingListEtag(current, index.revision), after: await readingListEtag(current, revision) } });
}
