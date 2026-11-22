import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractDocument, linkYoutubeEmbeds, lowercaseHtmlAttributes } from './document';

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

	it('reads the author from camelCase microdata, as a browser does', async () => {
		// React writes `itemProp`; a browser reads it as `itemprop`. The date beside the
		// name must not join it.
		const page = `<html><head><title>Synthetic post</title></head><body><main><article>
			<div class="byline"><span itemProp="author" itemScope itemType="https://schema.org/Person"><a href="/authors/ada" itemProp="url"><span itemProp="name">Ada Example</span></a></span><div>Published on <time>Nov 5, 2026</time></div></div>
			<h1>Synthetic post</h1>${`<p>${paragraph.repeat(4)}</p>`.repeat(6)}
		</article></main></body></html>`;
		const { author } = await extractDocument(page, 'https://example.com/post');
		expect(author).toBe('Ada Example');
	});

	it('lowercases HTML attribute names but keeps case-sensitive SVG names', () => {
		const { document } = parseHTML('<html><body><img srcSet="a.png 1x" SRCSET="ignored"><svg viewBox="0 0 10 10"></svg></body></html>');
		lowercaseHtmlAttributes(document);
		const image = document.querySelector('img')!;
		expect(Array.from(image.getAttributeNames())).toEqual(['srcset']);
		expect(image.getAttribute('srcset')).toBe('a.png 1x');
		expect(document.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 10 10');
	});

	it('turns YouTube players and their placeholders into links to the video', () => {
		const { document } = parseHTML(`<html><body>
			<iframe src="//www.youtube.com/embed/d2tC3RuSbx8?rel=0"></iframe>
			<div data-component="youtube-facade" data-src="https://www.youtube-nocookie.com/embed/AAAAAAAAAAA"><iframe src="https://www.youtube-nocookie.com/embed/AAAAAAAAAAA"></iframe></div>
			<iframe src="https://player.vimeo.com/video/1"></iframe>
			<img data-src="https://www.youtube.com/embed/BBBBBBBBBBB">
		</body></html>`);
		linkYoutubeEmbeds(document, 'https://example.com/post');
		const links = Array.from(document.querySelectorAll('p > a')).map(link => [link.textContent, link.getAttribute('href')]);
		expect(links).toEqual([
			['Watch on YouTube', 'https://www.youtube.com/watch?v=d2tC3RuSbx8'],
			['Watch on YouTube', 'https://www.youtube.com/watch?v=AAAAAAAAAAA'],
		]);
		// Other players and images are left for the usual media rules.
		expect(document.querySelectorAll('iframe')).toHaveLength(1);
		expect(document.querySelector('img')).not.toBeNull();
	});
});
