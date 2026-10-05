/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';

let device: SyncTestDevice;
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	for (const sql of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	device = new SyncTestDevice('editing-device', env);
	await device.authorize();
	await device.open();
});
afterEach(async () => {
	device.close();
	vi.unstubAllGlobals();
	await reset();
});

it.each(['vault', 'selected'] as const)('batches ordinary Markdown line edits through %s sync', async mode => {
	const paths = Array.from({ length: 12 }, (_, index) => `note-${index}.md`);
	const original = '# Note\n\nOriginal line.\n';
	for (const path of [...paths, 'unselected.md']) device.disk.write(path, original);
	expect((await device.engine.sync()).success).toBe(true);
	const lastSeq = device.settings.lastSeq;
	for (const path of paths) {
		device.disk.write(path, `${original}\nAdded line.\n`);
		device.engine.onFileChange({ path } as never);
	}
	if (mode === 'selected') {
		device.disk.write('unselected.md', `${original}\nKeep this edit local.\n`);
		device.engine.onFileChange({ path: 'unselected.md' } as never);
	}
	device.requests.length = 0;
	const result = await (mode === 'selected' ? device.engine.syncSelected(paths) : device.engine.sync());
	expect(result).toMatchObject({ success: true, uploaded: 12, downloaded: 0, merged: 0, errors: [] });
	expect(device.requests.filter(route => route === 'PUT /sync/upload')).toHaveLength(0);
	expect(device.requests.filter(route => route === 'POST /sync/batch-upload')).toHaveLength(4);
	for (const path of paths) {
		expect(new TextDecoder().decode((await device.api.downloadFile(path)).content)).toBe(`${original}\nAdded line.\n`);
	}
	if (mode === 'selected') {
		expect(device.settings.lastSeq).toBe(lastSeq);
		expect(device.engine.getPendingPaths()).toEqual(['unselected.md']);
		expect(new TextDecoder().decode((await device.api.downloadFile('unselected.md')).content)).toBe(original);
	}
	for (const path of paths) {
		device.disk.write(path, original);
		device.engine.onFileChange({ path } as never);
	}
	device.requests.length = 0;
	expect(await (mode === 'selected' ? device.engine.syncSelected(paths) : device.engine.sync()))
		.toMatchObject({ success: true, uploaded: 12, downloaded: 0, merged: 0, errors: [] });
	expect(device.requests.filter(route => route === 'PUT /sync/upload')).toHaveLength(0);
	expect(device.requests.filter(route => route === 'POST /sync/batch-upload')).toHaveLength(4);
	for (const path of paths) expect(new TextDecoder().decode((await device.api.downloadFile(path)).content)).toBe(original);
});

it('does not transfer a Markdown line added and removed before selected sync', async () => {
	const path = 'note.md';
	const original = '# Note\n\nOriginal line.\n';
	device.disk.write(path, original);
	expect((await device.engine.sync()).success).toBe(true);
	device.disk.write(path, `${original}\nTemporary line.\n`);
	device.engine.onFileChange({ path } as never);
	device.disk.write(path, original);
	device.engine.onFileChange({ path } as never);
	device.requests.length = 0;
	expect(await device.engine.syncSelected([path])).toMatchObject({ success: true, uploaded: 0, downloaded: 0, merged: 0 });
	expect(device.requests.filter(route => /upload|download/.test(route))).toEqual([]);
	expect(device.engine.getPendingPaths()).toEqual([]);
});

it('keeps a newer local edit pending while the selected batch is in flight', async () => {
	device.disk.write('note.md', 'Original.\n');
	expect((await device.engine.sync()).success).toBe(true);
	device.disk.write('note.md', 'First edit.\n');
	device.engine.onFileChange({ path: 'note.md' } as never);
	const paused = device.pauseNextUploadResponse();
	const syncing = device.engine.syncSelected(['note.md']);
	try {
		await paused.committed;
		device.disk.write('note.md', 'Newer edit.\n');
		device.engine.onFileChange({ path: 'note.md' } as never);
	} finally {
		paused.release();
	}
	expect((await syncing).success).toBe(true);
	expect(device.disk.text('note.md')).toBe('Newer edit.\n');
	expect(device.engine.getPendingPaths()).toEqual(['note.md']);
	expect(new TextDecoder().decode((await device.api.downloadFile('note.md')).content)).toBe('First edit.\n');
	expect((await device.engine.syncSelected(['note.md'])).success).toBe(true);
	expect(device.engine.getPendingPaths()).toEqual([]);
	expect(new TextDecoder().decode((await device.api.downloadFile('note.md')).content)).toBe('Newer edit.\n');
});

it('reconciles a server edit arriving after selected-file metadata was read', async () => {
	const original = '# Note\n\nAlpha.\n\nBeta.\n';
	device.disk.write('note.md', original);
	expect((await device.engine.sync()).success).toBe(true);
	const rival = new SyncTestDevice('other-device', env);
	await rival.authorize();
	await rival.open();
	try {
		expect((await rival.engine.sync()).success).toBe(true);
		device.disk.write('note.md', original.replace('Alpha.', 'Local alpha.'));
		device.engine.onFileChange({ path: 'note.md' } as never);
		const getMetadata = device.api.getFileMetadata.bind(device.api);
		vi.spyOn(device.api, 'getFileMetadata').mockImplementationOnce(async paths => {
			const metadata = await getMetadata(paths);
			rival.disk.write('note.md', original.replace('Beta.', 'Remote beta.'));
			expect((await rival.engine.sync()).success).toBe(true);
			return metadata;
		});
		expect(await device.engine.syncSelected(['note.md'])).toMatchObject({ success: true, merged: 1, errors: [] });
		const merged = original.replace('Alpha.', 'Local alpha.').replace('Beta.', 'Remote beta.');
		expect(device.disk.text('note.md')).toBe(merged);
		expect(new TextDecoder().decode((await device.api.downloadFile('note.md')).content)).toBe(merged);
		expect(device.engine.getPendingPaths()).toEqual([]);
	} finally {
		rival.close();
	}
});

it.each([false, true])('preserves rename ordering with selected batched uploads (failure: %s)', async fail => {
	device.disk.write('old.md', 'Keep this note.\n');
	expect((await device.engine.sync()).success).toBe(true);
	device.disk.rename('old.md', 'new.md');
	device.engine.onFileRename({ path: 'new.md' } as never, 'old.md');
	device.requests.length = 0;
	if (fail) vi.spyOn(device.files, 'batchUpload').mockRejectedValueOnce(new Error('Upload unavailable'));
	const result = await device.engine.syncSelected(['delete:old.md', 'new.md']);
	expect(result.success).toBe(!fail);
	if (fail) {
		expect(device.requests).not.toContain('POST /sync/delete');
		expect(Object.keys((await device.api.getManifest()).files)).toEqual(['old.md']);
		expect(new TextDecoder().decode((await device.api.downloadFile('old.md')).content)).toBe('Keep this note.\n');
	} else {
		expect(device.requests).toContain('POST /sync/batch-upload');
		expect(device.requests.indexOf('POST /sync/batch-upload')).toBeLessThan(device.requests.indexOf('POST /sync/delete'));
		expect(Object.keys((await device.api.getManifest()).files)).toEqual(['new.md']);
		expect(new TextDecoder().decode((await device.api.downloadFile('new.md')).content)).toBe('Keep this note.\n');
	}
	expect(device.disk.text('new.md')).toBe('Keep this note.\n');
});
