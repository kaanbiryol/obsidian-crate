import { TFile, type Vault } from 'obsidian';
import { getExtensionFromPath, isHiddenPath } from '../../sync/local/file-discovery';
import { portablePathKey } from '../../protocol/portable-path';

export const TEST_PLUGIN_DIR = '.obsidian/plugins/crate';

/** Shared persistent vault fixture; real sync owns checkpoints, hashes and merges. */
export class PersistentTestVault {
	private readonly files = new Map<string, { content: ArrayBuffer; mtime: number }>();
	private readonly folders = new Set<string>(['']);
	private readonly fileObjects = new Map<string, TFile>();
	private mtime = Date.parse('2026-01-01T00:00:00Z');
	readonly trash = new Map<string, ArrayBuffer>();

	/** A case-insensitive disk keeps names as written but matches adapter paths that
	 * differ only in case or Unicode form, as macOS, iOS and Windows do. Obsidian's
	 * index (`getAbstractFileByPath`) stays exact on every disk. */
	constructor(private readonly options: { caseInsensitive?: boolean } = {}) { this.mkdir(TEST_PLUGIN_DIR); }

	write(path: string, content: string | ArrayBuffer): void {
		const existing = this.resolve(path);
		if (existing !== undefined && this.folders.has(existing)) throw new Error(`Folder already exists: ${path}`);
		this.files.set(existing ?? this.placement(path), {
			content: typeof content === 'string' ? new TextEncoder().encode(content).buffer : content.slice(0),
			mtime: ++this.mtime,
		});
	}

	read(path: string): ArrayBuffer {
		const stored = this.resolve(path);
		const file = stored === undefined ? undefined : this.files.get(stored);
		if (!file) throw new Error(`Missing file: ${path}`);
		return file.content.slice(0);
	}

	text(path: string): string { return new TextDecoder().decode(this.read(path)); }
	has(path: string): boolean { return this.files.has(path); }
	remove(path: string): void { this.files.delete(path); this.fileObjects.delete(path); }

	rename(from: string, to: string): void {
		const identity = this.fileObjects.get(from);
		const content = this.read(from);
		const target = this.resolve(to);
		if (target !== undefined && target !== from) throw new Error(`Destination exists: ${to}`);
		if (target === undefined) this.placement(to);
		this.remove(from);
		this.write(to, content);
		if (identity) {
			identity.path = to;
			this.fileObjects.set(to, identity);
			this.file(to);
		}
	}

	paths(): string[] { return [...this.files.keys()].filter(path => !isHiddenPath(path)).sort(); }

	/** The stored spelling of an existing path; a case-insensitive disk also matches its variants. */
	private resolve(path: string): string | undefined {
		if (this.files.has(path) || this.folders.has(path)) return path;
		if (!this.options.caseInsensitive) return undefined;
		const key = portablePathKey(path);
		return [...this.files.keys(), ...this.folders].find(stored => portablePathKey(stored) === key);
	}

	/** A new entry keeps its name inside its parent folder's stored spelling. */
	private placement(path: string): string {
		const slash = path.lastIndexOf('/');
		const parent = slash < 0 ? '' : this.resolve(path.slice(0, slash));
		if (parent === undefined || !this.folders.has(parent)) throw new Error(`Missing parent folder: ${path.slice(0, Math.max(slash, 0))}`);
		return parent ? `${parent}/${path.slice(slash + 1)}` : path;
	}

	private mkdir(path: string): void {
		let parent = '';
		for (const segment of path.split('/')) {
			const requested = parent ? `${parent}/${segment}` : segment;
			const folder = this.resolve(requested) ?? requested;
			if (this.files.has(folder)) throw new Error(`File blocks folder: ${requested}`);
			this.folders.add(folder);
			parent = folder;
		}
	}

	private file(path: string): TFile | null {
		const file = this.files.get(path);
		if (!file || isHiddenPath(path)) return null;
		const name = path.split('/').at(-1)!;
		const extension = getExtensionFromPath(path);
		const object = this.fileObjects.get(path) ?? new TFile();
		this.fileObjects.set(path, object);
		return Object.assign(object, {
			path, name, extension, basename: extension ? name.slice(0, -extension.length - 1) : name,
			stat: { size: file.content.byteLength, mtime: file.mtime, ctime: file.mtime },
		});
	}

	private list(path: string): { files: string[]; folders: string[] } {
		const folder = this.resolve(path);
		if (folder === undefined || !this.folders.has(folder)) throw new Error(`Missing folder: ${path}`);
		const prefix = folder ? `${folder}/` : '';
		const child = (candidate: string) => candidate.startsWith(prefix)
			&& candidate !== folder && !candidate.slice(prefix.length).includes('/');
		// Like a host adapter, join stored child names to the requested folder path.
		const listed = (candidate: string) => `${path ? `${path}/` : ''}${candidate.slice(prefix.length)}`;
		return {
			files: [...this.files.keys()].filter(child).map(listed),
			folders: [...this.folders].filter(child).map(listed),
		};
	}

	private process(path: string, update: (content: string) => string): string {
		const replacement = update(this.text(path));
		this.write(path, replacement);
		return replacement;
	}

	private moveToTrash(path: string): void {
		const stored = this.resolve(path) ?? path;
		this.trash.set(stored, this.read(stored));
		this.remove(stored);
	}

	readonly vault = {
		configDir: '.obsidian',
		getFiles: () => this.paths().map(path => this.file(path)!),
		getAbstractFileByPath: (path: string) => this.file(path),
		readBinary: async (file: TFile) => this.read(file.path),
		createFolder: async (path: string) => { this.mkdir(path); },
		createBinary: async (path: string, content: ArrayBuffer) => {
			const existing = this.resolve(path);
			if (existing !== undefined && this.files.has(existing)) throw new Error(`File already exists: ${path}`);
			this.write(path, content);
			return this.file(path);
		},
		process: async (file: TFile, update: (content: string) => string) => this.process(file.path, update),
		trash: async (file: TFile) => { this.moveToTrash(file.path); },
		adapter: {
			exists: async (path: string) => this.resolve(path) !== undefined,
			read: async (path: string) => this.text(path),
			readBinary: async (path: string) => this.read(path),
			write: async (path: string, text: string) => { this.write(path, text); },
			append: async (path: string, text: string) => { this.write(path, (this.files.has(this.resolve(path) ?? path) ? this.text(path) : '') + text); },
			writeBinary: async (path: string, content: ArrayBuffer) => { this.write(path, content); },
			remove: async (path: string) => { this.remove(this.resolve(path) ?? path); },
			rename: async (from: string, to: string) => { this.rename(this.resolve(from) ?? from, to); },
			rmdir: async (path: string, recursive: boolean) => {
				const children = this.list(path);
				if (recursive || children.files.length || children.folders.length) throw new Error('Directory is not empty');
				this.folders.delete(this.resolve(path) ?? path);
			},
			mkdir: async (path: string) => { this.mkdir(path); },
			list: async (path: string) => this.list(path),
			process: async (path: string, update: (content: string) => string) => this.process(path, update),
			trashLocal: async (path: string) => { this.moveToTrash(path); },
			stat: async (path: string) => {
				const stored = this.resolve(path) ?? path;
				const file = this.files.get(stored);
				if (file) return { type: 'file', size: file.content.byteLength, mtime: file.mtime, ctime: file.mtime };
				return this.folders.has(stored) ? { type: 'folder', size: 0, mtime: 0, ctime: 0 } : null;
			},
		},
	} as unknown as Vault;
}
