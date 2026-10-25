import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { sha256Hex } from '../../platform/sha256';
import { arrayBufferToBase64 } from '../encoding';
import type { ApiHttpTransport } from '../worker-api/http';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

it('does not download an incoming binary again while its saved copy awaits review', async () => {
	const original = new Uint8Array([255, 1]).buffer;
	const incoming = new Uint8Array([255, 2, 3]).buffer;
	const incomingHash = await sha256Hex(incoming);
	let downloads = 0;
	const transport = vi.fn<ApiHttpTransport>(async request => {
		const url = new URL(request.url);
		let value: unknown;
		if (url.pathname === '/.well-known/crate') {
			value = { service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) };
		} else if (url.pathname === '/sync/changes') {
			value = { changes: [{ seq: 11, path: 'image.bin', action: 'put', hash: incomingHash, size: 3, created_at: '2026-10-01T00:00:00.000Z', revision: 'r2' }], lastSeq: 11, hasMore: false };
		} else if (url.pathname === '/sync/batch-download') {
			downloads++;
			value = { files: [{ path: 'image.bin', content: arrayBufferToBase64(incoming), size: 3, hash: incomingHash, revision: 'r2' }] };
		} else throw new Error(`Unexpected request: ${request.url}`);
		const text = JSON.stringify(value);
		return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
	});
	const harness = await createPersistentEngineHarness(transport, { lastSeq: 10, automaticSync: false });
	harness.disk.write('image.bin', original);
	const stat = await harness.vault.adapter.stat('image.bin');
	harness.localManifest.setEntry('image.bin', { hash: await sha256Hex(original), revision: 'r1', size: 2, modified: new Date(stat!.mtime).toISOString() });
	await harness.localManifest.save();

	const results = [await harness.engine.sync(), await harness.engine.sync(), await harness.engine.sync()];

	expect(downloads).toBe(1);
	expect(harness.engine.getActiveConflicts()).toHaveLength(1);
	for (const result of results) expect(result.errors.join('\n')).toContain('Incoming file saved at');
	// The cursor stays held until the review is resolved.
	expect(harness.settings.lastSeq).toBe(10);
});
