import { readEncryptionState } from '../../encryption/state';
import { capturePath, MAX_FETCH_ATTEMPTS, publishCapture, runCapture, type CapturePublication } from '../captures';
import { featureEnabled } from '../../feature-policy';
import type { FeaturePolicy } from '../../../../protocol/feature-policy';
import type { EncryptionServerState } from '../../../../encryption/server-state';
import type { Env } from '../../types';
import { policy, readSource, readStoredNote } from '../common';
import { parseReadingNote } from '@/reading/core/notes';
import { assembleReadingArticle, managedArticle } from '@/reading/core/article';
import { ensureReadingIndex, queueReadingArticles, readingIndexScope } from '../library-index';
import { commitStagedFile } from '../../sync/mutations';
import { stageMarkdownFile } from '../../sync/markdown-file-staging';
import { writeCommittedMarkdownMove } from '../../sync/atomic-markdown-move';
import { isGeneratedCapturePath } from '@/reading/core/filename';
import type { extractDocument } from '@/reading/extraction/document';
import { publishReading, wakeReading } from '@/cloudflare/worker/coordinator/coordinator';
import { sha256Hex } from '@/platform/sha256';
import { DEPLOYMENT_FENCE_KEY } from '@/protocol/deployment-fence';

/** Fetch and publication attempts per article job, like the other durable queues. */
export const MAX_JOB_ATTEMPTS = 8;
/** After its attempts, a job retries hourly as a bookmark only until it publishes. */
const EXHAUSTED_JOB_RETRY_MS = 60 * 60_000;

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
	let failed = false;
	try {
		const source = await readSource(env, job.path), item = parseReadingNote(source.content), block = managedArticle(source.content);
		if (source.file.storageKey !== job.source_revision || item?.crate_reading_id !== job.item_id || item.capture_method !== 'url'
			|| item.extraction_status !== 'pending' || item.source_url !== job.url || !block || await sha256Hex(block.text) !== job.block_hash) return;
		const { content, title } = assembleReadingArticle(source.content, item, { kind: 'extraction', article: result, block, resolvedUrl: publication.resolvedUrl });
		// A note still named after its link takes the extracted title; a user rename is kept.
		if (title !== item.title && isGeneratedCapturePath(job.path, current.folder_path, { title: item.title, url: item.source_url }, item.crate_reading_id)) {
			const path = await capturePath(env, current.folder_path, { title, url: item.source_url }, item.crate_reading_id);
			await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: { path: job.path, expectedHash: source.file.hash, expectedRevision: source.file.storageKey }, destination: { path, content } });
			return;
		}
		const staged = await stageMarkdownFile(env.BUCKET, env.DB, job.path, content, source.file.hash);
		await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, expectedRevision: source.file.storageKey, readingPolicy: current, encryptionState: null });
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		// A capture that is still pending at its current revision is queued again by queueReadingArticles.
		// A failed publication keeps its leased row instead, so that queue cannot restart its attempts.
		if (!failed) await env.DB.prepare('DELETE FROM reading_jobs WHERE path=? AND source_revision=?').bind(job.path, job.source_revision).run();
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
	// File removals delete their jobs in the commit batch; only another generation's remain.
	await env.DB.prepare('DELETE FROM reading_jobs WHERE generation != ?').bind(current.generation).run();
	const job = await env.DB.prepare('SELECT * FROM reading_jobs WHERE available_at<=? ORDER BY available_at LIMIT 1').bind(Date.now()).first<Job>();
	if (job && current.enabled) {
		// Lease before network access: a crash or restart repeats safely after one minute.
		// Exhausted jobs keep their row, so the article queue cannot restart their fetches,
		// and retry hourly so an outage cannot leave the note pending; a new source revision resets it.
		await env.DB.prepare(`UPDATE reading_jobs SET available_at=CASE WHEN attempts+1>=${MAX_JOB_ATTEMPTS} THEN ? ELSE ? END, attempts=attempts+1 WHERE path=?`)
			.bind(Date.now() + EXHAUSTED_JOB_RETRY_MS, Date.now() + 60_000, job.path).run();
		await state.storage.setAlarm(Date.now() + 60_000);
		let result: Awaited<ReturnType<typeof extractDocument>> | null = null, resolvedUrl: string | undefined;
		try {
			const source = await readSource(env, job.path);
			if (source.file.storageKey !== job.source_revision) {
				await env.DB.prepare('DELETE FROM reading_jobs WHERE path=? AND source_revision=?').bind(job.path, job.source_revision).run();
			} else {
				// Three attempts fetch the page. Later ones publish the bookmark without an
				// article, so a note that cannot take its article stops refetching it.
				if (job.attempts < MAX_FETCH_ATTEMPTS) {
					try { const { fetchReadingCapture } = await import('./transport'); const capture = await fetchReadingCapture(job.url, env.READING_FETCH ? request => env.READING_FETCH!.fetch(request) : fetch, env.CRATE_PUBLIC_ORIGIN); result = capture.article; resolvedUrl = capture.url; }
					catch { if (job.attempts < MAX_FETCH_ATTEMPTS - 1) return; }
				}
				if (!await publishReading(env, { job, result, resolvedUrl } satisfies Publication)) throw new Error('Reading publication unavailable');
			}
		} catch { /* Keep the bounded lease and exact source for recovery. No article or URL logging. */ }
	}
	// Queue a capture still pending after a stale source or publication, or one a full queue held
	// back. Waking the coordinator for this would reset notification processing's retry budget.
	if (current.enabled && await env.DB.prepare('SELECT 1 FROM reading_index WHERE id=1 AND scope=? AND cursor IS NULL').bind(readingIndexScope(current)).first()) {
		await queueReadingArticles(env.DB).run();
	}
	const next = await env.DB.prepare('SELECT MIN(available_at) AS at FROM (SELECT available_at FROM reading_captures UNION ALL SELECT available_at FROM reading_jobs WHERE ?=1)').bind(current.enabled).first<{ at: number | null }>();
	if (next?.at != null) await state.storage.setAlarm(Math.max(Date.now() + 1000, next.at));
}

/** Return the next projection deadline, distinguishing a backlog from an outage. */
export async function scheduleReading(env: Env, loaded?: { encryption: EncryptionServerState | null; features: FeaturePolicy }): Promise<number | null> {
	if (loaded ? loaded.encryption : await readEncryptionState(env.DB)) return null;
	if (!(loaded ? loaded.features.reading : await featureEnabled(env.DB, 'reading'))) return null;
	const current = await policy(env.DB);
	if (!current) return null;
	const index = await ensureReadingIndex(env, current, file => readStoredNote(env, file));
	if (index.state === 'complete' && current.enabled) await queueReadingArticles(env.DB).run();
	if (await env.DB.prepare('SELECT 1 FROM reading_captures UNION ALL SELECT 1 FROM reading_jobs WHERE ?=1 LIMIT 1').bind(current.enabled).first()) {
		if (!await wakeReading(env)) throw new Error('Could not schedule Reading');
	}
	return index.state === 'complete' ? null : Date.now() + (index.state === 'unavailable' ? 30_000 : 1);
}
