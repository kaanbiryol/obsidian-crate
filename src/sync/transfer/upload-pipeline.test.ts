import { describe, expect, it, vi } from 'vitest';
import { createEmptySyncResult } from '../sync-result';
import type { PreparedUpload } from '../types';
import type { UploadPreparedFilesOptions } from './upload';
import { uploadPipelined } from './upload-pipeline';

const prepared = (path: string): PreparedUpload => ({ path, content: new ArrayBuffer(1), size: 1, hash: 'hash' });

describe('upload pipeline', () => {
	it('reports files the transfer left unreported once its chunk finishes', async () => {
		const events: string[] = [];
		const uploadPreparedFiles = vi.fn(async (files: PreparedUpload[], _result: unknown, options: UploadPreparedFilesOptions) => {
			// Cancellation can stop the executor before it reports every file.
			options.onProcessed?.(1);
			events.push(`upload:${files.length}`);
		});
		await uploadPipelined({ uploadPreparedFiles }, ['a.md', 'b.md', 'c.md', 'skipped.md'], createEmptySyncResult(), {
			prepare: async path => path === 'skipped.md' ? null : prepared(path),
			retry: true,
			concurrency: 3,
			beforeChunk: chunk => events.push(`before:${chunk.length}`),
			onProcessed: count => events.push(`processed:${count}`),
			afterChunk: unreported => events.push(`after:${unreported}`),
		});
		expect(events).toEqual(['before:3', 'processed:1', 'upload:3', 'after:2']);
		expect(uploadPreparedFiles).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), expect.objectContaining({ retry: true, concurrency: 3 }));
	});

	it('passes only the policies a mode supplies to the shared executor', async () => {
		const onFailure = vi.fn();
		const onVersionConflicts = vi.fn(async () => {});
		const uploadPreparedFiles = vi.fn(async (_files: PreparedUpload[], _result: unknown, _options: UploadPreparedFilesOptions) => {});
		await uploadPipelined({ uploadPreparedFiles }, ['a.md'], createEmptySyncResult(), { prepare: async path => prepared(path), retry: false });
		await uploadPipelined({ uploadPreparedFiles }, ['a.md'], createEmptySyncResult(), { prepare: async path => prepared(path), retry: false, onFailure, onVersionConflicts });
		expect(Object.keys(uploadPreparedFiles.mock.calls[0]![2]).sort()).toEqual(['onProcessed', 'retry']);
		expect(uploadPreparedFiles.mock.calls[1]![2]).toMatchObject({ retry: false, onFailure, onVersionConflicts });
	});
});
