import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('static OAuth callback page', () => {
	it('clears the OAuth query before loading the callback handler', async () => {
		const html = await readFile(resolve(root, 'site/oauth/callback/index.html'), 'utf8');
		const captureIndex = html.indexOf('window.__crateOAuthCallback = window.location.search');
		const clearIndex = html.indexOf("history.replaceState(null, '', '/oauth/callback/')");
		const handlerIndex = html.indexOf('src="/assets/callback.js?');

		expect(captureIndex).toBeGreaterThan(0);
		expect(clearIndex).toBeGreaterThan(captureIndex);
		expect(handlerIndex).toBeGreaterThan(clearIndex);
		expect(html).toContain('name="referrer" content="no-referrer"');
		expect(html).toContain('connect-src \'none\'');
		const inlineScript = html.match(/<script>([^<]+history\.replaceState[^<]+)<\/script>/)?.[1];
		if (!inlineScript) throw new Error('Missing immediate callback scrub script');
		const expectedHash = createHash('sha256').update(inlineScript).digest('base64');
		expect(html).toContain(`'sha256-${expectedHash}'`);
	});

	it('contains no analytics or third-party script and provides an Obsidian fallback', async () => {
		const [html, script] = await Promise.all([
			readFile(resolve(root, 'site/oauth/callback/index.html'), 'utf8'),
			readFile(resolve(root, 'site/assets/callback.js'), 'utf8'),
		]);
		expect(html).not.toMatch(/analytics|googletag|segment|https:\/\/.*\.js/i);
		expect(script).not.toContain('console.');
		expect(script).toContain('obsidian://crate-cloudflare-oauth');
		expect(script).toContain('window.location.replace(obsidianUrl)');
		expect(script).not.toContain('Connection incomplete');
		expect(html).not.toContain('data-callback-state-label');
		expect(html).toContain('Continue in Obsidian to finish setting up Crate.');
		expect(html).toContain('Open Obsidian');
	});
});
