import { vi } from 'vitest';
import type { SyncResult } from './types';

const CONFIG_DIR = '.vault-config';
export const HIDDEN_CONFIG_PATH = `${CONFIG_DIR}/config.json`;

export function createTransferHarness() {
		const adapter = {
			readBinary: vi.fn(),
			stat: vi.fn(),
			exists: vi.fn(),
			remove: vi.fn(),
			mkdir: vi.fn(),
		writeBinary: vi.fn(),
	};
	const vault = {
		adapter,
		getAbstractFileByPath: vi.fn(),
		createFolder: vi.fn(),
		process: vi.fn(async (file: { path: string }, update: (current: string) => string) => {
			const current = await adapter.readBinary(file.path) as ArrayBuffer;
			const text = update(new TextDecoder('utf-8', { ignoreBOM: true }).decode(current));
			await vault.modifyBinary(file, new TextEncoder().encode(text).buffer);
			return text;
		}),
		modifyBinary: vi.fn(),
		createBinary: vi.fn(),
	};
	const fileManager = {
		trashFile: vi.fn(async () => {}),
	};
	const api = {
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		deleteFile: vi.fn(),
		batchUpload: vi.fn(),
		batchDownload: vi.fn(),
	};
		const localManifest = {
			getEntry: vi.fn(),
			hashMatches: vi.fn(() => false),
		setEntry: vi.fn(),
		removeEntry: vi.fn(),
	};
	const retryWithBackoff = vi.fn(async (fn: () => Promise<unknown>) => fn());
	const retryWithBackoffTyped = <T>(fn: () => Promise<T>): Promise<T> =>
		retryWithBackoff(fn as () => Promise<unknown>) as Promise<T>;
	const getModifiedIso = vi.fn(async () => '2026-02-15T00:00:00.000Z');

	return {
		adapter,
		vault,
		fileManager,
		api,
		localManifest,
		retryWithBackoff,
		getModifiedIso,
			context: {
				vault: vault as never,
				fileManager,
				api,
				localManifest,
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
				retryWithBackoff: retryWithBackoffTyped,
				getModifiedIso,
			},
		};
	}

export function emptyResult(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		merged: 0,
		deleted: 0,
		conflicts: [],
		unresolvedConflicts: [],
		resolvedRaces: [],
		settledPaths: [],
		errors: [],
		uploadedPaths: [],
		downloadedPaths: [],
		mergedPaths: [],
		deletedPaths: [],
	};
}
export function createNamedAbortError(message = 'Sync request aborted'): Error {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}
