import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createPwaAssetVersion } from './pwa-asset-version.mjs';
import { collectServerInputs } from './server-build-inputs.mjs';
import { bundleServiceWorkerRuntime } from './service-worker-build.mjs';

test('filesystem metadata, tests and declarations change neither asset versions nor collected server inputs', async () => {
	const root = mkdtempSync(join(tmpdir(), 'crate-asset-version-'));
	const write = (path, text) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	try {
		write('src/cloudflare/worker/pwa/page.ts', 'export const page = "hello";');
		write('src/cloudflare/worker/pwa/nested/.config', 'real asset');
		write('src/cloudflare/worker/pwa/styles.ts', [
			"import reminders from '../../../pwa/styles/reminders-view.scss?raw-css';",
			"import switcher from '../../../pwa/styles/feature-switcher.scss?raw-css';",
		].join('\n'));
		write('src/pwa/styles/reminders-view.scss', '.test { color: red; }');
		write('src/pwa/styles/feature-switcher.scss', '.switcher { opacity: 1; }');
		for (const path of ['src/cloudflare/deployment/provisioner.ts', 'src/cloudflare/deployment/recovery.ts',
			'src/cloudflare/server-reset/delete.ts', 'scripts/build-worker.mjs', 'scripts/cloudflare-artifacts-vite-plugin.mjs']) write(path, 'export {};');
		const assets = { 'app.js': 'app' };
		const baselineInputs = new Set();
		const baseline = createPwaAssetVersion(assets, root, path => baselineInputs.add(path));
		for (const file of ['.DS_Store', 'nested/.DS_Store', '._page.ts', 'nested/Thumbs.db', 'nested/desktop.ini',
			'page.test.ts', 'nested/assets.d.ts']) {
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
		write('src/pwa/styles/reminders-view.scss', '.test { color: red; }');
		write('src/pwa/styles/feature-switcher.scss', '.switcher { opacity: .5; }');
		assert.notEqual(createPwaAssetVersion(assets, root), baseline, 'mode transition styles must invalidate the version');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('transitive service-worker runtime edits change the shell version and remain server inputs', async () => {
	const root = mkdtempSync(join(tmpdir(), 'crate-service-worker-version-'));
	const write = (path, text) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	try {
		write('src/cloudflare/worker/pwa/styles.ts', 'export {};');
		write('src/pwa/service-worker/tsconfig.json', '{}');
		write('src/pwa/service-worker/runtime.ts', "import { behavior } from './behavior'; export function initialize(scope) { scope.behavior = behavior; }");
		write('src/pwa/service-worker/behavior.ts', 'export const behavior = "before";');
		for (const path of ['src/cloudflare/deployment/provisioner.ts', 'src/cloudflare/deployment/recovery.ts',
			'src/cloudflare/server-reset/delete.ts', 'scripts/build-worker.mjs', 'scripts/cloudflare-artifacts-vite-plugin.mjs']) write(path, 'export {};');
		const before = await bundleServiceWorkerRuntime(root);
		const version = script => createPwaAssetVersion({ 'app.js': 'unchanged client', 'service-worker-runtime.js': script }, root);
		const baseline = version(before.script);
		const repeated = await bundleServiceWorkerRuntime(root);
		assert.equal(version(repeated.script), baseline);
		write('src/pwa/service-worker/behavior.ts', 'export const behavior = "after";');
		const after = await bundleServiceWorkerRuntime(root);
		assert.notEqual(version(after.script), baseline, 'runtime-only changes must invalidate the installed shell');
		const inputs = await collectServerInputs(root, [after.metafile], new Set());
		assert.ok(inputs.includes('src/pwa/service-worker/runtime.ts'));
		assert.ok(inputs.includes('src/pwa/service-worker/behavior.ts'));
		assert.ok(inputs.includes('src/pwa/service-worker/tsconfig.json'));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
