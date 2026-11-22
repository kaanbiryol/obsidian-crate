import type { ChangesResponse, FileEntry } from '../../protocol/sync-types';
import { assertPortablePathNames, assertPortablePaths } from '../../protocol/portable-path';
import { createPathRecord } from '../../protocol/path-record';
import { parseChanges, parseManifestPage } from './read-contracts';
import type { WorkerApiHttpClient } from './http';

type JsonReader = Pick<WorkerApiHttpClient, 'requestJson'>;

/** Changelog entries after `since`, with the paths the server stored (wire paths in an encrypted vault). */
export async function readRawChanges(http: JsonReader, since: number): Promise<ChangesResponse> {
	const response = parseChanges(await http.requestJson<unknown>(`/sync/changes?since=${since}`), since);
	assertPortablePathNames(response.changes.map(change => change.path));
	return response;
}

/** The manifest as the server stores it, at one snapshot: every page comes from the first
 * page's snapshot, then the changelog since that snapshot is replayed, so the result matches
 * one changelog position. Any sign of an inconsistent read fails instead of returning a
 * partial manifest, because a missing entry would look like a remote delete. */
export async function readRawManifest(http: JsonReader): Promise<{ files: Record<string, FileEntry>; lastSeq: number }> {
	const files = createPathRecord<FileEntry>();
	let after: string | undefined;
	let snapshotSeq: number | undefined;
	let lastSeq = 0;
	const cursors = new Set<string>();
	while (true) {
		const params = new URLSearchParams({ limit: '2000' });
		if (after) params.set('after', after);
		if (snapshotSeq !== undefined) params.set('snapshotSeq', String(snapshotSeq));
		const page = parseManifestPage(await http.requestJson<unknown>(`/sync/manifest?${params.toString()}`));
		if (snapshotSeq !== undefined && page.snapshotSeq !== snapshotSeq) throw new Error('Remote manifest snapshot changed during pagination');
		if (Object.keys(page.files).some(path => Object.prototype.hasOwnProperty.call(files, path))) throw new Error('Remote manifest repeated a file during pagination');
		Object.assign(files, page.files);
		lastSeq = page.lastSeq ?? lastSeq;
		snapshotSeq ??= page.snapshotSeq ?? page.lastSeq ?? 0;
		if (!page.hasMore) break;
		if (!page.nextCursor || cursors.has(page.nextCursor)) {
			throw new Error('Remote manifest pagination did not advance');
		}
		after = page.nextCursor;
		cursors.add(after);
	}

	let changeCursor = snapshotSeq ?? lastSeq;
	while (true) {
		const changes = await readRawChanges(http, changeCursor);
		if (changes.cursorExpired) throw new Error('Remote manifest changed too quickly to load safely');
		for (const change of changes.changes) {
			if (change.action === 'delete') {
				delete files[change.path];
			} else {
				files[change.path] = {
					hash: change.hash,
					revision: change.revision,
					size: change.size,
					modified: change.created_at,
				};
			}
		}
		lastSeq = changes.lastSeq;
		if (!changes.hasMore || changes.changes.length === 0) break;
		changeCursor = changes.changes.at(-1)?.seq ?? changeCursor;
	}

	assertPortablePaths(Object.keys(files));
	return { files, lastSeq };
}
