/**
 * Frozen Worker read responses (`/sync/manifest`, `/sync/changes`, `/sync/check`,
 * `/sync/metadata`) as a protocol 1 server returns them. Released servers keep
 * sending these bodies, so the plugin must keep accepting them.
 *
 * Fixtures in `__fixtures__/` are append-only. To freeze a new version, append an
 * entry below with a new file name (for example `manifest-page.v2.json`), then run
 * `CRATE_WRITE_FIXTURES=manifest-page.v2.json npx vitest run src/sync/worker-api/read-contracts.fixtures.test.ts`.
 * Only the missing file is written; review and commit it. Never edit or
 * regenerate an existing fixture. See `src/test/frozen-fixtures.ts`.
 */
import { describe } from 'vitest';
import { testFrozenFixtures } from '@/test/frozen-fixtures';
import { parseChanges, parseChangesCheck, parseFileMetadata, parseManifestPage } from './read-contracts';

// Recorded from the Worker against local D1/R2, then made synthetic.
const helloHash = '19db98e2e4daf5be76805c1e5d07db93971336101597c94b4ebe096437f0a0ff';
const batchHash = '320b5d80f8cfd184c57473d7081003135e0001480dac18583a0bdc748b361b88';
const hello = { hash: helloHash, size: 21, modified: '2026-10-31 16:57:20', revision: `__crate__/files/${helloHash}/1c2b32ec-2d0c-4fab-b3e5-f6a9668c7de7` };
const batch = { hash: batchHash, size: 5, modified: '2026-10-31 16:57:20', revision: `__crate__/files/${batchHash}/b6ff103f-e739-4ff8-bbd4-e93fd2fbc11f` };
const withPaths = <T extends { files: object }>(value: T) => ({ ...value, paths: Object.keys(value.files) });

describe('frozen Worker read responses', () => {
	testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
		{
			file: 'manifest-page.v1.json',
			stored: () => ({ version: 1, files: { 'b.md': batch, 'Notes/hello.md': hello }, lastSeq: 2, snapshotSeq: 2, hasMore: false }),
			decode: (stored: unknown) => withPaths(parseManifestPage(stored)),
		},
		{
			// A non-final page: the cursor names its last path, here a prototype-like name.
			file: 'manifest-page-continued.v1.json',
			stored: () => ({ version: 1, files: { 'Notes/hello.md': hello, ['__proto__']: batch }, lastSeq: 9, snapshotSeq: 7, hasMore: true, nextCursor: '__proto__' }),
			decode: (stored: unknown) => withPaths(parseManifestPage(stored)),
		},
		{
			file: 'changes.v1.json',
			stored: () => ({ since: 0, response: { changes: [
				{ seq: 1, path: 'Notes/hello.md', action: 'put', hash: helloHash, size: 21, revision: hello.revision, created_at: '2026-10-31 16:57:20' },
				{ seq: 2, path: 'b.md', action: 'put', hash: batchHash, size: 5, revision: batch.revision, created_at: '2026-10-31 16:57:20' },
				{ seq: 3, path: 'b.md', action: 'delete', hash: '', size: 0, revision: 'deleted/0d2f3c4e-1111-4111-8111-111111111111', created_at: '2026-10-31 16:58:00' },
			], lastSeq: 3, hasMore: false } }),
			decode: (stored: { since: number; response: unknown }) => parseChanges(stored.response, stored.since),
		},
		{
			// A cursor older than the retained changelog asks for a full manifest reload.
			file: 'changes-expired.v1.json',
			stored: () => ({ since: 5, response: { changes: [], lastSeq: 120, hasMore: false, cursorExpired: true } }),
			decode: (stored: { since: number; response: unknown }) => parseChanges(stored.response, stored.since),
		},
		{
			file: 'changes-check.v1.json',
			stored: () => ({ since: 0, response: { lastSeq: 2, hasChanges: true } }),
			decode: (stored: { since: number; response: unknown }) => parseChangesCheck(stored.response, stored.since),
		},
		{
			// Requested paths that do not exist are omitted rather than reported.
			file: 'file-metadata.v1.json',
			stored: () => ({ requested: ['b.md', 'missing.md'], response: { files: { 'b.md': batch } } }),
			decode: (stored: { requested: string[]; response: unknown }) => withPaths(parseFileMetadata(stored.response, stored.requested)),
		},
	]);
});
