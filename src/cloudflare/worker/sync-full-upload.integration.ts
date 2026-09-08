/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { sha256HexBytes } from './auth';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});
async function device() {
	const client = new SyncTestDevice(`full-upload-${clients.length}`, env);
	clients.push(client); await client.authorize(); await client.open(); return client;
}
async function remote(client: SyncTestDevice, path: string) {
	return new TextDecoder().decode((await client.api.downloadFile(path)).content);
}

it('batches cold uploads with absent-file guards and preserves confirmed revisions and progress', async () => {
	const client = await device();
	for (let index = 0; index < 7; index++) client.disk.write(`note-${index}.md`, `Note ${index}`);
	const batch = vi.spyOn(client.api, 'batchUpload'); const progress = vi.fn();
	const result = await client.engine.sync(progress);
	expect(result.errors).toEqual([]); expect(result.uploaded).toBe(7);
	expect(batch.mock.calls.map(([files]) => files.length)).toEqual([3, 3, 1]);
	expect(batch.mock.calls.flatMap(([files]) => files).every(file => file.expectedHash === null)).toBe(true);
	expect(client.requests).not.toContain('PUT /sync/upload');
	expect(progress).toHaveBeenLastCalledWith(7, 7);
	const manifest = await client.api.getManifest();
	for (const [path, entry] of Object.entries(manifest.files)) {
		expect(client.checkpoint().files[path]).toMatchObject({ hash: entry.hash, revision: entry.revision });
		expect(await remote(client, path)).toBe(client.disk.text(path));
	}
});

it('keeps a stale member and healthy batch members recoverable across a concurrent remote edit', async () => {
	const client = await device(); const other = await device();
	const original = '# Shared\n\nAlpha\n\nBeta\n';
	client.disk.write('shared.md', original); client.disk.write('healthy.md', 'Original');
	expect((await client.engine.sync()).errors).toEqual([]);
	const base = client.checkpoint().files['shared.md']!;
	client.settings.lastSeq = 0;
	client.disk.write('shared.md', original.replace('Beta', 'Beta local'));
	client.disk.write('healthy.md', 'Healthy local');
	const batch = client.api.batchUpload.bind(client.api);
	vi.spyOn(client.api, 'batchUpload').mockImplementationOnce(async files => {
		const content = new TextEncoder().encode(original.replace('Alpha', 'Alpha remote')).buffer;
		await other.api.uploadFile('shared.md', content, await sha256HexBytes(content), content.byteLength, 'text/markdown', base.hash);
		expect(files.find(file => file.path === 'shared.md')?.expectedHash).toBe(base.hash);
		return batch(files);
	});
	const result = await client.engine.sync();
	expect(result.success).toBe(false);
	expect(result.errors).toEqual(['shared.md: Remote file changed since it was read']);
	expect(result.uploadedPaths).toEqual(['healthy.md']);
	expect(client.checkpoint().files['shared.md']).toEqual(base);
	expect(client.disk.text('shared.md')).toContain('Beta local');
	expect(await remote(client, 'shared.md')).toContain('Alpha remote');
	expect(await remote(client, 'healthy.md')).toBe('Healthy local');
	expect(client.settings.lastSeq).toBe(0);
	expect((await client.engine.sync()).errors).toEqual([]);
	const merged = original.replace('Alpha', 'Alpha remote').replace('Beta', 'Beta local');
	expect(client.disk.text('shared.md')).toBe(merged);
	expect(await remote(client, 'shared.md')).toBe(merged);
});

it('resumes a cold batch after committed response loss and retains a later local edit', async () => {
	const client = await device();
	for (let index = 0; index < 7; index++) client.disk.write(`note-${index}.md`, `Note ${index}`);
	const pause = client.pauseNextUploadResponse();
	const pending = client.engine.sync();
	await pause.committed;
	client.close(); await pending;
	client.disk.write('note-0.md', 'Edited after the lost response');
	await client.open();
	const recovered = await client.engine.sync();
	expect(recovered.errors).toEqual([]);
	pause.release();
	// A lost first upload has no confirmed local merge base. Preserve the later
	// edit as a visible conflict copy instead of guessing which creation wins.
	expect(recovered.conflicts).toHaveLength(1);
	expect(client.disk.text(recovered.conflicts[0]!)).toBe('Edited after the lost response');
	for (let index = 0; index < 7; index++) {
		const path = `note-${index}.md`;
		expect(await remote(client, path)).toBe(`Note ${index}`);
		expect(client.disk.text(path)).toBe(`Note ${index}`);
	}
	expect(Object.keys((await client.api.getManifest()).files)).toHaveLength(7);
});
