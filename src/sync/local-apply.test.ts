import { describe, expect, it, vi } from 'vitest';
import { applyRemoteContentIfUnchanged, preserveLocalVersionsAndApplyRemote } from './local-apply';
import { computeHash } from './hasher';

const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const decode = (content: ArrayBuffer): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(content);

function harness(path: string, initial: ArrayBuffer) {
	const files = new Map([[path, initial]]);
	let beforeProcess = () => {};
	const process = vi.fn(async (target: string, update: (text: string) => string) => {
		beforeProcess();
		const next = update(decode(files.get(target)!));
		files.set(target, encode(next));
		return next;
	});
	const adapter = {
		readBinary: vi.fn(async (target: string) => files.get(target)!),
		exists: vi.fn(async (target: string) => files.has(target)),
		mkdir: vi.fn(async () => {}),
		writeBinary: vi.fn(async (target: string, content: ArrayBuffer) => { files.set(target, content); }),
		process,
	};
	const vault = {
		adapter,
		getAbstractFileByPath: vi.fn((target: string) => files.has(target) && !target.startsWith('.')
			? { path: target, extension: target.split('.').pop() } : null),
		createFolder: vi.fn(async () => {}),
		createBinary: vi.fn(async (target: string, content: ArrayBuffer) => {
			if (files.has(target)) throw new Error('File exists');
			files.set(target, content);
		}),
		modifyBinary: vi.fn(async (file: { path: string }, content: ArrayBuffer) => { files.set(file.path, content); }),
		process: vi.fn(async (file: { path: string }, update: (text: string) => string) => process(file.path, update)),
	};
	return { files, vault, context: { vault: vault as never }, beforeProcess: (callback: () => void) => { beforeProcess = callback; } };
}

describe('atomic Markdown application', () => {
	it.each(['notes/note.md', '.hidden/note.md'])('retains an edit arriving after the hash check: %s', async (path) => {
		const original = encode('original');
		const h = harness(path, original);
		h.beforeProcess(() => h.files.set(path, encode('new local edit')));
		const outcome = await applyRemoteContentIfUnchanged(h.context, path, encode('remote'), await computeHash(original));
		expect(outcome.status).toBe('deferred');
		expect(decode(h.files.get(path)!)).toBe('new local edit');
		expect(h.vault.modifyBinary).not.toHaveBeenCalled();
		expect(h.vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	it.each(['notes/note.md', '.hidden/note.md'])('preserves exact UTF-8 bytes when unchanged: %s', async (path) => {
		const original = encode('\uFEFFOriginal café\r\n');
		const remote = encode('\uFEFFUpdated café ☕\r\n');
		const h = harness(path, original);
		expect(await applyRemoteContentIfUnchanged(h.context, path, remote, await computeHash(original)))
			.toEqual({ status: 'applied' });
		expect(h.files.get(path)).toEqual(remote);
		expect(h.vault.adapter.process).toHaveBeenCalledTimes(1);
	});

	it('retains an edit arriving after its conflict copy was saved', async () => {
		const path = 'notes/note.md';
		const original = encode('local conflict');
		const h = harness(path, original);
		h.beforeProcess(() => h.files.set(path, encode('newer local edit')));
		const onCopy = vi.fn(async () => {});
		const outcome = await preserveLocalVersionsAndApplyRemote(h.context, path, original, encode('remote'), onCopy);
		expect(outcome.status).toBe('deferred');
		expect(decode(h.files.get(path)!)).toBe('newer local edit');
		expect([...h.files.entries()].filter(([name]) => name !== path).map(([, content]) => decode(content)))
			.toEqual(['local conflict']);
		expect(onCopy).toHaveBeenCalledTimes(1);
	});

	it('propagates actual disk errors instead of treating them as an edit', async () => {
		const path = 'notes/note.md';
		const original = encode('original');
		const h = harness(path, original);
		h.beforeProcess(() => { throw new Error('Disk full'); });
		await expect(applyRemoteContentIfUnchanged(h.context, path, encode('remote'), await computeHash(original)))
			.rejects.toThrow('Disk full');
		expect(h.files.get(path)).toEqual(original);
	});

	it.each(['image.png', 'script.js', 'theme.css', 'settings.json', 'invalid.md'])('keeps byte-for-byte transfers for %s', async (path) => {
		const original = new Uint8Array([255, 0, 254]).buffer;
		const remote = new Uint8Array([254, 0, 255]).buffer;
		const h = harness(path, original);
		expect(await applyRemoteContentIfUnchanged(h.context, path, remote, await computeHash(original)))
			.toEqual({ status: 'applied' });
		expect(h.files.get(path)).toEqual(remote);
		expect(h.vault.process).not.toHaveBeenCalled();
	});
});
