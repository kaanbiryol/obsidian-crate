import { readEncryptionState } from '../../encryption/state';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../../sync/file-identity';
import { publishCapture, runCapture, type CapturePublication } from '../captures';
import { featureEnabled } from '../../feature-policy';
import type { FeaturePolicy } from '../../../../protocol/feature-policy';
import type { EncryptionServerState } from '../../../../encryption/server-state';
import type { Env } from '../../types';
import { policy, readSource } from '../common';
import { parseReadingNote } from '@/reading/core/notes';
import { assembleReadingArticle, managedArticle } from '@/reading/core/article';
import { invalidateReadingProjection, projectReading } from '../projection';
import { commitStagedFile } from '../../sync/mutations';
import { stageMarkdownFile } from '../../sync/markdown-file-staging';
import type { extractDocument } from '@/reading/extraction/document';
import { publishReading, wakeProjection, wakeReading } from '@/cloudflare/worker/coordinator/coordinator';
import { sha256Hex } from '@/platform/sha256';
import { DEPLOYMENT_FENCE_KEY } from '@/protocol/deployment-fence';

interface Job { path: string; item_id: string; generation: string; source_revision: string; block_hash: string; url: string; attempts: number }
export interface Publication { job: Job; result: Awaited<ReturnType<typeof extractDocument>> | null; resolvedUrl?: string }

/** Called under the file coordinator's lock. Never recreate a missing or changed source. */
export async function publishExtraction(env: Env, publication: Publication | CapturePublication): Promise<void> {
  if (await readEncryptionState(env.DB)) return ;
  if ('captureId' in publication) {
    if (await featureEnabled(env.DB, 'reading')) await publishCapture(env, publication.captureId, publication.generation, publication.result, publication.resolvedUrl);
    return;
  }
  const { job, result } = publication;
  if (!await featureEnabled(env.DB, 'reading')) return;
  const current = await policy(env.DB);
  if (!current?.enabled || current.generation !== job.generation) return;
  const stored = await env.DB.prepare('SELECT source_revision FROM reading_jobs WHERE path=?').bind(job.path).first<{ source_revision: string }>();
  if (stored?.source_revision !== job.source_revision) return;
  try {
    const source = await readSource(env, job.path), item = parseReadingNote(source.content), block = managedArticle(source.content);
    if (source.file.storageKey !== job.source_revision || item?.crate_reading_id !== job.item_id || item.capture_method !== 'url'
      || item.extraction_status !== 'pending' || item.source_url !== job.url || !block || await sha256Hex(block.text) !== job.block_hash) return;
    const { content } = assembleReadingArticle(source.content, item, { kind: 'extraction', article: result, block, resolvedUrl: publication.resolvedUrl });
    const staged = await stageMarkdownFile(env.BUCKET, env.DB, job.path, content, source.file.hash);
    await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, previousFile: source.file, expectedRevision: source.file.storageKey });
  } finally {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reading_jobs WHERE path=? AND source_revision=?').bind(job.path, job.source_revision),
      env.DB.prepare('DELETE FROM reading_sources WHERE path=?').bind(job.path),
      invalidateReadingProjection(env.DB),
    ]);
  }
}

export async function runReadingExtraction(state: DurableObjectState, env: Env): Promise<void> {
  if (await readEncryptionState(env.DB)) return ;
  // A persisted maintenance fence stops new network work during backup/upgrade.
  if (await env.DB.prepare(`SELECT 1 FROM maintenance_state WHERE key='${DEPLOYMENT_FENCE_KEY}'`).first()) { await state.storage.setAlarm(Date.now() + 60_000); return; }
  if (!await featureEnabled(env.DB, 'reading')) return;
  const current = await policy(env.DB);
  if (!current) return;
  try { await runCapture(env, state, Boolean(current.enabled)); } catch { /* The durable lease retries an uncertain publication. */ }
  await env.DB.prepare(`DELETE FROM reading_jobs WHERE generation != ? OR path NOT IN (SELECT path FROM files WHERE ${FILE_FOLDER_MATCH})`)
    .bind(current.generation, ...fileFolderArgs(current.folder_path)).run();
  const job = await env.DB.prepare('SELECT * FROM reading_jobs WHERE available_at<=? ORDER BY available_at LIMIT 1').bind(Date.now()).first<Job>();
  if (job && current.enabled) {
    // Lease before network access: a crash or restart repeats safely after one minute.
    await env.DB.prepare('UPDATE reading_jobs SET available_at=?, attempts=attempts+1 WHERE path=?').bind(Date.now() + 60_000, job.path).run();
    await state.storage.setAlarm(Date.now() + 60_000);
    let result: Awaited<ReturnType<typeof extractDocument>> | null = null, resolvedUrl: string | undefined;
    try {
      const source = await readSource(env, job.path);
      if (source.file.storageKey !== job.source_revision) {
        await env.DB.batch([env.DB.prepare('DELETE FROM reading_jobs WHERE path=? AND source_revision=?').bind(job.path, job.source_revision),
          env.DB.prepare('DELETE FROM reading_sources WHERE path=?').bind(job.path), invalidateReadingProjection(env.DB)]);
      } else {
        try { const { fetchReadingCapture } = await import('./transport'); const capture = await fetchReadingCapture(job.url, env.READING_FETCH ? request => env.READING_FETCH!.fetch(request) : fetch, env.CRATE_PUBLIC_ORIGIN); result = capture.article; resolvedUrl = capture.url; }
        catch { if (job.attempts < 2) return; }
        if (!await publishReading(env, { job, result, resolvedUrl } satisfies Publication)) throw new Error('Reading publication unavailable');
      }
    } catch { /* Keep the bounded lease and exact source for recovery. No article or URL logging. */ }
  }
  // Wake the serialized projector after a stale source or publication; no future browser visit is required.
  if (!await wakeProjection(env)) throw new Error('Reading projection wake failed');
  const next = await env.DB.prepare('SELECT MIN(available_at) AS at FROM (SELECT available_at FROM reading_captures UNION ALL SELECT available_at FROM reading_jobs WHERE ?=1)').bind(current.enabled).first<{ at: number | null }>();
  if (next?.at != null) await state.storage.setAlarm(Math.max(Date.now() + 1000, next.at));
}

/** Return the next projection deadline, distinguishing a backlog from an outage. */
export async function scheduleReading(env: Env, loaded?: { encryption: EncryptionServerState | null; features: FeaturePolicy }): Promise<number | null> {
  if (loaded ? loaded.encryption : await readEncryptionState(env.DB)) return null;
  if (!(loaded ? loaded.features.reading : await featureEnabled(env.DB, 'reading'))) return null;
  const current = await policy(env.DB);
  if (!current) return null;
  const projection = await projectReading(env, current);
  if (await env.DB.prepare('SELECT 1 FROM reading_captures UNION ALL SELECT 1 FROM reading_jobs WHERE ?=1 LIMIT 1').bind(current.enabled).first()) {
    if (!await wakeReading(env)) throw new Error('Could not schedule Reading');
  }
  return projection === 'complete' ? null : Date.now() + (projection === 'unavailable' ? 30_000 : 1);
}
