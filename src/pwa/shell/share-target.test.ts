import { describe, expect, it } from 'vitest';
import { readingShareFallback, receiveReadingShare } from './share-target';

const share = (body: string, type = 'application/x-www-form-urlencoded') =>
	new Request('https://crate.example/notifications/share/reading', { method: 'POST', headers: { 'Content-Type': type }, body });

describe('reading share target', () => {
	it.each([
		['an unsupported form encoding', share('url=https://example.com', 'multipart/form-data'), 'Unsupported share format.'],
		['more than one link', share(new URLSearchParams({ text: 'https://a.example https://b.example' }).toString()), 'Share one complete web link at a time.'],
		['no link', share(new URLSearchParams({ text: 'no link here' }).toString()), 'Share one complete web link at a time.'],
		['embedded credentials', share(new URLSearchParams({ url: 'https://user:secret@example.com/' }).toString()), 'Unsupported shared link.'],
		['an oversized body', share(`text=${'a'.repeat(16385)}`), 'Share one link at a time.'],
	])('rejects %s before storing anything', async (_name, request, message) => {
		const response = await receiveReadingShare(request);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe(message);
	});

	it('keeps the fallback page script from being closed by shared text', async () => {
		const response = await readingShareFallback(share(new URLSearchParams({ url: 'https://example.com', title: '</script><script>alert(1)</script>' }).toString()));
		const html = await response.text();
		const nonce = /script-src 'nonce-([^']+)'/.exec(response.headers.get('Content-Security-Policy') ?? '')?.[1];
		expect(nonce).toBeTruthy();
		expect(html).toContain(`<script nonce="${nonce}">`);
		expect(html.match(/<\/script>/g)).toHaveLength(1);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('limits the fallback body to one link', async () => {
		expect((await readingShareFallback(share(`text=${'a'.repeat(16385)}`))).status).toBe(413);
	});
});
