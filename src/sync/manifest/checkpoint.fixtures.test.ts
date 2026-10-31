/**
 * Frozen local sync checkpoints (`file-manifest.json`) as released plugins wrote
 * them. A device that upgrades must read its existing checkpoint and keep its
 * exact bytes when saving it back unchanged.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an
 * entry below with a new file name (for example `checkpoint.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=checkpoint.v2.json npx vitest run src/sync/manifest/checkpoint.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or
 * regenerate an existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { describe } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { encodeCheckpoint, parseCheckpoint, type ManifestCheckpoint } from './manifest-checkpoint';

const hash = (digit: string) => digit.repeat(64);
const operation = (suffix: string) => `e1_00020757_${suffix}-1111-4111-8111-111111111111`;
const decode = (bytes: string) => {
	const checkpoint = parseCheckpoint(JSON.parse(bytes));
	return { ...checkpoint, paths: Object.keys(checkpoint.manifest.files), renames: [...checkpoint.renames] };
};
const canonical = (bytes: string) => encodeCheckpoint(parseCheckpoint(JSON.parse(bytes)));

function complete(): ManifestCheckpoint {
	return {
		// Field order matches what LocalManifest holds after loading or creating each value.
		manifest: { version: 1, files: Object.fromEntries([
			['Notes/hello.md', { hash: hash('a'), size: 21, modified: '2026-10-31 16:57:20', revision: `__crate__/files/${hash('a')}/fixture-a` }],
			['__proto__', { hash: hash('b'), size: 4, modified: '2026-10-30T08:00:00.000Z', revision: 'fixture-b' }],
			['Notes/renamed.md', { hash: hash('c'), size: 9, modified: 'unverified' }],
			['aaaaaaaaaaaaaaaaaaaaaaaaaa.md', { hash: hash('e'), size: 300, modified: '2026-10-29', revision: 'fixture-e', wire: 'bbbbbbbbbbbbbbbbbbbbbbbbbb.md' }],
		]), lastSeq: 42 },
		generation: 7,
		authority: 'https://crate.example.test',
		settledUploads: [operation('22222222'), operation('11111111')],
		renames: new Map([['Notes/old.md', 'Notes/renamed.md']]),
		uploadDiagnostics: [{
			at: '2026-10-31T16:57:20.000Z', clientSession: '33333333-3333-4333-8333-333333333333',
			operationId: operation('11111111'), kind: 'merge', phase: 'checkpointed', generation: 7,
			pathHash: hash('1'), uploadHash: hash('2'), baseHash: hash('3'), appliedHash: hash('4'),
		}],
		restoreIntents: [{
			version: { path: 'Notes/hello.md', storage_key: 'retained/fixture-version', hash: hash('f'), size: 12, expires_at: 1_793_000_000_000, created_at: '2026-10-01T00:00:00Z', reason: 'replaced' },
			phase: 'pending',
			request: { operationId: operation('44444444'), path: 'Notes/hello.md', storageKey: 'retained/fixture-version', expectedHash: hash('a'), expectedRevision: `__crate__/files/${hash('a')}/fixture-a` },
		}],
		initialConfigPull: { configDir: '.obsidian', files: { '.obsidian/app.json': hash('5') } },
		initialImportToken: '55555555-5555-4555-8555-555555555555',
	};
}

describe('frozen local sync checkpoints', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{
			// What a fresh device saves before its first sync completes.
			file: 'checkpoint-minimal.v1.json',
			stored: () => encodeCheckpoint({ manifest: { version: 1, files: {} }, generation: 1, authority: 'https://crate.example.test',
				settledUploads: [], renames: new Map(), uploadDiagnostics: [], restoreIntents: [], initialConfigPull: undefined, initialImportToken: undefined }),
			decode, canonical,
		},
		{
			// Every optional recovery field, unverified local metadata and an encrypted server path.
			file: 'checkpoint-complete.v1.json',
			stored: () => encodeCheckpoint(complete()),
			decode, canonical,
		},
	]);
});
