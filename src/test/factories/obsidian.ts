import { TFile, type App } from 'obsidian';
import { vi } from 'vitest';

export type MockVault = {
	adapter: {
		exists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
	};
	getAbstractFileByPath: ReturnType<typeof vi.fn<(path: string) => TFile | null>>;
	createFolder: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
	create: ReturnType<typeof vi.fn<(path: string, content: string) => Promise<void>>>;
	read: ReturnType<typeof vi.fn<(file: TFile) => Promise<string>>>;
	modify: ReturnType<typeof vi.fn<(file: TFile, content: string) => Promise<void>>>;
};

export type MockAppResult = {
	app: App;
	files: Map<string, string>;
	folders: Set<string>;
	vault: MockVault;
};

export function createMockTFile(path: string): TFile {
	const file = new TFile();
	const name = path.split('/').pop() ?? path;
	const dotIndex = name.lastIndexOf('.');

	file.vault = {} as never;
	file.path = path;
	file.name = name;
	file.parent = null;
	file.basename = dotIndex >= 0 ? name.slice(0, dotIndex) : name;
	file.extension = dotIndex >= 0 ? name.slice(dotIndex + 1) : '';
	file.stat = { ctime: 0, mtime: 0, size: 0 };

	return file;
}

export function createMockAppWithVault(initialFiles: Record<string, string> = {}): MockAppResult {
	const files = new Map(Object.entries(initialFiles));
	const folders = new Set<string>();

	const vault: MockVault = {
		adapter: {
			exists: vi.fn(async (path: string) => folders.has(path) || files.has(path)),
		},
		getAbstractFileByPath: vi.fn((path: string) =>
			files.has(path) ? createMockTFile(path) : null
		),
		createFolder: vi.fn(async (path: string) => {
			folders.add(path);
		}),
		create: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		read: vi.fn(async (file: { path: string }) => files.get(file.path) || ''),
		modify: vi.fn(async (file: { path: string }, content: string) => {
			files.set(file.path, content);
		}),
	};

	return { app: { vault } as unknown as App, files, folders, vault };
}
