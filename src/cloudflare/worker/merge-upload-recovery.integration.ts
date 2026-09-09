// Regression cases from the current-revision pre-release audit.
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';

const devices: SyncTestDevice[] = [];
let mutationLogs: unknown[][] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	mutationLogs = [];
	vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { mutationLogs.push(args); });
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
	for (const device of devices.splice(0)) { device.close(); await device.engine.waitForIdle(); }
	vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});
const original = '# Shared\n\nAlpha original\n\nBeta original\n';
const expected = original.replace('Alpha original', 'Alpha from A').replace('Beta original', 'Beta from B');
async function sync(device: SyncTestDevice) {
	const result = await device.engine.sync();
	expect(result.errors).toEqual([]);
	return result;
}
async function prepare() {
	const a = new SyncTestDevice('audit-a', env), b = new SyncTestDevice('audit-b', env);
	devices.push(a, b);
	for (const device of devices) { await device.authorize(3_600_000); await device.open(); }
	a.disk.write('note.md', original); await sync(a); await sync(b);
	a.disk.write('note.md', original.replace('Alpha original', 'Alpha from A'));
	b.disk.write('note.md', original.replace('Beta original', 'Beta from B'));
	await sync(a);
	return { a, b };
}

it('control: uninterrupted auto-merge preserves both devices edits', async () => {
	const { a, b } = await prepare();
	expect((await sync(b)).merged).toBe(1);
	await sync(a);
	for (const device of devices) expect(device.disk.text('note.md')).toBe(expected);
});

it('preserves remote edits when restarting after the merge upload commits but before its response arrives', async () => {
	const { a, b } = await prepare();
	const paused = b.pauseNextUploadResponse();
	const pending = b.engine.sync();
	await paused.committed;
	const operationId = b.api.getRequestDiagnostics().uploads!.slice().reverse().find(row => row.kind === 'merge')!.operationId;
	expect(new TextDecoder().decode((await a.api.downloadFile('note.md')).content)).toBe(expected);
	b.close(); await pending; await b.engine.waitForIdle();
	paused.release();
	await b.open();
	await sync(b); await sync(a);
	const observed = { a: a.disk.text('note.md'), b: b.disk.text('note.md'), remote: new TextDecoder().decode((await a.api.downloadFile('note.md')).content) };
	expect(observed).toEqual({ a: expected, b: expected, remote: expected });
	const diagnostics = b.api.getRequestDiagnostics();
	const trace = diagnostics.uploads!.filter(row => row.operationId === operationId);
	expect(trace.map(row => row.phase)).toEqual(expect.arrayContaining(['prepared', 'replaying', 'remote-committed', 'local-applied', 'checkpointed']));
	expect(new Set(trace.map(row => row.clientSession)).size).toBe(2);
	expect(diagnostics.requests.some(row => row.uploadOperationIds?.includes(operationId))).toBe(true);
	const logged = mutationLogs.filter(([event, detail]) => event === 'crate.mutation' && (detail as { uploadOperationIds: string[] }).uploadOperationIds.includes(operationId));
	expect(logged).toHaveLength(2);
});

it('preserves remote edits after the merged upload succeeds but local application fails once', async () => {
	const { a, b } = await prepare();
	const originalProcess = b.disk.vault.process.bind(b.disk.vault);
	const processSpy = vi.spyOn(b.disk.vault, 'process').mockImplementationOnce(async () => { throw new Error('Injected local disk write failure'); });
	const failed = await b.engine.sync();
	expect(failed.errors.length).toBeGreaterThan(0);
	processSpy.mockImplementation(originalProcess);
	await sync(b); await sync(a);
	const observed = { a: a.disk.text('note.md'), b: b.disk.text('note.md'), remote: new TextDecoder().decode((await a.api.downloadFile('note.md')).content) };
	expect(observed).toEqual({ a: expected, b: expected, remote: expected });
});

it.each(['incremental', 'full'])('keeps a new offline edit made after response loss in %s reconciliation', async mode => {
	const { a, b } = await prepare();
	const paused = b.pauseNextUploadResponse();
	const pending = b.engine.sync(); await paused.committed;
	b.close(); await pending; await b.engine.waitForIdle(); paused.release();
	b.disk.write('note.md', b.disk.text('note.md') + '\nNew offline edit\n');
	if (mode === 'full') b.settings.lastSeq = 0;
	await b.open(); await sync(b); await sync(a);
	for (const device of devices) expect(device.disk.text('note.md')).toBe(expected + '\nNew offline edit\n');
});

