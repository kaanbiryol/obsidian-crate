import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGeneratedPwaClient } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

test('rejects missing or invalid generated assets instead of serving them', async () => {
	const root = mkdtempSync(join(tmpdir(), 'crate-prebuilt-'));
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await assert.rejects(readGeneratedPwaClient(), { code: 'ENOENT' });
		mkdirSync('.generated/cloudflare', { recursive: true });
		writeFileSync('.generated/cloudflare/pwa-client.json', '{}');
		await assert.rejects(readGeneratedPwaClient(), /Invalid generated PWA client bundle/);
	} finally {
		process.chdir(cwd);
		rmSync(root, { recursive: true, force: true });
	}
});

test('a preview server on an ephemeral port reports and resolves requests against its bound origin', async () => {
	const assets = { createManifestJson: url => JSON.stringify({ url }) };
	const { server, origin } = await listenPwaPreviewServer({ port: 0, assets });
	try {
		assert.notEqual(server.address().port, 0);
		assert.equal(origin, `http://127.0.0.1:${server.address().port}`);
		const manifest = await (await fetch(`${origin}/notifications/manifest.json?v=1`)).json();
		assert.equal(manifest.url, `${origin}/notifications/manifest.json?v=1`);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});
