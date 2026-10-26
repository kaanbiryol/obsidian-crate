import { expect, it } from 'vitest';
import { runIncrementalSync } from './incremental';
import { createIncrementalHarness } from './planner-test-harness';
import { createTransferHarness } from '../transfer/transfer-test-harness';
import { parallelDownloadAndSaveFiles } from '../transfer/download';
import { runConcurrentTasks } from '../concurrency';
import { arrayBufferToBase64 } from '../encoding';
import { sha256Hex } from '../../platform/sha256';

it('cancels without advancing the cursor when stopped between download batches', async () => {
	const content = new TextEncoder().encode('x').buffer;
	const hash = await sha256Hex(content);
	const transfer = createTransferHarness();
	let destroyed = false;
	transfer.vault.getAbstractFileByPath.mockReturnValue(null);
	transfer.adapter.exists.mockResolvedValue(false);
	transfer.adapter.stat.mockResolvedValue(null);
	transfer.adapter.readBinary.mockResolvedValue(content);
	// Stop sync while the first batch is written locally, with no request in flight.
	transfer.vault.createBinary.mockImplementation(async () => { destroyed = true; });
	transfer.api.batchDownload.mockImplementation(async (paths: string[]) => ({
		files: paths.map(path => ({ path, content: arrayBufferToBase64(content), size: 1, hash, revision: 'r1' })),
	}));
	const context = { ...transfer.context, runConcurrent: <T>(tasks: Array<() => Promise<T>>, concurrency: number) => runConcurrentTasks(tasks, concurrency, () => destroyed) };
	const changes = Array.from({ length: 250 }, (_, index) => ({
		seq: 11 + index, path: `notes/${index}.md`, action: 'put' as const, hash, size: 1, revision: 'r1', created_at: '2026-02-06T12:00:00.000Z',
	}));
	const harness = createIncrementalHarness({ settings: { lastSeq: 10 }, lastSeq: 260, changes });
	harness.context.parallelDownloadAndSaveFiles = (requests, result, onProcessed, onFailure) =>
		parallelDownloadAndSaveFiles(context, requests, result, 2, onProcessed, onFailure);

	const result = await runIncrementalSync(harness.context, {});

	expect(result?.outcome).toBe('cancelled');
	expect(transfer.api.batchDownload.mock.calls.length).toBeLessThan(5);
	expect(result?.downloaded).toBeLessThan(250);
	expect(harness.localManifest.save).not.toHaveBeenCalled();
	expect(harness.settings.lastSeq).toBe(10);
});