it.each(['edit', 'delete'])('preserves a third device %s after a merged upload with a lost response', async action => {
	const { a, b } = await prepare();
	const paused = b.pauseNextUploadResponse();
	const pending = b.engine.sync(); await paused.committed;
	b.close(); await pending; await b.engine.waitForIdle(); paused.release();
	const c = new SyncTestDevice('audit-c', env); devices.push(c); await c.authorize(); await c.open(); await sync(c);
	if (action === 'edit') c.disk.write('note.md', expected + '\nThird device edit\n');
	else c.disk.remove('note.md');
	await sync(c); await b.open(); await sync(b); await sync(a);
	for (const device of devices) {
		if (action === 'edit') expect(device.disk.text('note.md')).toBe(expected + '\nThird device edit\n');
		else expect(device.disk.has('note.md')).toBe(false);
	}
});

it.each(['local-apply', 'base-cache', 'checkpoint-main', 'checkpoint-temp', 'journal-prune'])('preserves a merge across %s failure and restart', async failure => {
	const { a, b } = await prepare();
	const adapter = b.disk.vault.adapter;
	const write = adapter.write.bind(adapter), writeBinary = adapter.writeBinary.bind(adapter), remove = adapter.remove.bind(adapter);
	const process = b.disk.vault.process.bind(b.disk.vault);
	const processSpy = vi.spyOn(b.disk.vault, 'process').mockImplementation(async (...args) => {
		if (failure === 'local-apply') throw new Error('Injected local write failure');
		return process(...args);
	});
	const binarySpy = vi.spyOn(adapter, 'writeBinary').mockImplementation(async (...args) => {
		if (failure === 'base-cache') throw new Error('Injected base cache write failure');
		return writeBinary(...args);
	});
	const writeSpy = vi.spyOn(adapter, 'write').mockImplementation(async (path, data) => {
		if (failure === 'checkpoint-main' && path.endsWith('/file-manifest.json')
			|| failure === 'checkpoint-temp' && path.endsWith('/file-manifest.json.tmp')) throw new Error('Injected checkpoint failure');
		return write(path, data);
	});
	const removeSpy = vi.spyOn(adapter, 'remove').mockImplementation(async path => {
		if (failure === 'journal-prune' && path.includes('/pending-uploads/')) throw new Error('Injected prune failure');
		return remove(path);
	});
	await b.engine.sync(); b.close(); await b.engine.waitForIdle();
	for (const spy of [processSpy, binarySpy, writeSpy, removeSpy]) spy.mockRestore();
	await b.open(); await sync(b); await sync(a);
	for (const device of devices) expect(device.disk.text('note.md')).toBe(expected);
	const rows = b.api.getRequestDiagnostics().uploads ?? [];
	expect(rows.some(row => row.kind === 'merge' && row.phase === 'checkpointed')).toBe(true);
	expect(JSON.stringify(rows)).not.toContain('note.md');
	expect(JSON.stringify(rows)).not.toContain('Alpha from A');
});

it('keeps API reads side effect free while an upload is pending', async () => {
	const { b } = await prepare();
	const paused = b.pauseNextUploadResponse();
	const pending = b.engine.sync(); await paused.committed;
	b.close(); await pending; await b.engine.waitForIdle(); paused.release(); await b.open();
	const before = b.requests.length;
	await b.api.getManifest(); await b.api.getFileMetadata(['note.md']); await b.api.getChanges(0);
	expect(b.requests.slice(before).every(route => !route.includes('upload'))).toBe(true);
	await sync(b);
	expect(b.disk.text('note.md')).toBe(expected);
});

it('recovers an uncertain merge before queued edits can upload a stale local snapshot', async () => {
	const { a, b } = await prepare();
	const paused = b.pauseNextUploadResponse();
	const pending = b.engine.sync(); await paused.committed;
	b.close(); await pending; await b.engine.waitForIdle(); paused.release();
	b.disk.write('note.md', b.disk.text('note.md') + '\nQueued offline edit\n');
	await b.open(); b.settings.debounceDelay = 0;
	b.engine.onFileChange(b.disk.vault.getAbstractFileByPath('note.md')!);
	await vi.waitFor(() => expect(b.disk.text('note.md')).toBe(expected + '\nQueued offline edit\n'), { timeout: 10_000 });
	await vi.waitFor(() => expect(b.engine.getState().status).toBe('idle'), { timeout: 10_000 });
	await sync(a);
	expect(a.disk.text('note.md')).toBe(expected + '\nQueued offline edit\n');
});
