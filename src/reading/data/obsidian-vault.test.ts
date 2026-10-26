import { TFile, TFolder, type Vault } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { createObsidianReadingVault } from './obsidian-vault';
import { ReadingLibrary } from './library';

function harness() {
	const file = Object.assign(new TFile(), { path: 'Reading/note.md', extension: 'md', stat: { size: 4, mtime: 1 } });
	const folder = Object.assign(new TFolder(), { path: 'Reading', children: [file] });
	const entries = new Map<string, TFile | TFolder>([[file.path, file], [folder.path, folder]]);
	const controller = new AbortController();
	let allowed = true, content = 'text';
	const vault = {
		getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
		getAllLoadedFiles: () => [...entries.values()],
		adapter: { readBinary: vi.fn(async (_path: string): Promise<ArrayBuffer> => new TextEncoder().encode(content).buffer) },
		read: vi.fn(async () => content),
		process: vi.fn(async (_file: TFile, update: (source: string) => string) => { content = update(content); return content; }),
		createFolder: vi.fn(async (path: string) => { entries.set(path, Object.assign(new TFolder(), { path, children: [] })); }),
		create: vi.fn(async () => {}),
	};
	const validate = vi.fn();
	const fileManager = { renameFile: vi.fn(async (_file: TFile, _path: string) => {}) };
	const adapter = createObsidianReadingVault(vault as unknown as Vault, 'Reading', { signal: controller.signal, allowed: () => allowed, validate, fileManager });
	return { adapter, vault, file, folder, entries, controller, validate, fileManager, exclude: () => { allowed = false; }, content: () => content, setContent: (next: string) => { content = next; } };
}

it.each(['rename', 'delete', 'replace', 'exclude', 'stop'] as const)('rejects a read that finishes after %s', async change => {
	const h = harness(), snapshot = h.adapter.files()[0]!;
	h.vault.adapter.readBinary.mockImplementation(async () => {
		if (change === 'rename') h.file.path = 'Reading/moved.md';
		if (change === 'delete') h.entries.delete(snapshot.path);
		if (change === 'replace') h.entries.set(snapshot.path, Object.assign(new TFile(), { ...h.file }));
		if (change === 'exclude') h.exclude();
		if (change === 'stop') h.controller.abort();
		return new TextEncoder().encode('old bytes').buffer;
	});
	await expect(h.adapter.read(snapshot)).rejects.toThrow();
});

it('rechecks identity inside the atomic update callback and preserves a replacement', async () => {
	const h = harness(), snapshot = h.adapter.files()[0]!;
	const process = h.vault.process.getMockImplementation()!;
	h.vault.process.mockImplementation(async (file, update) => {
		h.entries.set(snapshot.path, Object.assign(new TFile(), { ...file }));
		return process(file, update);
	});
	const update = vi.fn(() => 'changed');
	await expect(h.adapter.process(snapshot, update)).rejects.toThrow('moved');
	expect(update).not.toHaveBeenCalled();
	expect(h.content()).toBe('text');
});

it('invalidates same-stat modifications and replacement identities, while enforcing current folder validation', () => {
	const h = harness(), first = h.adapter.files()[0]!;
	h.adapter.changed(first.path);
	const edited = h.adapter.files()[0]!;
	expect(edited.revision).not.toBe(first.revision);
	const replacement = Object.assign(new TFile(), { ...h.file });
	h.entries.set(first.path, replacement); h.folder.children = [replacement];
	expect(h.adapter.files()[0]!.revision).not.toBe(edited.revision);
	h.validate.mockImplementation(() => { throw new Error('Invalid configuration'); });
	expect(() => h.adapter.files()).toThrow('Invalid configuration');
});

it('stops creation if shutdown occurs while making the folder', async () => {
	const h = harness(); h.entries.delete('Reading');
	h.vault.createFolder.mockImplementation(async () => { h.controller.abort(); });
	await expect(h.adapter.create('Reading/new.md', 'new')).rejects.toThrow();
	expect(h.vault.create).not.toHaveBeenCalled();
});

it('renames the current note through the file manager and rejects stale or excluded targets', async () => {
	const h = harness(), snapshot = h.adapter.files()[0]!;
	await h.adapter.rename!(snapshot, 'Reading/Title - example.com - a1b2c3d4.md');
	expect(h.fileManager.renameFile).toHaveBeenCalledWith(h.file, 'Reading/Title - example.com - a1b2c3d4.md');
	h.exclude();
	await expect(h.adapter.rename!(snapshot, 'Reading/Other.md')).rejects.toThrow();
	expect(h.fileManager.renameFile).toHaveBeenCalledTimes(1);
});

it('lists a note with invalid UTF-8 as an issue instead of importing its replaced text', async () => {
	const h = harness();
	h.setContent('# Clip\n\uFFFD');
	h.vault.adapter.readBinary.mockResolvedValue(new Uint8Array([...new TextEncoder().encode('# Clip\n'), 0xff]).buffer);
	const library = new ReadingLibrary(h.adapter, 'Reading', h.controller.signal);
	await library.refresh();
	expect(library.getSnapshot().issues).toEqual([{ path: 'Reading/note.md', message: 'Save this note as UTF-8 without null characters to use it in Reading. The original vault file remains synced.' }]);
	expect(h.vault.read).not.toHaveBeenCalled();
	expect(h.vault.process).not.toHaveBeenCalled();
	expect(h.content()).toBe('# Clip\n\uFFFD');
});

it('rejects an update when the note changes after its bytes were verified', async () => {
	const h = harness(), snapshot = h.adapter.files()[0]!;
	h.vault.adapter.readBinary.mockImplementationOnce(async () => { const bytes = new TextEncoder().encode(h.content()).buffer; h.setContent('edited'); return bytes; });
	const update = vi.fn(() => 'changed');
	await expect(h.adapter.process(snapshot, update)).rejects.toThrow('changed while it was being read');
	expect(update).not.toHaveBeenCalled();
	expect(h.content()).toBe('edited');
});
