import { extractionUrl } from '@/reading/extraction/url';
import { downloadArticleImages, linkSavedImages, readingImageFolder, type ReadingImageLimits } from '@/reading/core/article-images';
import { isPathInFolder } from '@/protocol/note-paths';
import { createManagedObjectKey } from '@/protocol/storage-keys';
import { sha256Hex } from '@/platform/sha256';
import type { CapturedArticle } from '@/reading/core/article';
import { trackUploadLease, finishUploadLeases } from '../../sync/staging/upload-leases';
import { commitStagedFile } from '../../sync/mutations';
import { getStoredFileRow } from '../../sync/storage';
import type { ReadingIndexPolicy } from '../library-index';
import type { Env } from '../../types';

/** The Workers Free plan allows 50 subrequests per invocation, and fetches, R2 and D1 calls all
 * count. Staging an image costs its fetch (2 with a redirect) and an R2 write, beside the page
 * fetch and the run's own queries; publishing costs 2 D1 queries per image beside the note's
 * commit. Ten images keep both invocations under 50 (see image-budget.integration.ts). */
export const WORKER_IMAGE_LIMITS: ReadingImageLimits = { count: 10, bytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 };
const TIMEOUT_MS = 10_000, MAX_REDIRECTS = 1;

/** `limits` with fewer images once the article's download made `requests` requests: the limits
 * assume one, for the page. Extra ones, such as gists, each take a share of an image, which may
 * cost `perImage` subrequests. */
function afterArticleRequests(limits: ReadingImageLimits, requests: number, perImage: number): ReadingImageLimits {
	return { ...limits, count: Math.max(0, limits.count! - Math.ceil(Math.max(0, requests - 1) / perImage)) };
}

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
/** `deadline` ends image downloads early: an image not finished by then keeps its web link,
 * so the article still answers before the web app stops waiting. */
export async function downloadImagesForEncryptedReading(article: CapturedArticle, fetchPublic: (request: Request) => Promise<Response>, ownOrigin?: string, articleRequests = 1,
	deadline?: AbortSignal): Promise<Array<{ url: string; type: string; data: string }>> {
	if (article.transcript) return [];
	// The folder and ID are the web app's to choose; only the bytes leave here.
	const files = await downloadArticleImages(article.markdown, { folder: 'Reading', id: '00000000-0000-4000-8000-000000000000', signal: AbortSignal.timeout(30_000),
		// An image here costs up to two fetches; nothing is stored.
		limits: afterArticleRequests(ENCRYPTED_IMAGE_LIMITS, articleRequests, 2),
		fetchImage: (url, maxBytes, abort) => fetchImage(url, maxBytes, deadline ? AbortSignal.any([abort, deadline]) : abort, fetchPublic, ownOrigin) }).catch(() => []);
	return files.map(file => ({ url: file.url, type: file.type, data: base64(file.bytes) }));
}
function base64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Downloads an article's images and stores them in R2 under one lease. Nothing is
 * published: an image the publication does not commit is cleaned up with its lease. */
export async function stageArticleImages(env: Env, article: CapturedArticle, folder: string, id: string,
	fetchPublic: (request: Request) => Promise<Response>, ownOrigin?: string, articleRequests = 1): Promise<StagedReadingImage[]> {
	if (article.transcript) return [];
	const signal = AbortSignal.timeout(30_000);
	// Staging an image costs up to two fetches and an R2 write.
	const files = await downloadArticleImages(article.markdown, { folder, id, signal, limits: afterArticleRequests(WORKER_IMAGE_LIMITS, articleRequests, 3),
		fetchImage: (url, maxBytes, abort) => fetchImage(url, maxBytes, abort, fetchPublic, ownOrigin) });
	if (!files.length) return [];
	const prepared = await Promise.all(files.map(async file => {
		const hash = await sha256Hex(file.bytes.slice().buffer);
		return { ...file, hash, objectKey: createManagedObjectKey(hash) };
	}));
	const { id: leaseId } = await trackUploadLease(env.DB, prepared.map(file => ({ storageKey: file.objectKey, path: file.path })));
	const staged: StagedReadingImage[] = [];
	for (const file of prepared) {
		await env.BUCKET.put(file.objectKey, file.bytes.slice().buffer, { httpMetadata: { contentType: file.type }, customMetadata: { hash: file.hash } });
		staged.push({ url: file.url, path: file.path, hash: file.hash, size: file.bytes.byteLength, objectKey: file.objectKey, leaseId, type: file.type });
	}
	return staged;
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
	const published: StagedReadingImage[] = [], skipped: StagedReadingImage[] = [];
	for (const image of images) {
		if (!isPathInFolder(image.path, folder)) { skipped.push(image); continue; }
		try {
			const current = await getStoredFileRow(env.DB, image.path);
			// A retried publication finds the copy an earlier attempt committed.
			if (current?.hash === image.hash) { published.push(image); skipped.push(image); continue; }
			const result = await commitStagedFile(env.BUCKET, env.DB, { ...image, content: new ArrayBuffer(0), expectedHash: current?.hash ?? null,
				...(current?.storageKey ? { expectedRevision: current.storageKey } : {}), readingPolicy: policy, encryptionState: null });
			if (result.committed) published.push(image);
		} catch { skipped.push(image); }
	}
	if (skipped.length) await env.DB.batch(finishUploadLeases(env.DB, skipped));
	return published.length ? { ...article, markdown: linkSavedImages(article.markdown, policy.folder_path, published) } : article;
}
