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
		stat: vi.fn(async (target: string) => files.has(target) ? { type: 'file' } : null),
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

describe('safe local application', () => {
	it.each(['notes/note.md', '.hidden/note.md', 'drawing.canvas', 'settings.json', '.hidden/settings.json'])('retains an edit arriving after the hash check: %s', async (path) => {
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

	it.each(['image.png', 'script.js', 'theme.css', 'settings.json', 'invalid.md', '.hidden/image.png'])('preserves incoming binary bytes for review without replacing %s', async (path) => {
		const original = new Uint8Array([255, 0, 254]).buffer;
		const remote = new Uint8Array([254, 0, 255]).buffer;
		const h = harness(path, original);
		const hash = await computeHash(original);
		expect((await applyRemoteContentIfUnchanged(h.context, path, remote, hash)).status).toBe('deferred');
		expect(h.files.get(path)).toEqual(original);
		expect([...h.files.entries()].filter(([name]) => name !== path).map(([, bytes]) => bytes)).toEqual([remote]);
		await applyRemoteContentIfUnchanged(h.context, path, remote, hash);
		expect(h.files.size).toBe(2);
		expect(h.vault.modifyBinary).not.toHaveBeenCalled();
		expect(h.vault.process).not.toHaveBeenCalled();
	});

	it('does not overwrite a concurrent visible create', async () => {
		const h = harness('unrelated.md', encode('unrelated'));
		h.vault.createBinary.mockImplementation(async (path) => {
			h.files.set(path, encode('created by another plugin'));
			throw new Error('File exists');
		});
		await expect(applyRemoteContentIfUnchanged(h.context, 'new.png', encode('remote'), null)).rejects.toThrow('File exists');
		expect(decode(h.files.get('new.png')!)).toBe('created by another plugin');
	});
});

it('preserves edits to an earlier incoming binary copy when the transfer retries', async () => {
  const original = new Uint8Array([255, 0, 254]).buffer;
  const remote = new Uint8Array([254, 0, 255]).buffer;
  const h = harness('image.png', original);
  await applyRemoteContentIfUnchanged(h.context, 'image.png', remote, await computeHash(original));
  const copy = [...h.files.keys()].find(path => path !== 'image.png')!;
  h.files.set(copy, encode('edited recovery copy'));
  await applyRemoteContentIfUnchanged(h.context, 'image.png', remote, await computeHash(original));
  expect(decode(h.files.get(copy)!)).toBe('edited recovery copy');
  expect([...h.files.values()]).toContainEqual(remote);
  expect(h.files.get('image.png')).toEqual(original);
});
