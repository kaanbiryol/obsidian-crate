import { TFile, type Vault } from 'obsidian';
import { getExtensionFromPath, isHiddenPath } from '../../sync/file-discovery';

export const TEST_PLUGIN_DIR = '.obsidian/plugins/crate';

/** Persistent host filesystem seam; real sync owns checkpoints, hashes and merges. */
export class PersistentTestVault {
	private readonly files = new Map<string, { content: ArrayBuffer; mtime: number }>();
	private readonly folders = new Set<string>(['']);
	private mtime = Date.parse('2026-01-01T00:00:00Z');
	readonly trash = new Map<string, ArrayBuffer>();

	constructor() { this.mkdir(TEST_PLUGIN_DIR); }

	write(path: string, content: string | ArrayBuffer): void {
		const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (!this.folders.has(parent)) throw new Error(`Missing parent folder: ${parent}`);
		this.files.set(path, {
			content: typeof content === 'string' ? new TextEncoder().encode(content).buffer : content.slice(0),
			mtime: ++this.mtime,
		});
	}

	read(path: string): ArrayBuffer {
		const file = this.files.get(path);
		if (!file) throw new Error(`Missing file: ${path}`);
		return file.content.slice(0);
	}

	text(path: string): string { return new TextDecoder().decode(this.read(path)); }
	has(path: string): boolean { return this.files.has(path); }
	remove(path: string): void { this.files.delete(path); }

	rename(from: string, to: string): void {
		const content = this.read(from);
		if (this.files.has(to)) throw new Error(`Destination exists: ${to}`);
		this.write(to, content);
		this.remove(from);
	}

	paths(): string[] { return [...this.files.keys()].filter(path => !isHiddenPath(path)).sort(); }

	private mkdir(path: string): void {
		const segments = path.split('/');
		for (let index = 1; index <= segments.length; index++) this.folders.add(segments.slice(0, index).join('/'));
	}

	private file(path: string): TFile | null {
		const file = this.files.get(path);
		if (!file || isHiddenPath(path)) return null;
		const name = path.split('/').at(-1)!;
		const extension = getExtensionFromPath(path);
		return Object.assign(new TFile(), {
			path, name, extension, basename: extension ? name.slice(0, -extension.length - 1) : name,
			stat: { size: file.content.byteLength, mtime: file.mtime, ctime: file.mtime },
		});
	}

	private list(path: string): { files: string[]; folders: string[] } {
		if (!this.folders.has(path)) throw new Error(`Missing folder: ${path}`);
		const prefix = path ? `${path}/` : '';
		const child = (candidate: string) => candidate.startsWith(prefix)
			&& candidate !== path && !candidate.slice(prefix.length).includes('/');
		return {
			files: [...this.files.keys()].filter(child),
			folders: [...this.folders].filter(child),
		};
	}

	private process(path: string, update: (content: string) => string): string {
		const replacement = update(this.text(path));
		this.write(path, replacement);
		return replacement;
	}

	private moveToTrash(path: string): void {
		this.trash.set(path, this.read(path));
		this.remove(path);
	}

	readonly vault = {
		configDir: '.obsidian',
		getFiles: () => this.paths().map(path => this.file(path)!),
		getAbstractFileByPath: (path: string) => this.file(path),
		createFolder: async (path: string) => { this.mkdir(path); },
		createBinary: async (path: string, content: ArrayBuffer) => {
			if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
			this.write(path, content);
			return this.file(path);
		},
		process: async (file: TFile, update: (content: string) => string) => this.process(file.path, update),
		trash: async (file: TFile) => { this.moveToTrash(file.path); },
		adapter: {
			exists: async (path: string) => this.files.has(path) || this.folders.has(path),
			read: async (path: string) => this.text(path),
			readBinary: async (path: string) => this.read(path),
			write: async (path: string, text: string) => { this.write(path, text); },
			writeBinary: async (path: string, content: ArrayBuffer) => { this.write(path, content); },
			remove: async (path: string) => { this.remove(path); },
			mkdir: async (path: string) => { this.mkdir(path); },
			list: async (path: string) => this.list(path),
			process: async (path: string, update: (content: string) => string) => this.process(path, update),
			trashLocal: async (path: string) => { this.moveToTrash(path); },
			stat: async (path: string) => {
				const file = this.files.get(path);
				if (file) return { type: 'file', size: file.content.byteLength, mtime: file.mtime, ctime: file.mtime };
				return this.folders.has(path) ? { type: 'folder', size: 0, mtime: 0, ctime: 0 } : null;
			},
		},
	} as unknown as Vault;
}
