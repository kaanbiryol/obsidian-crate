import type { Env } from '../../types';
import { policy, readSource } from '../common';
import { parseReadingNote } from '@/reading/core/notes';
import { patchReadingFrontmatter } from '@/reading/core/frontmatter';
import { managedArticle, projectReading } from '../projection';
import { sha256Hex } from '../../auth';
import { commitStagedFile } from '../../sync-mutations';
import { stageMarkdownFile } from '../../markdown-file-staging';
import type { extractDocument } from './document';

interface Job { path: string; item_id: string; generation: string; source_revision: string; block_hash: string; url: string; attempts: number }
export interface Publication { job: Job; result: ReturnType<typeof extractDocument> | null; resolvedUrl?: string }

/** Called under the file coordinator's lock. Never recreate a missing or changed source. */
export async function publishExtraction(env: Env, publication: Publication): Promise<void> {
  const { job, result } = publication;
  const current = await policy(env.DB);
  if (!current?.enabled || current.generation !== job.generation) return;
  const stored = await env.DB.prepare('SELECT source_revision FROM reading_jobs WHERE path=?').bind(job.path).first<{ source_revision: string }>();
  if (stored?.source_revision !== job.source_revision) return;
  try {
    const source = await readSource(env, job.path), item = parseReadingNote(source.content), block = managedArticle(source.content);
    if (source.file.storageKey !== job.source_revision || item?.crate_reading_id !== job.item_id || item.capture_method !== 'url'
      || item.extraction_status !== 'pending' || item.source_url !== job.url || !block || await sha256Hex(block.text) !== job.block_hash) return;
    let content = source.content;
    if (result) content = `${content.slice(0, block.start)}\n\n${result.markdown}\n\n${content.slice(block.end)}`;
    content = patchReadingFrontmatter(content, { extraction_status: result ? 'ready' : 'unavailable',
      ...(result?.title && item.title === new URL(item.source_url).hostname ? { title: result.title } : {}),
      ...(result?.author && !item.author ? { author: result.author } : {}),
      ...(result?.faviconUrl && !item.favicon_url ? { favicon_url: result.faviconUrl } : {}),
      ...(result && publication.resolvedUrl ? { resolved_url: publication.resolvedUrl } : {}) });
    const staged = await stageMarkdownFile(env.BUCKET, env.DB, job.path, content, source.file.hash);
    await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, previousFile: source.file, expectedRevision: source.file.storageKey });
  } finally {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reading_jobs WHERE path=? AND source_revision=?').bind(job.path, job.source_revision),
      env.DB.prepare('DELETE FROM reading_sources WHERE path=?').bind(job.path),
    ]);
  }
}

export async function runReadingExtraction(state: DurableObjectState, env: Env): Promise<void> {
  // A persisted maintenance fence stops new network work during backup/upgrade.
  if (await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key='crate_deployment_fence'").first()) { await state.storage.setAlarm(Date.now() + 60_000); return; }
  const current = await policy(env.DB);
  if (!current?.enabled) return;
  await env.DB.prepare('DELETE FROM reading_jobs WHERE generation != ? OR NOT EXISTS (SELECT 1 FROM files WHERE files.path=reading_jobs.path)')
    .bind(current.generation).run();
  const job = await env.DB.prepare('SELECT * FROM reading_jobs WHERE available_at<=? ORDER BY available_at LIMIT 1').bind(Date.now()).first<Job>();
  if (job) {
    // Lease before network access: a crash or restart repeats safely after one minute.
    await env.DB.prepare('UPDATE reading_jobs SET available_at=?, attempts=attempts+1 WHERE path=?').bind(Date.now() + 60_000, job.path).run();
    await state.storage.setAlarm(Date.now() + 60_000);
    let result: ReturnType<typeof extractDocument> | null = null, resolvedUrl: string | undefined;
    try {
      const source = await readSource(env, job.path);
      if (source.file.storageKey !== job.source_revision) {
        await env.DB.batch([env.DB.prepare('DELETE FROM reading_jobs WHERE path=? AND source_revision=?').bind(job.path, job.source_revision),
          env.DB.prepare('DELETE FROM reading_sources WHERE path=?').bind(job.path)]);
      } else {
        try { const [{ fetchArticle }, { extractDocument }] = await Promise.all([import('./transport'), import('./document')]); const article = await fetchArticle(job.url, env.READING_FETCH ? request => env.READING_FETCH!.fetch(request) : fetch, env.CRATE_PUBLIC_ORIGIN); result = extractDocument(article.html, article.url); resolvedUrl = article.url; }
        catch { if (job.attempts < 2) return; }
        const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
        const response = await stub.fetch('https://do/reading-publish', { method: 'POST', body: JSON.stringify({ job, result, resolvedUrl }) });
        if (!response.ok) throw new Error('Reading publication unavailable');
      }
    } catch { /* Keep the bounded lease and exact source for recovery. No article or URL logging. */ }
  }
  // Wake the serialized projector after a stale source or publication; no future browser visit is required.
  const wake = await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')).fetch('https://do/project', { method: 'POST' });
  if (!wake.ok) throw new Error('Reading projection wake failed');
  const next = await env.DB.prepare('SELECT MIN(available_at) AS at FROM reading_jobs').first<{ at: number | null }>();
  if (next?.at != null) await state.storage.setAlarm(Math.max(Date.now() + 1000, next.at));
}

export async function scheduleReading(env: Env): Promise<boolean> {
  const current = await policy(env.DB);
  if (!current?.enabled) return false;
  const complete = await projectReading(env, current);
  if (await env.DB.prepare('SELECT 1 FROM reading_jobs LIMIT 1').first()) {
    const response = await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/reading')).fetch('https://do/reading-wake', { method: 'POST' });
    if (!response.ok) throw new Error('Could not schedule Reading');
  }
  return !complete;
}
