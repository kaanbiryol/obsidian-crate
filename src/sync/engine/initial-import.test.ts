import { expect, it, vi } from 'vitest';
import type { VaultFile } from '../local/file-discovery';

const files: VaultFile[] = Array.from({ length: 200 }, (_, index) => ({ path: `notes/${index}.md`, size: 1, mtime: 1, extension: 'md' }));
vi.mock('../local/file-discovery', () => ({ getAllVaultFiles: vi.fn(async () => files) }));
vi.mock('../transfer/prepare', () => ({
	prepareUploadFromVaultFile: vi.fn(async (_transfer: unknown, file: VaultFile) => {
		events.push(`prepare ${file.path}`);
		return { path: file.path, content: new ArrayBuffer(1), size: 1, mtime: file.mtime, hash: `h-${file.path}` };
	}),
}));

import { ANOTHER_DEVICE_IMPORTING, runInitialImport } from './initial-import';
import { createEmptySyncResult } from '../sync-result';

const events: string[] = [];

it('prepares the next chunk of an initial import while the current one uploads', async () => {
	const upload = vi.fn(async (_token: string, batch: Array<{ path: string; hash: string }>) => {
		events.push('upload start');
		await new Promise(resolve => setTimeout(resolve, 5));
		events.push('upload end');
		return { results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) };
	});
	const result = await runInitialImport({
		transfer: {
			vault: {}, localManifest: { setEntry: vi.fn(), removeEntry: vi.fn() },
			markdownBaseCache: { putBase: async () => {} },
			encrypted: () => false,
			runConcurrent: async (tasks: Array<() => Promise<void>>) => { for (const task of tasks) await task(); },
		} as never,
		api: {
			getManifest: async () => ({ files: {} }),
			initialImport: { begin: async () => ({ state: 'importing', token: 't' }), prune: async () => {}, upload, finish: async () => 1 },
		} as never,
		shouldIgnore: () => false, throwIfDestroyed: () => {}, save: async () => {}, setLastSeq: () => {}, report: () => {},
		getImportToken: () => undefined, setImportToken: () => {},
	}, createEmptySyncResult());
	expect(result?.uploaded).toBe(200);
	// Before: no file was read while an upload was in flight.
	const start = events.indexOf('upload start');
	expect(events.slice(start, events.indexOf('upload end', start)).some(event => event.startsWith('prepare'))).toBe(true);
});

function importContext(token: string | undefined, revision: string | undefined) {
	const calls: string[] = [];
	const context = {
		transfer: {
			vault: {}, localManifest: { getEntry: () => revision ? { revision } : undefined, setEntry: vi.fn(), removeEntry: vi.fn() },
			markdownBaseCache: { putBase: async () => {} },
			encrypted: () => false,
			runConcurrent: async (tasks: Array<() => Promise<void>>) => { for (const task of tasks) await task(); },
		} as never,
		api: {
			getManifest: async () => ({ files: { 'other.md': { hash: 'a'.repeat(64), size: 1, revision: 'r1', modified: new Date(1).toISOString() } } }),
			initialImport: {
				begin: async () => ({ state: 'importing', token: 't' }),
				prune: async () => { calls.push('prune'); },
				upload: async (_token: string, batch: Array<{ path: string; hash: string }>) => {
					calls.push('upload');
					return { results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) };
				},
				finish: async () => 1,
			},
		} as never,
		shouldIgnore: () => false, throwIfDestroyed: () => {}, setLastSeq: () => {}, report: () => {},
		save: async () => { calls.push('save'); },
		getImportToken: () => token,
		setImportToken: (value: string | undefined) => { calls.push(`token ${value}`); },
	};
	return { context, calls };
}

it('stops before pruning or uploading an import another device started', async () => {
	const { context, calls } = importContext(undefined, undefined);
	await expect(runInitialImport(context, createEmptySyncResult())).rejects.toThrow(ANOTHER_DEVICE_IMPORTING);
	expect(calls).toEqual([]);
});

it.each([['holds its token', 't', undefined], ['uploaded every server file', undefined, 'r1']] as const)('resumes an import when this device %s', async (_case, token, revision) => {
	const { context, calls } = importContext(token, revision);
	expect((await runInitialImport(context, createEmptySyncResult()))?.uploaded).toBe(200);
	// 200 files stay under the periodic checkpoint, so uploads run back to back.
	expect(calls.slice(0, 5)).toEqual(token ? ['prune', 'upload', 'upload', 'upload', 'upload'] : ['token t', 'save', 'prune', 'upload', 'upload']);
	// Finishing releases the token.
	expect(calls.indexOf('token undefined')).toBeGreaterThan(calls.lastIndexOf('upload'));
});

