import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';

test('prebuilt mode rejects missing or invalid assets instead of rebuilding or passing', async () => {
	const root = mkdtempSync(join(tmpdir(), 'crate-prebuilt-'));
	const cwd = process.cwd();
	const previous = process.env.CRATE_PWA_PREBUILT;
	try {
		process.chdir(root);
		process.env.CRATE_PWA_PREBUILT = '1';
		await assert.rejects(buildPwaPreviewAssets(), { code: 'ENOENT' });
		mkdirSync('.generated/cloudflare', { recursive: true });
		writeFileSync('.generated/cloudflare/pwa-client.json', '{}');
		await assert.rejects(buildPwaPreviewAssets(), /Invalid generated PWA client bundle/);
	} finally {
		process.chdir(cwd);
		if (previous === undefined) delete process.env.CRATE_PWA_PREBUILT;
		else process.env.CRATE_PWA_PREBUILT = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
