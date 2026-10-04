import { DOMParser } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withYoutubeTranscript } from './youtube-transcript';

beforeEach(() => { vi.stubGlobal('window', { DOMParser }); });
afterEach(() => { vi.unstubAllGlobals(); });

const article = { title: 'A video', author: 'Channel', markdown: '' };
const id = 'jNQXAC9IVRw';

it('extracts existing transcript DOM using bundled Defuddle and portable timestamps', async () => {
	const html = `<html><head><title>A video</title></head><body>
	<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript"><div id="segments-container">
	<ytd-transcript-segment-renderer><div class="segment-timestamp">0:02</div><div class="segment-text">This is the first sentence.</div></ytd-transcript-segment-renderer>
	<ytd-transcript-segment-renderer><div class="segment-timestamp">0:08</div><div class="segment-text">This is another sentence.</div></ytd-transcript-segment-renderer>
	</div></ytd-engagement-panel-section-list-renderer></body></html>`;
	const fetch = vi.fn(async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
	const captured = await withYoutubeTranscript(article, id, fetch);
	expect(captured.markdown).toContain('**0:02**');
	expect(captured.markdown).toContain('first sentence');
	expect(captured.markdown).not.toContain('<iframe');
	expect(captured.transcript?.source).toBe('youtube');
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps metadata after blocked, oversized, or redirected transcript responses', async () => {
	for (const response of [new Response('', { status: 403 }), Response.redirect('https://evil.example/'), new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } })]) {
		expect(await withYoutubeTranscript(article, id, async () => response)).toEqual(article);
	}
});

it('bounds a stalled transport and fences late responses', async () => {
	vi.useFakeTimers();
	try {
		let release!: (response: Response) => void;
		const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
		const work = withYoutubeTranscript(article, id, fetch);
		await vi.advanceTimersByTimeAsync(12_000);
		expect(await work).toEqual(article);
		release(new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }));
		await Promise.resolve(); expect(fetch).toHaveBeenCalledTimes(1);
	} finally { vi.useRealTimers(); }
});