it('records verified modification times, so the next scan does not reread the imported vault', async () => {
	const setEntry = vi.fn<(path: string, entry: { modified: string; revision?: string }) => void>();
	await runInitialImport({
		transfer: {
			vault: {}, localManifest: { setEntry, removeEntry: vi.fn() },
			markdownBaseCache: { putBase: async () => {} },
			encrypted: () => false,
			runConcurrent: async (tasks: Array<() => Promise<void>>) => { for (const task of tasks) await task(); },
		} as never,
		api: {
			// One file is already on the server with the same bytes.
			getManifest: async () => ({ files: { 'notes/0.md': { hash: 'h-notes/0.md', size: 1, revision: 'r0', modified: new Date(5).toISOString() } } }),
			initialImport: {
				begin: async () => ({ state: 'importing', token: 't' }), prune: async () => {}, finish: async () => 1,
				upload: async (_token: string, batch: Array<{ path: string; hash: string }>) => ({ results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) }),
			},
		} as never,
		shouldIgnore: () => false, throwIfDestroyed: () => {}, save: async () => {}, setLastSeq: () => {}, report: () => {},
		getImportToken: () => 't', setImportToken: () => {},
	}, createEmptySyncResult());
	expect(setEntry).toHaveBeenCalledTimes(200);
	expect(new Set(setEntry.mock.calls.map(([, entry]) => entry.modified))).toEqual(new Set([new Date(1).toISOString()]));
	expect(setEntry).toHaveBeenCalledWith('notes/0.md', expect.objectContaining({ revision: 'r0' }));
});

it('keeps three import requests busy and checkpoints every 256 confirmed files', async () => {
	const many: VaultFile[] = Array.from({ length: 600 }, (_, index) => ({ path: `many/${index}.md`, size: 1, mtime: 1, extension: 'md' }));
	const { getAllVaultFiles } = await import('../local/file-discovery');
	vi.mocked(getAllVaultFiles).mockResolvedValueOnce(many);
	const calls: string[] = [];
	let active = 0, peak = 0, confirmed = 0, requests = 0, startedBesideFirst = 0, firstPending = false;
	const result = await runInitialImport({
		transfer: {
			vault: {}, localManifest: { setEntry: vi.fn(), removeEntry: vi.fn() },
			markdownBaseCache: { putBase: async () => {} },
			encrypted: () => false,
		} as never,
		api: {
			getManifest: async () => ({ files: {} }),
			initialImport: {
				begin: async () => ({ state: 'importing', token: 't' }), prune: async () => {}, finish: async () => 1,
				upload: async (_token: string, batch: Array<{ path: string; hash: string }>) => {
					peak = Math.max(peak, ++active);
					const first = ++requests === 1;
					if (first) firstPending = true; else if (firstPending) startedBesideFirst++;
					// A slow first request must not hold back the other slots.
					await new Promise(resolve => setTimeout(resolve, first ? 30 : 1));
					if (first) firstPending = false;
					active--;
					confirmed += batch.length;
					return { results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) };
				},
			},
		} as never,
		shouldIgnore: () => false, throwIfDestroyed: () => {}, setLastSeq: () => {}, report: () => {},
		save: async () => { calls.push(`save ${confirmed}`); },
		getImportToken: () => 't', setImportToken: () => {},
	}, createEmptySyncResult());
	expect(result?.uploaded).toBe(600);
	expect(peak).toBe(3);
	// Before: a chunk waited for its slowest request, so only its two siblings ran.
	expect(startedBesideFirst).toBeGreaterThan(2);
	const periodic = calls.slice(0, -3).map(call => Number(call.split(' ')[1]));
	expect(periodic.length).toBe(2);
	expect(periodic[0]).toBeGreaterThanOrEqual(256);
	expect(periodic[1]! - periodic[0]!).toBeGreaterThanOrEqual(256);
});

it('saves the confirmed files when a later import request fails', async () => {
	const calls: string[] = [];
	let requests = 0;
	const result = createEmptySyncResult();
	await expect(runInitialImport({
		transfer: {
			vault: {}, localManifest: { setEntry: (path: string) => { calls.push(`entry ${path}`); }, removeEntry: vi.fn() },
			markdownBaseCache: { putBase: async () => {} },
			encrypted: () => false,
		} as never,
		api: {
			getManifest: async () => ({ files: {} }),
			initialImport: {
				begin: async () => ({ state: 'importing', token: 't' }), prune: async () => {}, finish: async () => 1,
				upload: async (_token: string, batch: Array<{ path: string; hash: string }>) => {
					if (++requests === 2) throw new Error('offline');
					return { results: batch.map(file => ({ path: file.path, success: true, hash: file.hash, revision: 'r' })) };
				},
			},
		} as never,
		shouldIgnore: () => false, throwIfDestroyed: () => {}, setLastSeq: () => {}, report: () => {},
		save: async () => { calls.push('save'); },
		getImportToken: () => 't', setImportToken: () => {},
	}, result)).rejects.toThrow('offline');
	expect(result.uploaded).toBeGreaterThanOrEqual(32);
	expect(calls.at(-1)).toBe('save');
	expect(calls.filter(call => call.startsWith('entry'))).toHaveLength(result.uploaded);
});
