import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TFile, TFolder, type App } from 'obsidian';
import { vi } from 'vitest';

/** Real byte storage with the host's UTF-8 text process semantics. */
export async function createReminderByteVault(initial: Record<string, string | Uint8Array>) {
	const directory = await mkdtemp(join(tmpdir(), 'crate-reminder-bytes-'));
	const files = new Map<string, TFile>();
	const folders = new Map<string, TFolder>();
	const local = (path: string) => join(directory, path);
	async function createFolder(path: string) {
		if (!path || path === '.') return;
		await mkdir(local(path), { recursive: true });
		if (!folders.has(path)) folders.set(path, Object.assign(new TFolder(), { path, name: path.split('/').pop(), children: [] }));
		await createFolder(dirname(path));
	}
	async function put(path: string, content: string | Uint8Array) {
		await createFolder(dirname(path));
		await writeFile(local(path), content);
		const info = await stat(local(path));
		const file = files.get(path) ?? new TFile();
		Object.assign(file, { path, name: path.split('/').pop(), extension: path.split('.').pop(), stat: { size: info.size, ctime: info.ctimeMs, mtime: info.mtimeMs } });
		files.set(path, file);
		return file;
	}
	const readBytes = (path: string) => readFile(local(path));
	const process = vi.fn(async (file: TFile, update: (text: string) => string) => {
		const before = await readFile(local(file.path), 'utf8');
		const next = update(before);
		if (next !== before) await put(file.path, next);
		return next;
	});
	const adapter = {
		readBinary: vi.fn(async (path: string) => Uint8Array.from(await readBytes(path)).buffer),
		read: async (path: string) => readFile(local(path), 'utf8'),
		write: async (path: string, text: string) => { await put(path, text); },
		exists: async (path: string) => files.has(path) || folders.has(path),
		mkdir: createFolder,
		list: async (path: string) => ({ files: [...files.keys()].filter(key => dirname(key) === path), folders: [...folders.keys()].filter(key => dirname(key) === path) }),
		remove: async (path: string) => { await rm(local(path)); files.delete(path); },
		rename: async (from: string, to: string) => {
			await createFolder(dirname(to));
			await rename(local(from), local(to));
			const file = files.get(from);
			files.delete(from);
			if (file) { file.path = to; file.name = to.split('/').pop()!; files.set(to, file); }
		},
	};
	const vault = {
		adapter, process,
		read: vi.fn(async (file: TFile) => readFile(local(file.path), 'utf8')),
		create: put, createFolder,
		getAbstractFileByPath: (path: string) => {
			const folder = folders.get(path);
			if (folder) folder.children = [...files.values(), ...folders.values()].filter(file => dirname(file.path) === path);
			return files.get(path) ?? folder ?? null;
		},
	};
	for (const [path, content] of Object.entries(initial)) await put(path, content);
	return { app: { vault } as unknown as App, vault, files, put, readBytes, dispose: () => rm(directory, { recursive: true, force: true }) };
}
