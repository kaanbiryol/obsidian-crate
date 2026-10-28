import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { sha256Hex } from '../../platform/sha256';
import { arrayBufferToBase64 } from '../encoding';
import type { ApiHttpResponse, ApiHttpTransport } from '../worker-api/http';
import type { FileEntry } from '../../protocol/sync-types';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

const reviewIssue: unknown = expect.objectContaining({ path: 'image.bin', code: 'incoming-review', message: expect.stringContaining('Incoming file saved at') as string });

/** A binary edited on the server while `old.md` was deleted on this device. */
async function awaitingReview(options: { expiredCursor?: boolean } = {}) {
	const original = new Uint8Array([255, 1]).buffer;
	const incoming = new Uint8Array([255, 2, 3]).buffer;
	const other = new TextEncoder().encode('other').buffer;
	const oldEntry: FileEntry = { hash: 'a'.repeat(64), revision: 'o1', size: 1, modified: '2026-09-01T00:00:00.000Z' };
	const remote = new Map<string, { entry: FileEntry; content?: ArrayBuffer }>([
		['image.bin', { entry: { hash: await sha256Hex(incoming), size: 3, modified: '2026-10-01T00:00:00.000Z', revision: 'r2' }, content: incoming }],
		['other.md', { entry: { hash: await sha256Hex(other), size: 5, modified: '2026-10-01T00:00:00.000Z', revision: 'm1' }, content: other }],
		['old.md', { entry: oldEntry }],
	]);
	const changed = ['image.bin', 'other.md'].map((path, index) => ({ seq: 10 + index, path, action: 'put', ...remote.get(path)!.entry, created_at: remote.get(path)!.entry.modified }));
	const requests = { downloads: [] as string[], metadata: [] as string[][], deletes: [] as string[] };
	const transport = vi.fn<ApiHttpTransport>(async (request): Promise<ApiHttpResponse> => {
		const url = new URL(request.url);
		const body = typeof request.body === 'string' ? JSON.parse(request.body) as Record<string, unknown> : {};
		let value: unknown;
		if (url.pathname === '/.well-known/crate') {
			value = { service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) };
		} else if (url.pathname === '/sync/changes') {
			const since = Number(url.searchParams.get('since'));
			value = since >= 11 ? { changes: [], lastSeq: 11, hasMore: false }
				: options.expiredCursor ? { changes: [], lastSeq: 11, hasMore: false, cursorExpired: true }
					: { changes: changed, lastSeq: 11, hasMore: false };
		} else if (url.pathname === '/sync/manifest') {
			value = { version: 1, files: Object.fromEntries([...remote].map(([path, file]) => [path, file.entry])), lastSeq: 11, snapshotSeq: 11, hasMore: false };
		} else if (url.pathname === '/sync/metadata') {
			const paths = body.paths as string[];
			requests.metadata.push(paths);
			value = { files: Object.fromEntries(paths.flatMap(path => remote.has(path) ? [[path, remote.get(path)!.entry]] : [])) };
		} else if (url.pathname === '/sync/batch-download') {
			const paths = body.paths as string[];
			requests.downloads.push(...paths);
			value = { files: paths.map(path => ({ path, content: arrayBufferToBase64(remote.get(path)!.content!), ...remote.get(path)!.entry })) };
		} else if (url.pathname === '/sync/download') {
			const path = url.searchParams.get('path')!;
			requests.downloads.push(path);
			const { entry, content } = remote.get(path)!;
			return { status: 200, headers: { 'X-File-Hash': entry.hash, 'X-Crate-Revision': entry.revision! }, text: '', arrayBuffer: content!.slice(0) };
		} else if (url.pathname === '/sync/batch-delete') {
			const paths = (body.files as Array<{ path: string }>).map(file => file.path);
			requests.deletes.push(...paths);
			for (const path of paths) remote.delete(path);
			value = { success: true, deleted: paths };
		} else throw new Error(`Unexpected request: ${request.url}`);
		const text = JSON.stringify(value);
		return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
	});
	const harness = await createPersistentEngineHarness(transport, { lastSeq: 9, automaticSync: false });
	harness.disk.write('image.bin', original);
	const stat = await harness.vault.adapter.stat('image.bin');
	const baseline: FileEntry = { hash: await sha256Hex(original), revision: 'r1', size: 2, modified: new Date(stat!.mtime).toISOString() };
	harness.localManifest.setEntry('image.bin', baseline);
	harness.localManifest.setEntry('old.md', oldEntry);
	await harness.localManifest.save();
	return { ...harness, transport, original, incoming, baseline, requests };
}

