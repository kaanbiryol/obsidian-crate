import { readEncryptionState } from '../encryption/state';
import { readingCapturePath, type ReadingNameSource } from '@/reading/core/filename';
import { parseReadingNote } from '@/reading/core/notes';
import { portablePathKey } from '@/protocol/portable-path';
import { namespacePredicate } from '../sync/file-namespace';
import { fileRevisionGuard } from '../sync/file-identity';
import { stageMarkdownFile } from '../sync/markdown-file-staging';
import { commitStagedFile } from '../sync/mutations';
import type { Env } from '../types';
import { policy } from './common';
import { assembleReadingArticle } from '@/reading/core/article';
import type { Publication } from './extraction/jobs';
import { publishReading } from '@/cloudflare/worker/coordinator/coordinator';
import type { StagedReadingImage } from './extraction/images';

/** Page fetches per job or capture; failed fetches and failed publications both count. */
export const MAX_FETCH_ATTEMPTS = 3;
/** After this many attempts, like an article job, a capture that still cannot publish
 * retries hourly instead of every minute. */
export const MAX_CAPTURE_ATTEMPTS = 8;
const EXHAUSTED_CAPTURE_RETRY_MS = 60 * 60_000;

export interface CapturePublication { captureId: string; generation: string; result: Publication['result']; resolvedUrl?: string; images?: StagedReadingImage[] }
export interface PendingCapture { id: string; generation: string; url_identity: string; note: string; attempts: number; available_at: number }
export async function capturePath(env: Env, folder: string, source: ReadingNameSource | null, id: string): Promise<string> {
	return readingCapturePath(folder, source, id, async path => {
		const predicate = namespacePredicate(path);
		// Separate branches keep each lookup on the primary key; a top-level OR scans files.
		return Boolean(await env.DB.prepare(`SELECT 1 FROM files WHERE portable_path=? UNION ALL SELECT 1 FROM files WHERE ${predicate.sql} LIMIT 1`)
			.bind(portablePathKey(path), ...predicate.args).first());
	});
}

/** Runs under the coordinator lock. Publication and queue removal share one transaction. */
export async function publishCapture(env: Env, id: string, generation: string, result: Publication['result'], resolvedUrl?: string, images?: StagedReadingImage[]): Promise<void> {
	if (await readEncryptionState(env.DB)) return ;
	const current = await policy(env.DB);
	if (!current || current.generation !== generation) return;
	const capture = await env.DB.prepare('SELECT note FROM reading_captures WHERE id=? AND generation=?').bind(id, generation).first<Pick<PendingCapture, 'note'>>();
	if (!capture) return; // A repeated delivery cannot recreate a deleted note.
	const item = parseReadingNote(capture.note)!;
	// Turning fetching off while a request is in flight still produces a useful bookmark.
	if (!current.enabled) result = null;
	if (result && images?.length) {
		const { publishArticleImages } = await import('./extraction/images');
		result = await publishArticleImages(env, result, images, current, item.crate_reading_id);
	}
	const { content, title } = assembleReadingArticle(capture.note, item, { kind: 'capture', article: result, resolvedUrl });
	const path = await capturePath(env, current.folder_path, { title, url: item.source_url }, id);
	const staged = await stageMarkdownFile(env.BUCKET, env.DB, path, content, null);
	const committed = await commitStagedFile(env.BUCKET, env.DB, { ...staged, content, readingPolicy: current, encryptionState: null,
		effects: files => {
			const revision = fileRevisionGuard(files[0]!.path, files[0]!.storageKey);
			return [env.DB.prepare(`DELETE FROM reading_captures WHERE id=? AND generation=? AND ${revision.sql}`).bind(id, generation, ...revision.args)];
		} });
	if (!committed.committed) throw new Error('Reading capture publication must retry.');
}

/** Handles the next due capture, if any. Returns whether there was one. */
export async function runCapture(env: Env, state: DurableObjectState, enabled: boolean, saveImages = false): Promise<boolean> {
	if (await readEncryptionState(env.DB)) return false;
	const capture = await env.DB.prepare('SELECT id, generation, note, attempts FROM reading_captures WHERE available_at<=? ORDER BY available_at LIMIT 1').bind(Date.now()).first<Pick<PendingCapture, 'id' | 'generation' | 'note' | 'attempts'>>();
	if (!capture) return false;
	// Queued captures are listed in this order.
	await env.DB.prepare(`UPDATE reading_captures SET available_at=CASE WHEN attempts+1>=${MAX_CAPTURE_ATTEMPTS} THEN ? ELSE ? END,
		attempts=attempts+1 WHERE id=?`).bind(Date.now() + EXHAUSTED_CAPTURE_RETRY_MS, Date.now() + 60_000, capture.id).run();
	await state.storage.setAlarm(Date.now() + 60_000);
	let result: Publication['result'] = null, resolvedUrl: string | undefined, images: StagedReadingImage[] | undefined;
	// After its fetch attempts, a capture that still cannot publish retries as a bookmark only.
	if (enabled && capture.attempts < MAX_FETCH_ATTEMPTS) {
		const fetchPublic = env.READING_FETCH ? (request: Request) => env.READING_FETCH!.fetch(request) : fetch;
		const item = parseReadingNote(capture.note)!;
		try {
			const { fetchReadingCapture } = await import('./extraction/transport');
			const captureResult = await fetchReadingCapture(item.source_url, fetchPublic, env.CRATE_PUBLIC_ORIGIN);
			result = captureResult.article; resolvedUrl = captureResult.url;
		} catch { if (capture.attempts < MAX_FETCH_ATTEMPTS - 1) return true; }
		images = result && saveImages ? await stageImages(env, result, item.crate_reading_id, fetchPublic) : undefined;
	}
	const publication: CapturePublication = { captureId: capture.id, generation: capture.generation, result, resolvedUrl, ...(images?.length ? { images } : {}) };
	if (!await publishReading(env, publication)) throw new Error('Reading capture publication unavailable');
	return true;
}

/** Images are optional: a failed download or R2 write leaves the article with its links. */
export async function stageImages(env: Env, article: NonNullable<Publication['result']>, id: string, fetchPublic: (request: Request) => Promise<Response>): Promise<StagedReadingImage[] | undefined> {
	const current = await policy(env.DB);
	if (!current) return undefined;
	const { stageArticleImages } = await import('./extraction/images');
	return stageArticleImages(env, article, current.folder_path, id, fetchPublic, env.CRATE_PUBLIC_ORIGIN).catch(() => undefined);
}
