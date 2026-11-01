/// <reference types="@cloudflare/vitest-plugin/types" />
import { commitStagedFile } from './mutations';
import { commitNewFiles } from './staging/bulk-new-file-commit';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { handleBatchUpload } from './batch/upload';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import { countD1Queries } from '../d1-query-count';
import { D1_QUERIES_PER_INVOCATION } from '../platform-limits';
import { BATCH_UPLOAD_MAX_FILES } from '@/protocol/sync-limits';

beforeEach(async () => {
	await applySchema(env.DB);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const files = (extension = 'svg', count = BATCH_UPLOAD_MAX_FILES) => Array.from({ length: count }, (_, index) => ({
	path: `icons/${index}.${extension}`, content: btoa('original'), expectedHash: null as string | null,
	operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)),
}));
// Production commits each file in its own coordinator invocation, apart from staging.
let invocations = { staging: 0, commits: [] as number[] };
const send = async (payload: ReturnType<typeof files>) => {
	const staging = countD1Queries(env.DB);
	const commits: number[] = [];
	const commitUpload: typeof commitStagedFile = (bucket, _db, params) => {
		const commit = countD1Queries(env.DB);
		return commitStagedFile(bucket, commit.db, params).finally(() => commits.push(commit.count.queries));
	};
	try {
		return await handleBatchUpload(new Request('https://test/sync/batch-upload', {
			method: 'POST', body: JSON.stringify({ files: payload }),
		// Production authentication supplies both snapshots before this handler runs.
		}), env.BUCKET, staging.db, { commitUpload, commitNewFiles }, null, null);
	} finally { invocations = { staging: staging.count.queries, commits }; }
};
const expectWithinQueryBudget = () => {
	// Reserve queries for request authentication.
	expect(invocations.staging).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION - 4);
	expect(Math.max(...invocations.commits)).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION - 4);
};

it('uses one lease write and commit-returned receipts for a full asset batch', async () => {
	const payload = files();
	const prepare = vi.spyOn(env.DB, 'prepare');
	const put = vi.spyOn(env.BUCKET, 'put');
	const response = await send(payload);
	const receipts = await response.json() as BatchUploadResponse;
	expect(receipts.results).toHaveLength(payload.length);
	expect(receipts.success).toBe(true);
	expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO staged_uploads'))).toHaveLength(1);
	expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT request_hash, response_json') && !sql.includes('UNION ALL'))).toHaveLength(0);
	expect(put).toHaveBeenCalledTimes(payload.length);
	expectWithinQueryBudget();
	// One receipt read and one lease write, whatever the batch size.
	expect(invocations.staging).toBe(2);
	const repeated = await (await send(payload)).json() as BatchUploadResponse;
	expect(repeated.results.sort((a, b) => a.path.localeCompare(b.path))).toEqual(receipts.results.sort((a, b) => a.path.localeCompare(b.path)));
	expect(put).toHaveBeenCalledTimes(payload.length);
});

it('stays within the query budget on full Markdown replacement and stale batches', async () => {
	const first = await (await send(files('md'))).json() as BatchUploadResponse;
	const replacement = files('md').map(file => ({ ...file, content: btoa('new'), expectedHash: first.results.find(result => result.path === file.path)!.hash! }));
	expect((await (await send(replacement)).json() as BatchUploadResponse).success).toBe(true);
	expectWithinQueryBudget();
	const stale = await (await send(files('md'))).json() as BatchUploadResponse;
	expect(stale.results.every(result => result.code === 'version_conflict')).toBe(true);
	expectWithinQueryBudget();
});

it('rejects batches above the limit before storing objects', async () => {
	const put = vi.spyOn(env.BUCKET, 'put');
	expect((await send(files('md', BATCH_UPLOAD_MAX_FILES + 1))).status).toBe(400);
	expect((await send(files('svg', BATCH_UPLOAD_MAX_FILES + 1))).status).toBe(400);
	expect(put).not.toHaveBeenCalled();
});

it('never sends objects if shared lease registration fails', async () => {
	const prepare = env.DB.prepare.bind(env.DB);
	vi.spyOn(env.DB, 'prepare').mockImplementation(sql => {
		if (sql.startsWith('INSERT INTO staged_uploads')) throw new Error('Storage unavailable');
		return prepare(sql);
	});
	const put = vi.spyOn(env.BUCKET, 'put');
	expect((await send(files())).status).toBe(503);
	expect(put).not.toHaveBeenCalled();
});
