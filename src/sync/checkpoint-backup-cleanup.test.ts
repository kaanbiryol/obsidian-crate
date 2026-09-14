import { expect, it, vi } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { pruneCheckpointBackups, registerCheckpointBackupCleanup } from './checkpoint-backup-cleanup';
import { computeHash } from './hasher';
import { arrayBufferToBase64 } from './encoding';
import type { SyncState } from './types';

const dir = '.obsidian/plugins/crate';
const id = 'e1_00020708_fa270a13-1cb3-4f6a-8529-7e06d75f806f';
const backup = `${dir}/upload-${id}.json.previous-a1f6ed79-839e-4d7a-aab1-ba18fbc36b52`;
const day = 86400000;
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
async function fixture() {
	const payload = { content: arrayBufferToBase64(bytes('saved note')), hash: await computeHash(bytes('saved note')), size: 10 };
	const record = { version: 2, authority: 'https://old.example', sequence: 1, file: {
		...payload, path: 'note.md', contentType: 'text/markdown', expectedHash: null,
		operationId: id, origin: { clientSession: 'fa270a13-1cb3-4f6a-8529-7e06d75f806f', at: '2026-09-13T00:00:00.000Z' },
		intent: { kind: 'local' },
	} };
	const disk = new Map([[backup, JSON.stringify(record)], ['note.md', 'saved note']]);
	const adapter = {
		list: vi.fn(async () => ({ files: [...disk.keys()], folders: [] })),
		read: vi.fn(async (path: string) => { if (!disk.has(path)) throw Error('missing'); return disk.get(path)!; }),
		readBinary: vi.fn(async (path: string) => { if (!disk.has(path)) throw Error('missing'); return bytes(disk.get(path)!); }),
		remove: vi.fn(async (path: string) => { disk.delete(path); }),
	};
	const run = (signal = new AbortController().signal) => pruneCheckpointBackups(adapter as unknown as DataAdapter, dir, signal);
	return { disk, adapter, run, record, payload };
}

it('removes a verified duplicate without requiring age or remote access', async () => {
	const f = await fixture();
	expect(await f.run()).toBe(1);
	expect(f.disk.get('note.md')).toBe('saved note');
	expect(await f.run()).toBe(0);
});

it.each(['different', 'missing', 'corrupt', 'unsupported', 'preimage', 'private', 'wrong-id'])('preserves %s recovery data', async kind => {
	const f = await fixture();
	if (kind === 'different') f.disk.set('note.md', 'newer note');
	if (kind === 'missing') f.disk.delete('note.md');
	if (kind === 'corrupt') f.record.file.content = 'AAAA';
	if (kind === 'unsupported') f.record.version = 3;
	if (kind === 'preimage') Object.assign(f.record.file, { intent: { kind: 'merge', preimage: {
		content: arrayBufferToBase64(bytes('old')), hash: await computeHash(bytes('old')), size: 3,
	} } });
	if (kind === 'private') f.record.file.path = `${dir}/saved.md`;
	if (kind === 'wrong-id') f.record.file.operationId = 'e1_00020709_fa270a13-1cb3-4f6a-8529-7e06d75f806f';
	f.disk.set(backup, JSON.stringify(f.record));
	expect(await f.run()).toBe(0);
	expect(f.adapter.remove).not.toHaveBeenCalled();
});

it('ignores active records, manifests, unrelated files and nested paths', async () => {
	const f = await fixture();
	const content = f.disk.get(backup)!;
	f.disk.delete(backup);
	for (const path of [`${dir}/pending-uploads/${id}.json`, `${dir}/file-manifest.json.previous-a1f6ed79-839e-4d7a-aab1-ba18fbc36b52`, `${dir}/other.json`, `${dir}/nested/${backup.split('/').at(-1)!}`]) f.disk.set(path, content);
	expect(await f.run()).toBe(0);
	expect(f.adapter.readBinary).not.toHaveBeenCalled();
});

it('preserves a backup replaced during verification', async () => {
	const f = await fixture();
	f.adapter.readBinary.mockImplementation(async () => { f.disk.set(backup, 'replacement'); return bytes('saved note'); });
	expect(await f.run()).toBe(0);
	expect(f.disk.get(backup)).toBe('replacement');
});

it('stops before deletion when unloaded during verification', async () => {
	const f = await fixture();
	const controller = new AbortController();
	f.adapter.readBinary.mockImplementation(async () => { controller.abort(); return bytes('saved note'); });
	expect(await f.run(controller.signal)).toBe(0);
	expect(f.adapter.remove).not.toHaveBeenCalled();
});

it('retries a failed deletion on the next pass', async () => {
	const f = await fixture();
	f.adapter.remove.mockRejectedValueOnce(Error('busy'));
	expect(await f.run()).toBe(0);
	expect(await f.run()).toBe(1);
});

it('checks after startup, sync, and daily, and disposes timers and listeners', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', globalThis);
	try {
		const list = vi.fn(async () => ({ files: [], folders: [] }));
		const disposers: Array<() => void> = [];
		let listener: (state: SyncState) => void = () => {};
		const removeStateChangeListener = vi.fn();
		const controller = new AbortController();
		const plugin = {
			manifest: { dir }, app: { vault: { adapter: { list } } },
			syncRuntime: {
				getState: () => ({ status: 'idle' }),
				addStateChangeListener: (next: typeof listener) => { listener = next; }, removeStateChangeListener,
			},
			register: (dispose: () => void) => disposers.push(dispose),
			registerInterval: (timer: number) => disposers.push(() => clearInterval(timer)),
		};
		registerCheckpointBackupCleanup(plugin as unknown as Parameters<typeof registerCheckpointBackupCleanup>[0], controller.signal);
		expect(list).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(list).toHaveBeenCalledTimes(1);
		listener({ status: 'syncing' } as SyncState);
		listener({ status: 'idle' } as SyncState);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(list).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(day);
		expect(list).toHaveBeenCalledTimes(3);
		controller.abort();
		for (const dispose of disposers) dispose();
		await vi.advanceTimersByTimeAsync(day);
		expect(list).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
		expect(removeStateChangeListener).toHaveBeenCalledWith(listener);
	} finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
