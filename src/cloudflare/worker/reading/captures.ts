import { readEncryptionState } from '../encryption-state';
import { readingCapturePath } from '@/reading/core/filename';
import { parseReadingNote } from '@/reading/core/notes';
import { portablePathKey } from '@/protocol/portable-path';
import { namespacePredicate } from '../file-namespace';
import { FILE_PATH_MATCH, filePathArgs } from '../file-identity';
import { stageMarkdownFile } from '../markdown-file-staging';
import { commitStagedFile } from '../sync-mutations';
import type { Env } from '../types';
import { policy } from './common';
import { assembleReadingArticle } from '@/reading/core/article';
import type { Publication } from './extraction/jobs';

export interface CapturePublication { captureId: string; generation: string; result: Publication['result']; resolvedUrl?: string }
export interface PendingCapture { id: string; generation: string; url_identity: string; note: string; attempts: number; available_at: number }
export async function capturePath(env: Env, folder: string, title: string, id: string): Promise<string> {
  return readingCapturePath(folder, title, id, async path => {
    const predicate = namespacePredicate(path);
    // Separate branches keep each lookup on the primary key; a top-level OR scans files.
    return Boolean(await env.DB.prepare(`SELECT 1 FROM files WHERE portable_path=? UNION ALL SELECT 1 FROM files WHERE ${predicate.sql} LIMIT 1`)
      .bind(portablePathKey(path), ...predicate.args).first());
  });
}

/** Runs under the coordinator lock. Publication and queue removal share one transaction. */
export async function publishCapture(env: Env, id: string, generation: string, result: Publication['result'], resolvedUrl?: string): Promise<void> {
  if (await readEncryptionState(env.DB)) return ;
  const current = await policy(env.DB);
  if (!current || current.generation !== generation) return;
  const capture = await env.DB.prepare('SELECT * FROM reading_captures WHERE id=? AND generation=?').bind(id, generation).first<PendingCapture>();
  if (!capture) return; // A repeated delivery cannot recreate a deleted note.
  const item = parseReadingNote(capture.note)!;
  // Turning fetching off while a request is in flight still produces a useful bookmark.
  if (!current.enabled) result = null;
  const { content, title } = assembleReadingArticle(capture.note, item, { kind: 'capture', article: result, resolvedUrl });
  const path = await capturePath(env, current.folder_path, title, id);
  const staged = await stageMarkdownFile(env.BUCKET, env.DB, path, content, null);
  const committed = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, previousFile: null,
    effects: files => [env.DB.prepare(`DELETE FROM reading_captures WHERE id=? AND generation=? AND EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key=?)`)
      .bind(id, generation, ...filePathArgs(files[0]!.path), files[0]!.storageKey)] });
  if (!committed.committed) throw new Error('Reading capture publication must retry.');
}

export async function runCapture(env: Env, state: DurableObjectState, enabled: boolean): Promise<void> {
  if (await readEncryptionState(env.DB)) return ;
  const capture = await env.DB.prepare('SELECT * FROM reading_captures WHERE available_at<=? ORDER BY available_at LIMIT 1').bind(Date.now()).first<PendingCapture>();
  if (!capture) return;
  await env.DB.prepare('UPDATE reading_captures SET available_at=?, attempts=attempts+1 WHERE id=?').bind(Date.now() + 60_000, capture.id).run();
  await state.storage.setAlarm(Date.now() + 60_000);
  let result: Publication['result'] = null, resolvedUrl: string | undefined;
  if (enabled) {
    try {
      const { fetchReadingCapture } = await import('./extraction/transport');
      const captureResult = await fetchReadingCapture(parseReadingNote(capture.note)!.source_url, env.READING_FETCH ? request => env.READING_FETCH!.fetch(request) : fetch, env.CRATE_PUBLIC_ORIGIN);
      result = captureResult.article; resolvedUrl = captureResult.url;
    } catch { if (capture.attempts < 2) return; }
  }
  const response = await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')).fetch('https://do/reading-publish', {
    method: 'POST', body: JSON.stringify({ captureId: capture.id, generation: capture.generation, result, resolvedUrl }),
  });
  if (!response.ok) throw new Error('Reading capture publication unavailable');
}
