import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { staleWorkerBuild } from './worker-build-freshness.mjs';

/** A build made at `builtAt` (seconds) of one input written at `editedAt`. */
function fixture({ builtAt = 2000, editedAt = 1000, development = null } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'crate-worker-freshness-'));
	const generated = join(root, '.generated/cloudflare');
	mkdirSync(generated, { recursive: true });
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src/index.ts'), 'export {};');
	utimesSync(join(root, 'src/index.ts'), editedAt, editedAt);
	writeFileSync(join(generated, 'server-inputs.json'), JSON.stringify(['src/index.ts']));
	writeFileSync(join(generated, 'build-identity.json'), JSON.stringify({ development }));
	for (const name of ['worker.mjs', 'worker-self-hosted.mjs', 'pwa-client.json', 'build-identity.json']) {
		if (name !== 'build-identity.json') writeFileSync(join(generated, name), '');
		utimesSync(join(generated, name), builtAt, builtAt);
	}
	return root;
}

test('accepts a build newer than every input', () => {
	const root = fixture();
	try { assert.equal(staleWorkerBuild(root), null); } finally { rmSync(root, { recursive: true }); }
});

test('names an input edited after the build, a development build and a missing build', () => {
	for (const [options, expected] of [[{ editedAt: 3000 }, /src\/index\.ts/], [{ development: { id: 'dev' } }, /development/]]) {
		const root = fixture(options);
		try { assert.match(staleWorkerBuild(root) ?? '', expected); } finally { rmSync(root, { recursive: true }); }
	}
	const empty = mkdtempSync(join(tmpdir(), 'crate-worker-freshness-'));
	try { assert.match(staleWorkerBuild(empty) ?? '', /no completed Worker build/); } finally { rmSync(empty, { recursive: true }); }
});
