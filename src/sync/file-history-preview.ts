import { computeHash } from './hasher';
import type { FileEntry } from '../protocol/sync-types';
import type { DataAdapter } from 'obsidian';
import type { RemoteFileVersion } from '../protocol/sync-types';
import type { SyncApiClient } from './api';
import { assertLocalSyncPath } from './local-path-safety';
import { decodePreviewText, isBinaryPreviewPath, MAX_PREVIEW_BYTES } from './preview-format';

export interface FileHistoryPreview {
	saved?: string;
	current?: string;
	localMissing?: boolean;
	unavailable?: string;
	comparisonUnavailable?: string;
}

export async function loadFileHistoryPreview(
	adapter: Pick<DataAdapter, 'stat' | 'readBinary'>,
	api: Pick<SyncApiClient, 'previewFileVersion'>,
	version: RemoteFileVersion,
): Promise<FileHistoryPreview> {
	assertLocalSyncPath(version.path);
	if (isBinaryPreviewPath(version.path)) return { unavailable: 'Text previews are not available for this file type. You can still restore it.' };
	if (version.size > MAX_PREVIEW_BYTES) return { unavailable: 'This version is too large to preview (limit: 256 KB). You can still restore it.' };
	const bytes = await api.previewFileVersion(version);
	if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error('This version is too large to preview.');
	let saved: string;
	try { saved = decodePreviewText(bytes, { preserveBom: false }); }
	catch { return { unavailable: 'This version is not valid UTF-8 text. You can still restore it.' }; }
	try {
		const local = await adapter.stat(version.path);
		if (!local) return { saved, current: '', localMissing: true };
		if (local.type !== 'file' || local.size > MAX_PREVIEW_BYTES) return { saved, comparisonUnavailable: 'The current local file cannot be compared (limit: 256 KB).' };
		const current = await adapter.readBinary(version.path);
		if (current.byteLength > MAX_PREVIEW_BYTES) return { saved, comparisonUnavailable: 'The current local file is too large to compare.' };
		return { saved, current: decodePreviewText(current, { preserveBom: false }) };
	} catch { return { saved, comparisonUnavailable: 'The current local file could not be read as text. Reload the preview to try again.' }; }
}

export interface CurrentSyncedPreview {
	file: FileEntry;
	text?: string;
	unavailable?: string;
}

/** Current remote contents, never the local adapter's possibly unsynced copy. */
export async function loadCurrentSyncedPreview(
	api: Pick<SyncApiClient, 'getFileMetadata' | 'downloadFile'>,
	path: string,
): Promise<CurrentSyncedPreview> {
	assertLocalSyncPath(path);
	const file = (await api.getFileMetadata([path])).files[path];
	if (!file) throw new Error('This file is no longer on the server. Refresh the file list or find it in history.');
	if (isBinaryPreviewPath(path)) return { file, unavailable: 'Text previews are not available for this file type.' };
	if (file.size > MAX_PREVIEW_BYTES) return { file, unavailable: 'This file is too large to preview (limit: 256 KB).' };
	const downloaded = await api.downloadFile(path);
	if (downloaded.hash !== file.hash || downloaded.revision !== file.revision || downloaded.content.byteLength !== file.size
		|| await computeHash(downloaded.content) !== file.hash) {
		throw new Error('The synced file changed while loading. Reload its preview to see the latest version.');
	}
	try { return { file, text: decodePreviewText(downloaded.content, { preserveBom: false }) }; }
	catch { return { file, unavailable: 'This file is not valid UTF-8 text.' }; }
}
