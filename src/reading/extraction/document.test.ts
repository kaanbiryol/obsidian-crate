import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractDocument } from './document';

vi.mock('./markdown', () => ({ articleMarkdown: (body: HTMLElement) => body.textContent ?? '' }));

const paragraph = 'Synthetic article text that is long enough for Defuddle to score as the main content. ';
const html = `<html><head><title>Synthetic post</title></head><body>
  <main><article><h1>Synthetic post</h1>${`<p>${paragraph.repeat(4)}</p>`.repeat(6)}</article></main>
  <footer><p>Powered by a static site generator</p></footer>
</body></html>`;

describe('extractDocument', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	it('extracts the article when browser globals reject linkedom nodes', async () => {
		// Browsers expose getComputedStyle globally and throw for nodes from another DOM implementation.
		vi.stubGlobal('getComputedStyle', () => { throw new TypeError("parameter 1 is not of type 'Element'"); });
		const { markdown } = await extractDocument(html, 'https://example.com/post');
		expect(markdown).toContain('Synthetic article text');
		expect(markdown).not.toContain('Powered by');
	});
});
