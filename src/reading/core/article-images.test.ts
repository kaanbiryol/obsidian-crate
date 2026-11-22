import { describe, expect, it, vi } from 'vitest';
import { downloadArticleImages, isReadingImagePath, linkedVaultImages, linkSavedImages, readingImageFormat, readingImageSource, type ReadingImageFetch } from './article-images';

const id = '0cf86c65-51e2-4e2b-8987-0a4732473588';
const png = (marker: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const webp = new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')]);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const signal = new AbortController().signal;

function fetcher(bodies: Record<string, Uint8Array | null>) {
	return vi.fn<ReadingImageFetch>(async (url: string) => bodies[url] ?? null);
}

describe('article images', () => {
	it('identifies raster formats by their bytes and refuses SVG', () => {
		expect(readingImageFormat(png(1))).toEqual({ extension: 'png', type: 'image/png' });
		expect(readingImageFormat(jpeg)?.extension).toBe('jpg');
		expect(readingImageFormat(webp)?.extension).toBe('webp');
		expect(readingImageFormat(svg)).toBeNull();
	});

	it('saves each https image once and links it from the note', async () => {
		const markdown = 'Intro\n\n![A [cat]](https://cdn.example/a.png "Title")\n\n[![Linked](https://cdn.example/b.jpg)](https://example.com/b)\n\nAgain ![](https://cdn.example/a.png)\n\n`![code](https://cdn.example/code.png)`\n';
		const fetchImage = fetcher({ 'https://cdn.example/a.png': png(1), 'https://cdn.example/b.jpg': jpeg });
		const files = await downloadArticleImages(markdown, { folder: 'Reading', id, fetchImage, signal });
		expect(files.map(file => file.path)).toEqual([`Reading/attachments/${id}/1.png`, `Reading/attachments/${id}/2.jpg`]);
		expect(fetchImage.mock.calls.map(call => call[0])).toEqual(['https://cdn.example/a.png', 'https://cdn.example/b.jpg']);
		expect(linkSavedImages(markdown, 'Reading', files)).toBe(`Intro\n\n![A \\[cat\\]](attachments/${id}/1.png)\n\n[![Linked](attachments/${id}/2.jpg)](https://example.com/b)\n\nAgain ![](attachments/${id}/1.png)\n\n\`![code](https://cdn.example/code.png)\`\n`);
	});

	it('keeps the link of an image that fails, is not a raster image, is not https or is over a limit', async () => {
		const markdown = '![a](https://cdn.example/a.png) ![b](https://cdn.example/b.svg) ![c](http://cdn.example/c.png) ![d](https://cdn.example/missing.png) ![e](https://cdn.example/e.png) ![f](https://cdn.example/f.png)';
		const fetchImage = fetcher({ 'https://cdn.example/a.png': png(1), 'https://cdn.example/b.svg': svg, 'https://cdn.example/e.png': new Uint8Array(64).fill(0x89), 'https://cdn.example/f.png': png(2) });
		const files = await downloadArticleImages(markdown, { folder: 'Reading', id, fetchImage, signal, limits: { count: 4, bytes: 32, totalBytes: 1024 } });
		expect(files.map(file => file.url)).toEqual(['https://cdn.example/a.png']);
		// Only https links are requested, and only the first `count` of them.
		expect(fetchImage.mock.calls.map(call => call[0])).toEqual(['https://cdn.example/a.png', 'https://cdn.example/b.svg', 'https://cdn.example/missing.png', 'https://cdn.example/e.png']);
		expect(linkSavedImages(markdown, 'Reading', files)).toBe(markdown.replace('https://cdn.example/a.png', `attachments/${id}/1.png`));
	});

	it('saves every image when the device sets no count', async () => {
		const urls = Array.from({ length: 40 }, (_, i) => `https://cdn.example/${i}.png`);
		const files = await downloadArticleImages(urls.map(url => `![](${url})`).join('\n\n'), { folder: 'Reading', id, signal,
			fetchImage: fetcher(Object.fromEntries(urls.map((url, i) => [url, png(i)]))) });
		expect(files).toHaveLength(40);
	});

	it('stops at the total size limit', async () => {
		const markdown = '![](https://cdn.example/1.png) ![](https://cdn.example/2.png)';
		const files = await downloadArticleImages(markdown, { folder: 'Reading', id, signal, concurrency: 1, limits: { count: 10, bytes: 100, totalBytes: 12 },
			fetchImage: fetcher({ 'https://cdn.example/1.png': png(1), 'https://cdn.example/2.png': png(2) }) });
		expect(files).toHaveLength(1);
	});

	it('stops downloading once the total size is used and asks only for what still fits', async () => {
		const image = (marker: number) => { const bytes = new Uint8Array(10); bytes.set(png(marker)); return bytes; };
		const urls = Array.from({ length: 50 }, (_, i) => `https://cdn.example/${i}.png`);
		const fetchImage = vi.fn<ReadingImageFetch>(async (url, maxBytes) => image(urls.indexOf(url)).length <= maxBytes ? image(urls.indexOf(url)) : null);
		const files = await downloadArticleImages(urls.map(url => `![](${url})`).join('\n\n'), { folder: 'Reading', id, signal, fetchImage,
			limits: { bytes: 100, totalBytes: 95 } });
		expect(files).toHaveLength(9);
		// Four downloads run at once, so up to three more start before the ninth image fills the total.
		expect(fetchImage.mock.calls.length).toBeLessThanOrEqual(13);
		expect(fetchImage.mock.calls.at(-1)?.[1]).toBeLessThan(10);
	});

	it('resolves image sources against the note, refusing other schemes and paths outside the vault', () => {
		expect(readingImageSource('https://cdn.example/a.png', 'Reading/Note.md')).toEqual({ kind: 'remote', url: 'https://cdn.example/a.png' });
		expect(readingImageSource(`attachments/${id}/1.png`, 'Reading/Note.md')).toEqual({ kind: 'vault', path: `Reading/attachments/${id}/1.png` });
		expect(readingImageSource('../Images/My%20photo.JPG', 'Reading/Sub/Note.md')).toEqual({ kind: 'vault', path: 'Reading/Images/My photo.JPG' });
		for (const src of ['data:image/png;base64,AAAA', 'http://cdn.example/a.png', 'file:///etc/passwd', 'javascript:alert(1)', '//cdn.example/a.png', '../../../a.png', 'notes.md', '%E0%A4%A.png'])
			expect(readingImageSource(src, 'Reading/Note.md')).toBeNull();
	});

	it('lists the vault images a note links to once each', () => {
		const markdown = `![](attachments/${id}/1.png) ![](https://cdn.example/a.png) ![](attachments/${id}/1.png) ![](../Other/b.jpg) ![](notes.md)`;
		expect(linkedVaultImages(markdown, 'Reading/Note.md')).toEqual([`Reading/attachments/${id}/1.png`, 'Other/b.jpg']);
	});

	it('recognizes only files inside an article image folder', () => {
		expect(isReadingImagePath('Reading', `Reading/attachments/${id}/1.png`)).toBe(true);
		expect(isReadingImagePath('Reading', `Reading/attachments/${id}/notes.md`)).toBe(false);
		expect(isReadingImagePath('Reading', `Reading/attachments/${id}/deeper/1.png`)).toBe(false);
		expect(isReadingImagePath('Reading', 'Reading/attachments/not-an-id/1.png')).toBe(false);
		expect(isReadingImagePath('Reading', `Other/attachments/${id}/1.png`)).toBe(false);
	});
});
