import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import type { FileEntry } from '../protocol/sync-types';
import { SyncApiClient } from './api';
import type { ApiHttpTransport } from './worker-api/http';

const paths = ['__proto__', 'constructor', 'toString'];
const entry: FileEntry = { hash: 'a'.repeat(64), size: 1, modified: 'now', revision: 'r1' };
const noChanges = { changes: [], lastSeq: 3, hasMore: false };

function clientWithResponses(...responses: Response[]) {
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const response = request.url.endsWith('/.well-known/crate')
			? Response.json({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [] })
			: responses.shift();
		if (!response) throw new Error(`Unexpected request ${request.url}`);
		const arrayBuffer = await response.arrayBuffer();
		return { status: response.status, headers: {}, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
	});
	return { client: new SyncApiClient('https://worker.test', 'token', transport), transport };
}

beforeEach(() => { vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('literal path names in sync API records', () => {
	it('merges paginated manifests and changelog puts/deletes without losing prototype names', async () => {
		const { client, transport } = clientWithResponses(
			Response.json({ version: 1, files: { ['__proto__']: entry }, lastSeq: 3, snapshotSeq: 3, hasMore: true, nextCursor: '__proto__' }),
			Response.json({ version: 1, files: { constructor: entry, toString: entry }, lastSeq: 3, hasMore: false }),
			Response.json({ changes: [
				{ seq: 4, path: '__proto__', action: 'put', hash: 'new-hash', size: 2, created_at: 'later', revision: 'r2' },
				{ seq: 5, path: 'constructor', action: 'delete', hash: entry.hash, size: 1, created_at: 'later' },
			], lastSeq: 5, hasMore: false }),
		);
		const manifest = await client.getManifest();
		expect(Object.keys(manifest.files)).toEqual(['__proto__', 'toString']);
		expect(manifest.files.__proto__).toEqual({ hash: 'new-hash', size: 2, modified: 'later', revision: 'r2' });
		expect(manifest.files[paths[2]!]).toEqual(entry);
		expect(manifest.files.constructor).toBeUndefined();
		expect(manifest.lastSeq).toBe(5);
		expect(new URL(transport.mock.calls[1]![0].url).searchParams.get('after')).toBe('__proto__');
	});

	it('merges metadata batches using literal names and leaves missing names absent', async () => {
		const { client } = clientWithResponses(Response.json({ files: { ['__proto__']: entry, toString: entry } }));
		const metadata = await client.getFileMetadata(paths);
		expect(Object.keys(metadata.files)).toEqual(['__proto__', 'toString']);
		expect(metadata.files.__proto__).toEqual(entry);
		expect(metadata.files.constructor).toBeUndefined();
	});

	it('preserves names when an older server falls back from metadata to a manifest', async () => {
		const { client } = clientWithResponses(
			Response.json({ error: 'Not found' }, { status: 404 }),
			Response.json({ version: 1, files: { ['__proto__']: entry }, lastSeq: 3 }),
			Response.json(noChanges),
		);
		const metadata = await client.getFileMetadata(paths);
		expect(Object.keys(metadata.files)).toEqual(['__proto__']);
		expect(metadata.files.__proto__).toEqual(entry);
		expect(metadata.files.constructor).toBeUndefined();
		expect(metadata.files[paths[2]!]).toBeUndefined();
	});

	it.each(paths)('requires explicit delete preconditions for %s', async path => {
		const { client, transport } = clientWithResponses();
		await expect(client.batchDelete([path])).rejects.toThrow('Missing expected remote hash');
		await expect(client.batchDelete([path], { [path]: entry.hash })).rejects.toThrow('Missing remote revision');
		expect(transport).not.toHaveBeenCalled();
	});

	it('sends literal delete preconditions for supported filenames', async () => {
		const { client, transport } = clientWithResponses(Response.json({ success: true, deleted: paths }));
		await client.batchDelete(
			paths,
			Object.fromEntries(paths.map(path => [path, entry.hash])),
			Object.fromEntries(paths.map(path => [path, entry.revision!])),
		);
		const request = transport.mock.calls.find(([request]) => request.url.endsWith('/sync/batch-delete'))![0];
		expect(JSON.parse(request.body as string)).toEqual({
			files: paths.map(path => ({ path, expectedHash: entry.hash, expectedRevision: entry.revision })),
		});
	});
});
