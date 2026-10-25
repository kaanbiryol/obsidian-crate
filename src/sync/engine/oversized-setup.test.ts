import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { INITIAL_IMPORT_CAPABILITY, type ImportInventoryEntry } from '../../protocol/initial-import';
import type { BatchUploadFile, FileEntry } from '../../protocol/sync-types';
import { OVERSIZED_LOCAL_FILE_MESSAGE } from '../issues';
import type { ApiHttpResponse, ApiHttpTransport } from '../worker-api/http';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

const BIG = 'media/big.bin';
const oversizedIssue = { path: BIG, message: OVERSIZED_LOCAL_FILE_MESSAGE, code: 'file-too-large' };

function response(value: unknown, status = 200): ApiHttpResponse {
	const text = JSON.stringify(value);
	return { status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}

/** Two small notes, one 26 MiB file, and remote rows for a removed note and an earlier, smaller copy of the large file. */
function createServer(capabilities: string[]) {
	const entry = (hash: string): FileEntry => ({ hash: hash.repeat(64), size: 1, revision: `rev-${hash}`, modified: new Date(1).toISOString() });
	const remote: Record<string, FileEntry> = { 'remote-only.md': entry('a'), [BIG]: entry('b') };
	const routes: string[] = [];
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const route = new URL(request.url).pathname;
		routes.push(route);
		const body = typeof request.body === 'string' ? JSON.parse(request.body) as Record<string, unknown> : {};
		const accept = (files: BatchUploadFile[]) => {
			for (const file of files) remote[file.path] = { hash: file.hash, size: file.size, revision: `uploaded-${file.path}`, modified: new Date(2).toISOString() };
			return response({ success: true, results: files.map(file => ({ path: file.path, success: true, hash: file.hash, revision: remote[file.path]!.revision })) });
		};
		switch (route) {
			case '/.well-known/crate': return response({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities, reminderOperationDay: Math.floor(Date.now() / 86_400_000) });
			case '/sync/manifest': return response({ version: 1, files: remote, lastSeq: 10, snapshotSeq: 10, hasMore: false });
			case '/sync/changes': return response({ changes: [], lastSeq: 10, hasMore: false });
			case '/sync/import': return response({ import: { token: 'import-1', state: 'importing' } });
			case '/sync/import/prune': {
				for (const file of body.files as Array<{ path: string }>) delete remote[file.path];
				return response({ success: true });
			}
			case '/sync/import/upload': return accept(body.files as BatchUploadFile[]);
			case '/sync/import/complete': {
				// The server proves the inventory matches its rows exactly.
				const expected: ImportInventoryEntry[] = Object.keys(remote).sort().map(path => [path, remote[path]!.hash, remote[path]!.size]);
				if (JSON.stringify(body.entries) !== JSON.stringify(expected)) return response({ error: 'Initial upload is incomplete. Sync again to resume.' }, 409);
				return response({ lastSeq: 11 });
			}
			case '/sync/import/readiness': return response({ ready: true });
			case '/sync/batch-upload': return accept(body.files as BatchUploadFile[]);
			case '/sync/batch-delete': {
				const files = body.files as Array<{ path: string }>;
				for (const file of files) delete remote[file.path];
				return response({ success: true, deleted: files.map(file => file.path) });
			}
			default: throw new Error(`Unexpected request: ${request.url}`);
		}
	});
	return { remote, routes, transport };
}

async function createVault(transport: ApiHttpTransport, lastSeq: number) {
	const harness = await createPersistentEngineHarness(transport, { lastSeq, automaticSync: false });
	await harness.vault.adapter.mkdir('notes');
	await harness.vault.adapter.mkdir('media');
	harness.disk.write('notes/a.md', 'alpha');
	harness.disk.write('notes/b.md', 'beta');
	harness.disk.write(BIG, new ArrayBuffer(26 * 1024 * 1024));
	return harness;
}

it('force full sync replaces the server copy around a file over 25 MB', async () => {
	const server = createServer([]);
	const harness = await createVault(server.transport, 10);

	const result = await harness.engine.forceFullSync();

	expect(result.success, result.errors.join('\n')).toBe(true);
	expect(result).toMatchObject({ uploaded: 2, deleted: 1, errors: [], issues: [oversizedIssue] });
	expect(Object.keys(server.remote).sort()).toEqual([BIG, 'notes/a.md', 'notes/b.md']);
	expect(server.remote[BIG]?.revision).toBe('rev-b');
});

it('fails a force full sync when a file grows past 25 MB after discovery', async () => {
	const server = createServer([]);
	const harness = await createVault(server.transport, 10);
	const readBinary = harness.vault.adapter.readBinary.bind(harness.vault.adapter);
	vi.spyOn(harness.vault.adapter, 'readBinary').mockImplementation(async path =>
		path === 'notes/b.md' ? new ArrayBuffer(26 * 1024 * 1024) : readBinary(path));

	const result = await harness.engine.forceFullSync();

	expect(result.success).toBe(false);
	expect(result.errors).toEqual([`notes/b.md: ${OVERSIZED_LOCAL_FILE_MESSAGE}`]);
	expect(server.remote['remote-only.md']).toBeDefined();
});

it('finishes an initial import around a file over 25 MB', async () => {
	const server = createServer([INITIAL_IMPORT_CAPABILITY]);
	const harness = await createVault(server.transport, 0);
	// This device started the import, so it may prune the removed note.
	harness.localManifest.setInitialImportToken('import-1');
	await harness.localManifest.save();

	const result = await harness.engine.sync();

	expect(result.success, result.errors.join('\n')).toBe(true);
	expect(result).toMatchObject({ uploaded: 2, errors: [], issues: [oversizedIssue] });
	expect(server.routes).toContain('/sync/import/complete');
	expect(harness.settings.lastSeq).toBe(11);
	expect(Object.keys(server.remote).sort()).toEqual([BIG, 'notes/a.md', 'notes/b.md']);
	expect(server.remote[BIG]?.revision).toBe('rev-b');
});
