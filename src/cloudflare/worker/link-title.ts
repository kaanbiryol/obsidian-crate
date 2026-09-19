import { corsResponse } from './cors';
import { parseJsonObject } from './utils';

const MAX_HTML_BYTES = 256 * 1024;

function extractTitle(html: string): string | null {
	let cursor = 0;
	while (cursor < html.length) {
		const start = html.indexOf('<', cursor);
		if (start < 0) return null;
		if (html.startsWith('<!--', start)) {
			const end = html.indexOf('-->', start + 4);
			if (end < 0) return null;
			cursor = end + 3;
			continue;
		}
		// Consume a whole tag, including quoted attributes, before looking for a title.
		// An incomplete tag or raw-text block must wait for the next stream chunk.
		const tag = html.slice(start).match(/^<(?:[^"'<>]|"[^"]*"|'[^']*')*>/);
		if (!tag) return null;
		cursor = start + tag[0].length;
		const name = tag[0].match(/^<([a-z][a-z0-9-]*)(?=[\s/>])/i)?.[1]?.toLowerCase();
		if (!name) continue;
		if (name === 'plaintext') return null;
		if (['title', 'script', 'style', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template', 'svg'].includes(name)) {
			const closing = new RegExp(`</${name}\\s*>`, 'gi');
			closing.lastIndex = cursor;
			const end = closing.exec(html);
			if (!end) return null;
			if (name === 'title') {
				const title = html.slice(cursor, end.index);
				return title.length <= 4096 ? title.trim() || null : null;
			}
			cursor = closing.lastIndex;
		}
	}
	return null;
}

/** Only public DNS names on standard web ports; global Worker fetch has no private bindings. */
function publicPageUrl(value: unknown): URL | null {
	if (typeof value !== 'string' || value.length > 4096) return null;
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase().replace(/\.$/, '');
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
			|| !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
			|| /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) return null;
		url.hash = '';
		return url;
	} catch { return null; }
}

/** Read just the bounded HTML prefix; never execute scripts or load page resources. */
async function readTitle(response: Response): Promise<string | null> {
	if (!response.ok || !/^text\/html\b/i.test(response.headers.get('Content-Type') ?? '') || !response.body) {
		await response.body?.cancel();
		return null;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let html = '';
	let bytes = 0;
	try {
		while (bytes < MAX_HTML_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = MAX_HTML_BYTES - bytes;
			html += decoder.decode(value.subarray(0, remaining), { stream: true });
			bytes += value.byteLength;
			if (/<\/title\s*>/i.test(html) && extractTitle(html)) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return extractTitle(html);
}

export async function handleLinkTitle(request: Request): Promise<Response> {
	const parsed = await parseJsonObject(request, 8192);
	if (!parsed.ok) return parsed.response;
	let url = publicPageUrl(parsed.value.url);
	if (!url) return corsResponse({ title: null }, 400);
	const signal = AbortSignal.timeout(5000);
	try {
		for (let redirects = 0; redirects <= 3; redirects++) {
			// Fresh headers deliberately exclude the caller's authorization and cookies.
			const response: Response = await fetch(url.href, { signal, redirect: 'manual', headers: { Accept: 'text/html' } });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel();
				const location: string | null = response.headers.get('Location');
				url = location ? publicPageUrl(new URL(location, url).href) : null;
				if (!url) break;
				continue;
			}
			return corsResponse({ title: await readTitle(response) });
		}
	} catch { /* Offline, blocked, slow, or unreadable pages leave the URL label intact. */ }
	return corsResponse({ title: null });
}
