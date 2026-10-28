import { readingUrl } from '@/reading/core/model';
import { parseJsonObject } from '../request-validation';
import type { Env } from '../types';
import { ReadingError, readingResponse } from './common';
import { fetchReadingCapture } from './extraction/transport';

/** Browsers cannot read most sites across origins, so an unlocked web app sends one
 * link here and encrypts the returned article itself. The link travels in the body,
 * never the URL, and neither it nor the article is stored, queued or logged. */
export async function extractForEncryptedReading(request: Request, env: Env): Promise<Response> {
	// Room for the longest saved link (8,192 characters), as Reading capture allows.
	const parsed = await parseJsonObject(request, 24_576);
	if (!parsed.ok) return parsed.response;
	let url: string; try { url = readingUrl(parsed.value.url); } catch { throw new ReadingError('Enter a complete HTTP or HTTPS link without credentials.'); }
	try {
		const { article } = await fetchReadingCapture(url, env.READING_FETCH ? request => env.READING_FETCH!.fetch(request) : fetch, env.CRATE_PUBLIC_ORIGIN);
		return readingResponse({ article });
	} catch {
		// The web app saves the link as a bookmark with Try again.
		throw new ReadingError('This article could not be downloaded.', 422, 'reading_extract_failed');
	}
}
