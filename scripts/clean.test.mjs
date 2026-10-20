import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { clean, cleanTargets } from './clean.mjs';

async function repository(t, ignore = 'dist\n.generated\nplaywright-report/\ntest-results/\n') {
	const root = await mkdtemp(join(tmpdir(), 'crate-clean-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	await write(root, '.gitignore', ignore);
	return root;
}
const write = async (root, path, text = 'x') => { await mkdir(join(root, dirname(path)), { recursive: true }); await writeFile(join(root, path), text); };
const exists = (root, path) => stat(join(root, path)).then(() => true, () => false);

test('removes ignored build and test output, including old visual runs, and keeps everything else', async t => {
	const root = await repository(t);
	for (const path of ['dist/main.js', '.generated/visual-runs/old/gallery/index.html', 'playwright-report/visual-old/index.html',
		'test-results/visual-old/trace.zip', 'test-results/reading/a.png', '.generated/cloudflare/worker.mjs', 'src/main.ts']) await write(root, path);
	assert.deepEqual(await clean(root), cleanTargets);
	for (const path of ['dist', '.generated/visual-runs', 'playwright-report', 'test-results']) assert.equal(await exists(root, path), false, path);
	assert.equal(await readFile(join(root, 'src/main.ts'), 'utf8'), 'x');
	assert.equal(await exists(root, '.generated/cloudflare/worker.mjs'), true);
	assert.deepEqual(await clean(root), []);
});

test('refuses to remove a target that Git does not ignore or that holds tracked files', async t => {
	const unignored = await repository(t, 'dist\n');
	await write(unignored, 'test-results/result.json');
	await assert.rejects(clean(unignored), /Refusing to remove test-results/);
	assert.equal(await exists(unignored, 'test-results/result.json'), true);

	const tracked = await repository(t);
	await write(tracked, 'playwright-report/index.html');
	execFileSync('git', ['add', '--force', 'playwright-report/index.html'], { cwd: tracked });
	await assert.rejects(clean(tracked), /Refusing to remove playwright-report/);
	assert.equal(await exists(tracked, 'playwright-report/index.html'), true);
});
