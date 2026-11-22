import { mapBounded } from '@/platform/map-bounded';
import type { ExtractorTransport } from './defuddle-fetch';

/** Gists downloaded per article, one request each; later ones stay links. The Worker saves
 * fewer images when gists use part of its request budget. */
export const MAX_GISTS = 16;
const MAX_GIST_BYTES = 256 * 1024, TIMEOUT_MS = 10_000, CONCURRENCY = 4;
const GIST_SCRIPT = /^https:\/\/gist\.github\.com\/([\w-]{1,100})\/([0-9a-f]{20,64})\.js$/i;
// Fence languages for the file names gist embeds most often name.
const LANGUAGES: Record<string, string> = {
	js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', rb: 'ruby', go: 'go',
	rs: 'rust', swift: 'swift', kt: 'kotlin', kts: 'kotlin', java: 'java', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', php: 'php',
	sh: 'bash', bash: 'bash', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', css: 'css', scss: 'scss', html: 'xml', xml: 'xml',
	md: 'markdown', dart: 'dart', scala: 'scala', lua: 'lua', diff: 'diff', graphql: 'graphql',
};

interface Gist { user: string; id: string; file?: string }
const gistKey = (gist: Gist) => `${gist.user}/${gist.id}/${gist.file ?? ''}`;

/** The gist a script embeds, from its `src` or the `data-sandbox-src` a loader swaps in. */
function embeddedGist(script: Element): Gist | null {
	try {
		const url = new URL(script.getAttribute('src') || script.getAttribute('data-sandbox-src') || '');
		const match = GIST_SCRIPT.exec(`${url.origin}${url.pathname}`);
		if (!match || url.username || url.password || url.port) return null;
		const file = url.searchParams.get('file')?.trim();
		return { user: match[1]!, id: match[2]!.toLowerCase(), ...(file && file.length <= 200 && !file.includes('/') ? { file } : {}) };
	} catch { return null; }
}

/** One gist file's text, or null for any failure. A gist without a named file answers its first. */
async function downloadGist(gist: Gist, transport: ExtractorTransport): Promise<string | null> {
	try {
		const url = `https://gist.githubusercontent.com/${gist.user}/${gist.id}/raw${gist.file ? `/${encodeURIComponent(gist.file)}` : ''}`;
		const response = await transport(new Request(url, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
			headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(TIMEOUT_MS) }));
		if (response.status !== 200 || Number(response.headers.get('Content-Length')) > MAX_GIST_BYTES) { await response.body?.cancel(); return null; }
		const reader = response.body?.getReader(); if (!reader) return null;
		const chunks: Uint8Array[] = []; let size = 0;
		try { for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.length; if (size > MAX_GIST_BYTES) return null; chunks.push(value);
		} } finally { await reader.cancel(); }
		const bytes = new Uint8Array(size); let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
		return text.trim() ? text : null;
	} catch { return null; }
}

/**
 * GitHub gist embeds are scripts that write the code into the page, so a downloaded page has
 * none of it. Each embed becomes a code block of its gist, read through `transport`; one that
 * fails, is past MAX_GISTS or has no transport becomes a link to the gist instead.
 */
export async function expandGistEmbeds(document: Document, transport: ExtractorTransport | undefined): Promise<void> {
	const embeds = Array.from(document.querySelectorAll('script')).flatMap(script => {
		const gist = embeddedGist(script);
		return gist ? [{ script, gist }] : [];
	});
	if (!embeds.length) return;
	const gists = [...new Map(embeds.map(({ gist }) => [gistKey(gist), gist])).values()].slice(0, transport ? MAX_GISTS : 0);
	const texts = await mapBounded(gists, CONCURRENCY, gist => downloadGist(gist, transport!));
	const code = new Map(gists.map((gist, index) => [gistKey(gist), texts[index]]));
	for (const { script, gist } of embeds) {
		const text = code.get(gistKey(gist));
		let replacement: HTMLElement;
		if (text) {
			replacement = document.createElement('pre');
			const block = document.createElement('code'), language = LANGUAGES[/\.([a-z0-9]+)$/i.exec(gist.file ?? '')?.[1]?.toLowerCase() ?? ''];
			if (language) block.setAttribute('class', `language-${language}`);
			block.textContent = text;
			replacement.append(block);
		} else {
			replacement = document.createElement('p');
			const link = document.createElement('a');
			link.setAttribute('href', `https://gist.github.com/${gist.user}/${gist.id}`);
			link.textContent = 'View code on GitHub';
			replacement.append(link);
		}
		script.replaceWith(replacement);
	}
}
