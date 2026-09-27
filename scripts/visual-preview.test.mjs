import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startVisualPreview } from './visual-preview.mjs';

async function servedGallery(server) {
	const base = server.resolvedUrls.local[0];
	const response = await fetch(base);
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.ok(!html.includes('/@vite/client'), 'tests must not load the live-reload client');
	const script = html.match(/<script[^>]+src="([^"]+)"/)[1];
	const asset = await fetch(new URL(script, base));
	assert.equal(asset.status, 200);
	return asset.text();
}

test('concurrent visual previews retain their styles after rebuilds and artifact removal', { timeout: 120_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'crate-visual-preview-'));
	const stylesPath = join(directory, 'mutable-styles.css');
	const servers = [];
	try {
		await writeFile(stylesPath, '.crate-reminders-ui { --snapshot-marker: first-run; }');
		const first = await startVisualPreview({ directory: join(directory, 'first'), stylesPath });
		servers.push(first);
		const original = await servedGallery(first);
		assert.match(original, /--snapshot-marker: first-run/);
		await writeFile(stylesPath, '.crate-reminders-ui { --snapshot-marker: second-run; }');
		const second = await startVisualPreview({ directory: join(directory, 'second'), stylesPath });
		servers.push(second);
		assert.notEqual(first.resolvedUrls.local[0], second.resolvedUrls.local[0]);
		assert.match(await servedGallery(second), /--snapshot-marker: second-run/);
		assert.match(await readFile(join(directory, 'first/styles.css'), 'utf8'), /first-run/);
		await rm(stylesPath);
		await rm(join(directory, 'first/styles.css'));
		assert.equal(await servedGallery(first), original);
		await assert.rejects(startVisualPreview({ directory: join(directory, 'missing'), stylesPath }), /Run npm run build:plugin/);
	} finally {
		await Promise.all(servers.map(server => server.close()));
		await rm(directory, { recursive: true, force: true });
	}
});
