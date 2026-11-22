/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { MAX_FILE_SIZE_BYTES } from '../../../protocol/sync-limits';
import { sha256Hex } from '@/platform/sha256';

const devices: SyncTestDevice[] = [];
const bindings = env as { CRATE_MAX_FILE_BYTES?: string };
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	// Transfer objects read the binding from the shared environment, as a deployment does.
	bindings.CRATE_MAX_FILE_BYTES = String(100 * 1024 * 1024);
	await applySchema(env.DB);
});
afterEach(async () => {
	for (const device of devices.splice(0)) device.close();
	delete bindings.CRATE_MAX_FILE_BYTES;
	vi.unstubAllGlobals();
	await reset();
});

async function device(id: string): Promise<SyncTestDevice> {
	const result = new SyncTestDevice(id, env);
	devices.push(result);
	await result.authorize();
	await result.open();
	return result;
}
async function sync(device: SyncTestDevice) {
	const result = await device.engine.sync();
	expect(result.errors, `${device.id}: ${JSON.stringify(result)}`).toEqual([]);
	expect(result.success).toBe(true);
	return result;
}

it('syncs an attachment above the default limit through upload sessions and ranges, through initial import and an edit', { timeout: 120_000 }, async () => {
	// Just above the default limit: the test isolate's memory holds both devices and the server.
	// Multi-part transfers are covered by upload-sessions.integration.ts and the plugin unit tests.
	const content = new Uint8Array(MAX_FILE_SIZE_BYTES + 1024 * 1024);
	for (let index = 0; index < content.length; index += 4096) content[index] = (index / 4096) % 251;
	const first = await device('chunked-first');
	first.disk.write('note.md', 'small');
	await first.disk.vault.adapter.mkdir('media');
	first.disk.write('media/video.bin', content.buffer);
	// The first sync imports the vault; the large file follows it in parts.
	await sync(first);
	await sync(first);
	expect(Object.keys((await first.api.getManifest()).files).sort()).toEqual(['media/video.bin', 'note.md']);
	const second = await device('chunked-second');
	await sync(second);
	// Compare hashes: a failing deep comparison of this many bytes would exhaust the isolate.
	expect(await sha256Hex(second.disk.read('media/video.bin'))).toBe(await sha256Hex(content));

	const edited = content.slice();
	edited[edited.length - 1] = 7;
	second.disk.write('media/video.bin', edited.buffer);
	await sync(second);
	// The edit travels in parts too. Devices keep an existing binary file and save incoming
	// changes beside it for review, so check the server copy.
	expect((await first.api.getManifest()).files['media/video.bin']).toMatchObject({ hash: await sha256Hex(edited), size: edited.length });
	expect(await sha256Hex((await first.api.downloadFile('media/video.bin')).content)).toBe(await sha256Hex(edited));
	// No upload journal bytes stay behind once the receipts are checkpointed.
	expect(second.disk.paths().filter(path => path.endsWith('.bin') && path.includes('pending-uploads'))).toEqual([]);
});
