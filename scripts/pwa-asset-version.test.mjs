import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createPwaAssetVersion } from './pwa-asset-version.mjs';
import { collectServerInputs } from './server-build-inputs.mjs';

test('filesystem metadata changes neither asset versions nor collected server inputs', async () => {
	const root = mkdtempSync(join(tmpdir(), 'crate-asset-version-'));
	const write = (path, text) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	try {
		write('src/cloudflare/worker/pwa/page.ts', 'export const page = "hello";');
		write('src/cloudflare/worker/pwa/nested/.config', 'real asset');
		write('src/pwa/styles/reminders-view.scss', '.test { color: red; }');
		for (const path of ['src/cloudflare/provisioner.ts', 'src/cloudflare/deployment-recovery.ts',
			'src/cloudflare/server-delete.ts', 'scripts/build-worker.mjs', 'scripts/cloudflare-artifacts-vite-plugin.mjs']) write(path, 'export {};');
		const assets = { 'app.js': 'app' };
		const baselineInputs = new Set();
		const baseline = createPwaAssetVersion(assets, root, path => baselineInputs.add(path));
		for (const file of ['.DS_Store', 'nested/.DS_Store', '._page.ts', 'nested/Thumbs.db', 'nested/desktop.ini']) {
			write(`src/cloudflare/worker/pwa/${file}`, 'machine-specific metadata');
		}
		const actualInputs = new Set();
		assert.equal(createPwaAssetVersion(assets, root, path => actualInputs.add(path)), baseline);
		assert.deepEqual(actualInputs, baselineInputs);
		assert.ok([...actualInputs].some(path => relative(root, path).endsWith('nested/.config')));
		assert.deepEqual(await collectServerInputs(root, [], actualInputs), await collectServerInputs(root, [], baselineInputs));
		write('src/cloudflare/worker/pwa/nested/.DS_Store', 'changed metadata');
		assert.equal(createPwaAssetVersion(assets, root), baseline);
		write('src/cloudflare/worker/pwa/page.ts', 'export const page = "changed";');
		assert.notEqual(createPwaAssetVersion(assets, root), baseline, 'real source changes must invalidate the version');
		write('src/cloudflare/worker/pwa/page.ts', 'export const page = "hello";');
		write('src/pwa/styles/reminders-view.scss', '.test { color: blue; }');
		assert.notEqual(createPwaAssetVersion(assets, root), baseline, 'stylesheet changes must invalidate the version');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
