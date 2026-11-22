import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { expandGistEmbeds, MAX_GISTS } from './gist';

const id = (n: number) => n.toString(16).padStart(32, 'a');
const page = (body: string) => parseHTML(`<html><body>${body}</body></html>`).document;
const raw = (files: Record<string, string>) => vi.fn(async (request: Request) => {
	const text = files[request.url];
	return text === undefined ? new Response('Not found', { status: 404 }) : new Response(text, { headers: { 'Content-Type': 'text/plain' } });
});

describe('expandGistEmbeds', () => {
	it('replaces each gist embed with its code, from either script attribute', async () => {
		const document = page(`<p>Before</p>
			<div class="script-sandbox"><script data-sandbox-src="https://gist.github.com/someone/${id(1)}.js"></script></div>
			<script src="https://gist.github.com/someone/${id(2)}.js?file=Counter.swift"></script>
			<script src="https://gist.github.com/someone/${id(1)}.js"></script>
			<script src="https://example.com/analytics.js"></script>`);
		const transport = raw({
			[`https://gist.githubusercontent.com/someone/${id(1)}/raw`]: '$ dev cli ios\r\n> ls\r\n\r\n',
			[`https://gist.githubusercontent.com/someone/${id(2)}/raw/Counter.swift`]: 'struct Counter {}',
		});
		await expandGistEmbeds(document, transport);
		const blocks = Array.from(document.querySelectorAll('pre > code')).map(code => [code.getAttribute('class') || null, code.textContent]);
		expect(blocks).toEqual([[null, '$ dev cli ios\n> ls'], ['language-swift', 'struct Counter {}'], [null, '$ dev cli ios\n> ls']]);
		// A gist embedded twice is downloaded once; other scripts are left for Defuddle to remove.
		expect(transport).toHaveBeenCalledTimes(2);
		expect(transport.mock.calls.every(([request]) => request.redirect === 'manual' && request.credentials === 'omit')).toBe(true);
		expect(document.querySelectorAll('script')).toHaveLength(1);
	});

	it('links a gist it cannot download, and every gist past the limit', async () => {
		const scripts = Array.from({ length: MAX_GISTS + 2 }, (_, n) => `<script src="https://gist.github.com/someone/${id(n)}.js"></script>`).join('');
		const document = page(scripts);
		const transport = raw(Object.fromEntries(Array.from({ length: MAX_GISTS + 2 }, (_, n) => [`https://gist.githubusercontent.com/someone/${id(n)}/raw`, `code ${n}`])));
		transport.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }));
		await expandGistEmbeds(document, transport);
		expect(transport).toHaveBeenCalledTimes(MAX_GISTS);
		expect(document.querySelectorAll('pre')).toHaveLength(MAX_GISTS - 1);
		const links = Array.from(document.querySelectorAll('p > a')).map(link => link.getAttribute('href'));
		expect(links).toEqual([0, MAX_GISTS, MAX_GISTS + 1].map(n => `https://gist.github.com/someone/${id(n)}`));
		expect(document.querySelector('a')!.textContent).toBe('View code on GitHub');
	});

	it('links gists without downloading when extraction has no network access', async () => {
		const document = page(`<script src="https://gist.github.com/someone/${id(1)}.js"></script>`);
		await expandGistEmbeds(document, undefined);
		expect(document.querySelector('a')!.getAttribute('href')).toBe(`https://gist.github.com/someone/${id(1)}`);
	});

	it('refuses oversized, empty and undecodable gists', async () => {
		const document = page([1, 2, 3, 4].map(n => `<script src="https://gist.github.com/someone/${id(n)}.js"></script>`).join(''));
		await expandGistEmbeds(document, async request => {
			const n = Number.parseInt(new URL(request.url).pathname.split('/')[2]!.replace(/^a+/, ''), 16);
			if (n === 1) return new Response('x'.repeat(256 * 1024 + 1));
			if (n === 2) return new Response(' \n ');
			if (n === 3) return new Response(new Uint8Array([0xff, 0xfe, 0xfd]));
			return new Response('ok');
		});
		expect(document.querySelectorAll('p > a')).toHaveLength(3);
		expect(document.querySelector('pre')!.textContent).toBe('ok');
	});
});