it('keeps syncing other files while an incoming binary awaits review', async () => {
	const harness = await awaitingReview();

	const results = [await harness.engine.sync(), await harness.engine.sync(), await harness.engine.sync()];

	for (const result of results) {
		expect(result).toMatchObject({ success: true, errors: [] });
		expect(result.issues).toContainEqual(reviewIssue);
	}
	// The cursor and the unrelated delete are not held back by the review.
	expect(harness.settings.lastSeq).toBe(11);
	expect(harness.requests.deletes).toEqual(['old.md']);
	expect(harness.localManifest.getEntry('old.md')).toBeUndefined();
	expect(harness.localManifest.getEntry('other.md')).toMatchObject({ revision: 'm1' });
	// Later syncs replan the path from its server version without downloading the saved copy again.
	expect(harness.requests.downloads.sort()).toEqual(['image.bin', 'other.md']);
	expect(harness.requests.metadata).toEqual([['image.bin'], ['image.bin']]);
	// The local file and its baseline are kept, so the conflict is still found.
	expect(harness.disk.read('image.bin')).toEqual(harness.original);
	expect(harness.localManifest.getEntry('image.bin')).toEqual(harness.baseline);
	expect(harness.engine.getActiveConflicts()).toEqual([expect.objectContaining({ originalPath: 'image.bin', cause: 'incoming-review' })]);
});

it('saves full sync baselines and the cursor around an incoming binary awaiting review', async () => {
	const harness = await awaitingReview({ expiredCursor: true });

	const results = [await harness.engine.sync(), await harness.engine.sync()];

	expect(harness.transport.mock.calls.filter(([request]) => new URL(request.url).pathname === '/sync/manifest')).toHaveLength(1);
	for (const result of results) {
		expect(result).toMatchObject({ success: true, errors: [] });
		expect(result.issues).toContainEqual(reviewIssue);
	}
	expect(harness.settings.lastSeq).toBe(11);
	expect(harness.requests.deletes).toEqual(['old.md']);
	expect(harness.localManifest.getEntry('other.md')).toMatchObject({ revision: 'm1' });
	expect(harness.requests.downloads.sort()).toEqual(['image.bin', 'other.md']);
	expect(harness.disk.read('image.bin')).toEqual(harness.original);
	expect(harness.localManifest.getEntry('image.bin')).toEqual(harness.baseline);
});

it('keeps the baseline of a binary edited on both sides while its incoming version awaits review', async () => {
	const harness = await awaitingReview({ expiredCursor: true });
	const edited = new Uint8Array([255, 4]).buffer;
	harness.disk.write('image.bin', edited);

	const result = await harness.engine.sync();

	expect(result).toMatchObject({ success: true, errors: [] });
	expect(result.issues).toContainEqual(reviewIssue);
	expect(harness.settings.lastSeq).toBe(11);
	expect(harness.requests.deletes).toEqual(['old.md']);
	expect(harness.disk.read('image.bin')).toEqual(edited);
	// Saving the edited bytes as the baseline would hide the local edit from the next sync.
	expect(harness.localManifest.getEntry('image.bin')).toEqual(harness.baseline);
});

it('restores the incoming version after a review replacement stops between trash and create', async () => {
	const harness = await awaitingReview();
	await harness.engine.sync();
	// Choosing the incoming copy drops the baseline before moving the original to trash.
	await harness.engine.prepareRecoverableReplacement('image.bin');
	harness.disk.remove('image.bin');

	const result = await harness.engine.sync();

	expect(result).toMatchObject({ success: true, errors: [] });
	expect(harness.disk.read('image.bin')).toEqual(harness.incoming);
	expect(harness.localManifest.getEntry('image.bin')).toMatchObject({ hash: await sha256Hex(harness.incoming), revision: 'r2' });
	expect(harness.requests.deletes).toEqual(['old.md']);
});
