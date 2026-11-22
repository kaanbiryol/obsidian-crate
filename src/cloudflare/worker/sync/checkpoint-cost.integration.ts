/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { meterD1Usage } from '../d1/d1-usage';
import { checkpointStatement } from './file-publication-statements';
import { checkpointId, getSharedCheckpoint } from './history-checkpoints';
import { parseSharedCheckpointDocument } from '../../../protocol/history-checkpoints';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(reset);

const FILES = 10_000;

it('saves a checkpoint in a few rows and rebuilds it from the files and only the versions kept since', { timeout: 120_000 }, async () => {
	// 10,000 files, 5,000 versions kept before the checkpoint and 300 replaced after it.
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
		INSERT INTO files(path, portable_path, hash, size, storage_key, live_from_seq)
		SELECT 'n/' || x || '.md', 'n/' || x || '.md', ?, 1, '__crate__/files/live-' || x, CASE WHEN x <= 300 THEN 20 ELSE 1 END FROM n`).bind(FILES, 'a'.repeat(64)).run();
	await env.DB.prepare(`INSERT INTO changelog(seq, path, action, hash, size) VALUES (10, 'n/1.md', 'put', '', 1)`).run();
	await env.DB.prepare('INSERT INTO server_state (id, file_count) VALUES (1, ?)').bind(FILES).run();
	await env.DB.prepare(`INSERT INTO file_versions(storage_key, path, hash, size, reason, kept_at, live_from_seq, live_until_seq)
		SELECT '__crate__/files/older-' || substr(path, 3), path, ?, 1, 'replaced', 1000, 0, 1 FROM files WHERE CAST(substr(path, 3, length(path) - 5) AS INTEGER) <= 5000`).bind('b'.repeat(64)).run();
	const meter = meterD1Usage(env.DB);
	await checkpointStatement(meter.db).run();
	console.info('rows read to save a checkpoint of 10,000 files:', meter.usage.rowsRead);
	expect(meter.usage.rowsRead).toBeLessThanOrEqual(12);
	const created = await env.DB.prepare('SELECT seq, created_at FROM history_checkpoints').first<{ seq: number; created_at: number }>();
	expect(created!.seq).toBe(10);
	await env.DB.prepare(`INSERT INTO file_versions(storage_key, path, hash, size, reason, kept_at, live_from_seq, live_until_seq)
		SELECT '__crate__/files/saved-' || substr(path, 3), path, ?, 1, 'replaced', ?, 1, 20 FROM files WHERE live_from_seq = 20`).bind('c'.repeat(64), created!.created_at + 1000).run();

	const rebuild = meterD1Usage(env.DB);
	const response = await getSharedCheckpoint(new Request(`https://test/sync/checkpoint?id=${checkpointId(10)}`), rebuild.db);
	const document = parseSharedCheckpointDocument(await response.json());
	expect(document.checkpoint.fileCount).toBe(FILES);
	expect(document.files['n/7.md']).toMatchObject({ hash: 'c'.repeat(64) });
	expect(document.files['n/301.md']).toMatchObject({ hash: 'a'.repeat(64) });
	console.info('rows read to rebuild it:', rebuild.usage.rowsRead);
	// Every file row and the 300 versions kept since; never the 5,000 older versions.
	expect(rebuild.usage.rowsRead).toBeLessThan(FILES + 300 + 100);
});
