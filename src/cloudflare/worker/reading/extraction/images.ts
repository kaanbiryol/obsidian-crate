import { extractionUrl } from '@/reading/extraction/url';
import { downloadArticleImages, downloadReadingImages, linkSavedImages, readingImageFolder, readingImageUrls, type ReadingImageLimits } from '@/reading/core/article-images';
import { isPathInFolder } from '@/protocol/note-paths';
import { createManagedObjectKey } from '@/protocol/storage-keys';
import { sha256Hex } from '@/platform/sha256';
import type { CapturedArticle } from '@/reading/core/article';
import { trackUploadLease, finishUploadLeases } from '../../sync/staging/upload-leases';
import { commitStagedFiles } from '../../sync/mutations';
import { loadStoredFileRows } from '../../sync/storage';
import type { ReadingIndexPolicy } from '../library-index';
import { stageReadingImagesRemotely } from '../../coordinator/coordinator';
import type { Env } from '../../types';

/** The Workers Free plan allows 50 subrequests per invocation, and fetches, R2 and D1 calls
 * all count. A saved image costs its fetch (2 with a redirect), an upload lease and an R2
 * write, so an article's images are staged in batches, each its own Durable Object request
 * and so its own invocation; publication commits them in groups (see image-budget.integration.ts). */
export const WORKER_IMAGE_LIMITS: ReadingImageLimits = { count: 100, bytes: 10 * 1024 * 1024, totalBytes: 40 * 1024 * 1024 };
export const READING_IMAGE_BATCH = 10;
/** Batches staged at once. Each holds at most two images in memory, and batches may share an isolate. */
const BATCH_CONCURRENCY = 5;
/** Images committed in one D1 batch, as many as a sync batch upload commits. */
const IMAGE_COMMIT_GROUP = 32;
/** Each batch finishes well within the minute a capture or job lease lasts. */
const BATCH_TIMEOUT_MS = 25_000;
const TIMEOUT_MS = 10_000, MAX_REDIRECTS = 1;

/** An image stored in R2 under an upload lease, waiting for its note to publish. JSON-safe,
 * so the coordinator receives object keys rather than bytes. */
export interface StagedReadingImage { url: string; path: string; hash: string; size: number; objectKey: string; leaseId: string; type: string }

export async function fetchImage(source: string, maxBytes: number, signal: AbortSignal, fetchPublic: (request: Request) => Promise<Response>, ownOrigin?: string): Promise<Uint8Array | null> {
	const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
	let url = extractionUrl(source);
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		if (url.protocol !== 'https:' || ownOrigin && url.hostname === new URL(ownOrigin).hostname) return null;
		const response = await fetchPublic(new Request(url, { signal: timeout, redirect: 'manual', credentials: 'omit', headers: {
			Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': 'Crate/1.0 (read-it-later)',
		} }));
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get('Location'); if (!location) return null;
			url = extractionUrl(new URL(location, url).href); continue;
		}
		if (!response.ok || Number(response.headers.get('Content-Length')) > maxBytes) { await response.body?.cancel(); return null; }
		const reader = response.body?.getReader(); if (!reader) return null;
		const chunks: Uint8Array[] = []; let size = 0;
		try { for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.length; if (size > maxBytes) return null; chunks.push(value);
		} } finally { await reader.cancel(); }
		const bytes = new Uint8Array(size); let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		return bytes;
	}
	return null;
}

/** For an encrypted vault, which the server cannot write: an article's images as bytes the
 * web app encrypts and commits with its note. Small enough to fit one encrypted commit. */
export const ENCRYPTED_IMAGE_LIMITS: ReadingImageLimits = { count: 10, bytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 };
export async function downloadImagesForEncryptedReading(article: CapturedArticle, fetchPublic: (request: Request) => Promise<Response>, ownOrigin?: string): Promise<Array<{ url: string; type: string; data: string }>> {
	if (article.transcript) return [];
	// The folder and ID are the web app's to choose; only the bytes leave here.
	const files = await downloadArticleImages(article.markdown, { folder: 'Reading', id: '00000000-0000-4000-8000-000000000000', signal: AbortSignal.timeout(30_000),
		limits: ENCRYPTED_IMAGE_LIMITS, fetchImage: (url, maxBytes, abort) => fetchImage(url, maxBytes, abort, fetchPublic, ownOrigin) }).catch(() => []);
	return files.map(file => ({ url: file.url, type: file.type, data: base64(file.bytes) }));
}
function base64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** One batch of an article's images, numbered by their place among its image links. */
export interface ReadingImageBatch { folder: string; id: string; images: { url: string; number: number }[] }
export type ReadingImageBatchStager = (batch: ReadingImageBatch) => Promise<StagedReadingImage[]>;
export function parseReadingImageBatch(value: unknown): ReadingImageBatch | null {
	if (!value || typeof value !== 'object') return null;
	const { folder, id, images } = value as Record<string, unknown>;
	if (typeof folder !== 'string' || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !Array.isArray(images) || images.length > READING_IMAGE_BATCH) return null;
	const entries = images.filter((image): image is { url: string; number: number } => !!image && typeof (image as { url?: unknown }).url === 'string'
		&& Number.isInteger((image as { number?: unknown }).number) && (image as { number: number }).number >= 1 && (image as { number: number }).number <= WORKER_IMAGE_LIMITS.count!);
	return entries.length === images.length ? { folder, id, images: entries.map(({ url, number }) => ({ url, number })) } : null;
}

