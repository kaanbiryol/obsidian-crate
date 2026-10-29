import type { FileEntry } from '../../protocol/sync-types';
import type { SyncApiClient } from '../worker-api/client';

/** The server no longer keeps the exact saved version of a file. */
export class HistoryVersionUnavailableError extends Error {
	constructor(readonly path: string) {
		super(`${path}: this version is no longer available. Older versions are kept for 30 days. No files were changed.`);
		this.name = 'HistoryVersionUnavailableError';
	}
}

export async function findHistorySource(api: Pick<SyncApiClient, 'listFileVersions' | 'previewFileVersion' | 'downloadFile'>, path: string, wanted: Readonly<FileEntry>, current?: FileEntry): Promise<() => Promise<ArrayBuffer>> {
	if (current?.hash === wanted.hash) return async () => (await api.downloadFile(path)).content;
	let cursor: string | undefined;
	const seen = new Set<string>();
	do {
		const page = await api.listFileVersions({ path, ...(cursor ? { cursor } : {}) });
		const version = page.versions.find(version => version.path === path && version.hash === wanted.hash);
		if (version) return () => api.previewFileVersion(version);
		if (!page.hasMore) break;
		if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('File history did not advance. Try again.');
		cursor = page.nextCursor;
		seen.add(cursor);
	} while (cursor);
	throw new HistoryVersionUnavailableError(path);
}
