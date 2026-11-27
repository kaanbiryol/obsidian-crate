import { readingUrl } from '@/reading/core/model';
import { parseJsonObject, SMALL_JSON_BODY_BYTES } from '../http/request-validation';
import type { Env } from '../types';
import { ReadingError, readingResponse } from './common';
import { fetchReadingCapture } from './extraction/transport';
import { TRANSFER_PATHS } from '../coordinator/coordinator';
import { forwardTransferRequest } from '../sync/transfer-dispatch';

/** Images stop downloading this long after the request arrived, inside the web app's 20 second wait. */
const IMAGE_DEADLINE_MS = 16_000;
/** Set by the public Worker from the feature policy; any value a client sent is replaced. */
const IMAGES_PARAM = 'images';

/** Hands an admitted request to the extraction pool, whose CPU budget can parse a page. */
export function forwardEncryptedExtract(request: Request, env: Env, saveImages: boolean): Promise<Response> {
	const target = new URL(request.url);
	if (saveImages) target.searchParams.set(IMAGES_PARAM, '1'); else target.searchParams.delete(IMAGES_PARAM);
	return forwardTransferRequest(new Request(target, request), env, TRANSFER_PATHS.readingExtract);
}

/** Runs in the extraction pool, answering as the public Worker would. */
export async function extractInTransfer(request: Request, env: Env): Promise<Response> {
	try {
		return await extractForEncryptedReading(request, env, new URL(request.url).searchParams.get(IMAGES_PARAM) === '1');
	} catch (error) {
		if (error instanceof ReadingError) return error.toResponse();
		throw error;
	}
}

/** Browsers cannot read most sites across origins, so an unlocked web app sends one
 * link here and encrypts the returned article itself. The link travels in the body,
 * never the URL, and neither it nor the article is stored, queued or logged. */
async function extractForEncryptedReading(request: Request, env: Env, saveImages = false): Promise<Response> {
	const started = Date.now();
	// Room for the longest saved link (8,192 characters), as Reading capture allows.
	const parsed = await parseJsonObject(request, SMALL_JSON_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	let url: string; try { url = readingUrl(parsed.value.url); } catch { throw new ReadingError('Enter a complete HTTP or HTTPS link without credentials.'); }
	try {
		const fetchPublic = env.READING_FETCH ? (request: Request) => env.READING_FETCH!.fetch(request) : fetch;
		const { article, requests } = await fetchReadingCapture(url, fetchPublic, env.CRATE_PUBLIC_ORIGIN);
		// Images are optional, and a retry asks for none.
		const images = saveImages && parsed.value.images !== false ? await (await import('./extraction/images')).downloadImagesForEncryptedReading(article, fetchPublic, env.CRATE_PUBLIC_ORIGIN, requests,
			AbortSignal.timeout(Math.max(0, started + IMAGE_DEADLINE_MS - Date.now()))) : [];
		return readingResponse({ article, ...(images.length ? { images } : {}) });
	} catch {
		// The web app saves the link as a bookmark with Try again.
		throw new ReadingError('This article could not be downloaded.', 422, 'reading_extract_failed');
	}
}