/** Downloads one batch and stores each image in R2 under its own upload lease as it arrives.
 * Nothing is published: an image the publication does not commit is cleaned up with its lease. */
export async function stageReadingImageBatch(env: Env, batch: ReadingImageBatch,
	fetchPublic: (request: Request) => Promise<Response>, ownOrigin?: string): Promise<StagedReadingImage[]> {
	const staged: StagedReadingImage[] = [];
	await downloadReadingImages(batch.images.slice(0, READING_IMAGE_BATCH), { folder: batch.folder, id: batch.id, signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
		limits: WORKER_IMAGE_LIMITS, concurrency: 2, fetchImage: (url, maxBytes, abort) => fetchImage(url, maxBytes, abort, fetchPublic, ownOrigin),
		onFile: async file => {
			const body = file.bytes.slice().buffer, hash = await sha256Hex(body), objectKey = createManagedObjectKey(hash);
			const { id: leaseId } = await trackUploadLease(env.DB, [{ storageKey: objectKey, path: file.path }]);
			await env.BUCKET.put(objectKey, body, { httpMetadata: { contentType: file.type }, customMetadata: { hash } });
			staged.push({ url: file.url, path: file.path, hash, size: body.byteLength, objectKey, leaseId, type: file.type });
		} }).catch(() => {});
	return staged;
}

/** The image pool's request handler: stages the batch with the server's own transport. */
export async function handleReadingImageBatch(request: Request, env: Env): Promise<Response> {
	const batch = parseReadingImageBatch(await request.json().catch(() => null));
	if (!batch) return new Response('Invalid image batch', { status: 400 });
	const fetchPublic = env.READING_FETCH ? (outbound: Request) => env.READING_FETCH!.fetch(outbound) : fetch;
	return Response.json(await stageReadingImageBatch(env, batch, fetchPublic, env.CRATE_PUBLIC_ORIGIN));
}

/** Sends a batch to its instance of the image pool. */
export async function stageImageBatchRemotely(env: Env, batch: ReadingImageBatch): Promise<StagedReadingImage[]> {
	const response = await stageReadingImagesRemotely(env, Math.floor((batch.images[0]!.number - 1) / READING_IMAGE_BATCH), JSON.stringify(batch));
	if (!response.ok) throw new Error('Reading image batch unavailable');
	return await response.json() as StagedReadingImage[];
}

/** Stages an article's images, sending each batch of `READING_IMAGE_BATCH` to `stageBatch`.
 * A batch that fails leaves its images with their links. */
export async function stageArticleImages(article: CapturedArticle, folder: string, id: string,
	stageBatch: ReadingImageBatchStager): Promise<StagedReadingImage[]> {
	if (article.transcript) return [];
	const images = readingImageUrls(article.markdown, WORKER_IMAGE_LIMITS.count).map((url, index) => ({ url, number: index + 1 }));
	const batches: ReadingImageBatch[] = [];
	for (let start = 0; start < images.length; start += READING_IMAGE_BATCH) batches.push({ folder, id, images: images.slice(start, start + READING_IMAGE_BATCH) });
	const staged: StagedReadingImage[] = [];
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
		while (next < batches.length) staged.push(...await stageBatch(batches[next++]!).catch(() => []));
	}));
	return staged.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
}

/**
 * Runs under the coordinator lock, before the note commits: publishes the staged images
 * that still belong to this article's folder and returns the article linking to them. The
 * note never links to an image that is not live, and an image that does not commit keeps
 * its web link. Unpublished objects leave their lease for cleanup.
 */
export async function publishArticleImages(env: Env, article: CapturedArticle, images: readonly StagedReadingImage[] | undefined,
	policy: { folder_path: string } & ReadingIndexPolicy, id: string): Promise<CapturedArticle> {
	if (!images?.length) return article;
	const folder = readingImageFolder(policy.folder_path, id);
	const published: StagedReadingImage[] = [], skipped: StagedReadingImage[] = [], candidates: StagedReadingImage[] = [];
	let total = 0;
	for (const image of [...images].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))) {
		// Batches cannot share a size budget, so the article's total applies here, in order.
		if (!isPathInFolder(image.path, folder) || candidates.some(other => other.path === image.path) || total + image.size > WORKER_IMAGE_LIMITS.totalBytes) { skipped.push(image); continue; }
		total += image.size; candidates.push(image);
	}
	for (let start = 0; start < candidates.length; start += IMAGE_COMMIT_GROUP) {
		const group = candidates.slice(start, start + IMAGE_COMMIT_GROUP);
		try {
			const current = await loadStoredFileRows(env.DB, group.map(image => image.path));
			// A retried publication finds the copies an earlier attempt committed.
			const fresh = group.filter(image => current.get(image.path)?.hash !== image.hash);
			for (const image of group) if (!fresh.includes(image)) { published.push(image); skipped.push(image); }
			const results = await commitStagedFiles(env.BUCKET, env.DB, fresh.map(image => {
				const row = current.get(image.path);
				return { ...image, content: new ArrayBuffer(0), expectedHash: row?.hash ?? null, ...(row?.storageKey ? { expectedRevision: row.storageKey } : {}), readingPolicy: policy, encryptionState: null };
			}));
			fresh.forEach((image, index) => { if (results[index]?.committed) published.push(image); });
		} catch { skipped.push(...group.filter(image => !published.includes(image) && !skipped.includes(image))); }
	}
	if (skipped.length) await env.DB.batch(finishUploadLeases(env.DB, skipped));
	return published.length ? { ...article, markdown: linkSavedImages(article.markdown, policy.folder_path, published) } : article;
}
