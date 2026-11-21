/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { meterD1Usage } from '../d1/d1-usage';
import { handleEncryptionMetadata } from './metadata';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { sealFile } from '../../../encryption/file-codec';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(reset);

const FILES = 50_000;

it('reads about two rows per revision at 50,000 files', { timeout: 120_000 }, async () => {
	const { keys } = await createEncryptionFixture('active');
	const descriptor = JSON.stringify((await sealFile({ path: 'n/1.md', content: new Uint8Array([1]) }, keys.forPath('n/1.md'))).descriptor);
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, hash, size, storage_key, descriptor)
    SELECT 'n/' || x || '.md', 'n/' || x || '.md', 'hash', 1, '__crate__/files/live-' || x, ? FROM n`).bind(FILES, descriptor).run();
	await env.DB.prepare(`INSERT INTO changelog(seq, path, action, hash, size, revision, descriptor) SELECT CAST(substr(path, 3) AS INTEGER), path, 'put', hash, size, storage_key, descriptor FROM files`).run();
	await env.DB.prepare(`INSERT INTO file_versions(storage_key, path, hash, size, reason, descriptor, kept_at)
    SELECT '__crate__/files/old-' || CAST(substr(path, 3) AS INTEGER), path, hash, size, 'replaced', descriptor, 9999999999999 FROM files WHERE CAST(substr(path, 3) AS INTEGER) <= 500`).run();
	const lookup = async (files: Array<{ path: string; revision: string }>) => {
		const meter = meterD1Usage(env.DB);
		const response = await handleEncryptionMetadata(new Request('https://test/encryption/metadata', { method: 'POST', body: JSON.stringify({ files }) }), meter.db);
		const { descriptors } = await response.json() as { descriptors: Record<string, unknown> };
		expect(Object.keys(descriptors).sort()).toEqual(files.map(file => file.revision).sort());
		expect(meter.usage.queries).toBe(1);
		return meter.usage.rowsRead;
	};
	// A checkpoint of live files. Before: 106,202 rows, a scan of `files` and of `changelog`.
	const live = await lookup(Array.from({ length: 1000 }, (_, i) => ({ path: `n/${i * 50 + 1}.md`, revision: `__crate__/files/live-${i * 50 + 1}` })));
	// Half retained copies, which are also looked up by path in `files` first.
	const mixed = await lookup(Array.from({ length: 1000 }, (_, i) => i < 500
		? { path: `n/${i * 90 + 1}.md`, revision: `__crate__/files/live-${i * 90 + 1}` }
		: { path: `n/${i - 499}.md`, revision: `__crate__/files/old-${i - 499}` }));
	console.info('/encryption/metadata rows read for 1,000 revisions, live and mixed:', live, mixed);
	expect(live).toBeLessThanOrEqual(2_100);
	expect(mixed).toBeLessThanOrEqual(2_600);
});
