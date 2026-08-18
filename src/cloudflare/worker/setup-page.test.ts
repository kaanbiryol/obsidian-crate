import { describe, expect, it } from 'vitest';
import { handleSetupClient, handleSetupPage } from './setup-page';

describe('browser setup page', () => {
	it('serves a self-contained claim page with strict browser headers', async () => {
		const response = handleSetupPage();
		const html = await response.text();

		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
		expect(html).toContain('Claim server');
		expect(html).toContain('anyone who knows its Worker URL could claim it first');
		expect(html).toContain('<script src="/setup/client.js" defer></script>');
	});

	it('keeps permanent device credentials out of the setup link', async () => {
		const response = handleSetupClient();
		const script = await response.text();

		expect(script).toContain('enrollmentToken');
		expect(script).toContain('obsidian://crate-setup');
		expect(script).not.toContain('authToken');
	});
});
