import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import type { BatchUploadFile, FileEntry } from '../../protocol/sync-types';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { computeHash } from '../hasher';
import { pendingChangeKey } from '../pending-change';
import type { ApiHttpResponse, ApiHttpTransport } from '../worker-api/http';
import { formatSyncProgress } from '../../ui/activity/progress-label';
import { createDeferred } from '../runtime/runtime-test-harness';
import type { SyncResult } from '../types';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function response(value: unknown): ApiHttpResponse {
	const text = JSON.stringify(value);
	return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}

it.each(['selected', 'full', 'incremental', 'automatic', 'force'] as const)('shares batched uploads, guarded deletes and progress in %s sync', async mode => {
	const content = new TextEncoder().encode('local edit').buffer;
	const base: FileEntry = { hash: await computeHash(new TextEncoder().encode('base').buffer), revision: 'original', size: 4, modified: new Date(1).toISOString() };
	const uploads = Array.from({ length: 10 }, (_, i) => `edit-${i}.md`);
	const deletes = Array.from({ length: 9 }, (_, i) => `old-${i}.md`);
	const remote: Record<string, FileEntry> = Object.fromEntries([...uploads, ...deletes].map(path => [path, base]));
	const uploaded = new Set<string>();
	const uploadBatches: string[][] = [], deleteBatches: string[][] = [];
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const route = new URL(request.url).pathname;
		switch (route) {
			case '/.well-known/crate': return response({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) });
			case '/sync/changes': return response({ changes: [], lastSeq: 42, hasMore: false });
			case '/sync/manifest': return response({ version: 1, files: remote, lastSeq: 42, snapshotSeq: 42, hasMore: false });
			case '/sync/metadata': {
				const { paths } = JSON.parse(request.body as string) as { paths: string[] };
				return response({ files: Object.fromEntries(paths.flatMap(path => remote[path] ? [[path, remote[path]]] : [])) });
			}
			case '/sync/batch-upload': {
				const { files } = JSON.parse(request.body as string) as { files: BatchUploadFile[] };
				uploadBatches.push(files.map(file => file.path));
				for (const file of files) {
					expect(file.expectedHash).toBe(base.hash);
					expect(file.operationId).toBeTruthy();
					uploaded.add(file.path);
					remote[file.path] = { hash: file.hash, size: file.size, revision: `uploaded-${file.path}`, modified: base.modified };
				}
				return response({ success: true, results: files.map(file => ({ path: file.path, success: true, hash: file.hash, revision: remote[file.path]!.revision })) });
			}
			case '/sync/batch-delete': {
				expect(uploaded.size).toBe(uploads.length);
				const { files } = JSON.parse(request.body as string) as { files: Array<{ path: string; expectedHash: string; expectedRevision: string }> };
				deleteBatches.push(files.map(file => file.path));
				for (const file of files) {
					expect(file.expectedHash).toBe(base.hash);
					expect(file.expectedRevision).toBe(base.revision);
					delete remote[file.path];
				}
				return response({ success: true, deleted: files.map(file => file.path) });
			}
			default: throw new Error(`Unexpected transfer route: ${route}`);
		}
	});
	const h = await createPersistentEngineHarness(transport, { automaticSync: mode === 'automatic', lastSeq: mode === 'full' ? 0 : 42, lastSync: new Date(1).toISOString() });
	for (const path of [...uploads, ...deletes]) h.localManifest.setEntry(path, base);
	await h.localManifest.save();
	for (const path of uploads) { h.disk.write(path, content); h.engine.onFileChange({ path } as never); }
	for (const path of deletes) h.engine.onFileDelete({ path } as never);
	const labels: string[] = [];
	h.engine.setStateChangeCallback(state => { if (state.work) labels.push(formatSyncProgress(null, state.work)); });
	if (mode === 'automatic') {
		const completed = createDeferred<SyncResult>();
		h.engine.setAutomaticSyncResultCallback(result => { completed.resolve(result); });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await completed.promise).toMatchObject({ success: true, uploaded: uploads.length, deleted: deletes.length });
	}
	else {
		const result = mode === 'selected'
			? await h.engine.syncSelected([...uploads, ...deletes.map(path => pendingChangeKey('delete', path))])
			: mode === 'force' ? await h.engine.forceFullSync() : await h.engine.sync();
		expect(result.success, result.errors.join('\n')).toBe(true);
		expect(result).toMatchObject({ uploaded: uploads.length, deleted: deletes.length });
	}
	expect(uploadBatches.map(batch => batch.length).sort()).toEqual([1, 3, 3, 3]);
	expect(deleteBatches.map(batch => batch.length).sort()).toEqual([1, 4, 4]);
	expect(h.engine.getPendingPaths()).toEqual([]);
	expect(h.localManifest.uploadJournal.pending()).toEqual([]);
	expect(h.localManifest.getAllPaths().sort()).toEqual([...uploads].sort());
	expect(labels).toContain('Deleting 9 of 9 files');
	expect(labels).toContain('Uploading 10 of 10 files');
});
