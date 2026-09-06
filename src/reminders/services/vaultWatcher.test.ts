import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { VaultWatcher } from './vaultWatcher';

type VaultEvent = 'modify' | 'create' | 'delete' | 'rename';
type VaultHandler = (...args: never[]) => void;

function createMarkdownFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split('/').pop() ?? path;
	file.extension = 'md';
	return file;
}

function createHarness() {
	const handlers = new Map<VaultEvent, VaultHandler>();
	const vault = {
		on: vi.fn((event: VaultEvent, handler: VaultHandler) => {
			handlers.set(event, handler);
			return { event };
		}),
		offref: vi.fn(),
	};
	const index = {
		isReminderFile: vi.fn(() => true),
		rescanFile: vi.fn(async () => undefined),
		removeFile: vi.fn(),
		renameFile: vi.fn(),
	};
	const watcher = new VaultWatcher(
		{ app: { vault } } as never,
		index as never,
	);
	watcher.register();
	return { handlers, index, vault, watcher };
}

describe('VaultWatcher', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('window', { clearTimeout, setTimeout });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('rescans a modified reminder file', async () => {
		const { handlers, index } = createHarness();
		const file = createMarkdownFile('Reminders/Work.md');

		handlers.get('modify')?.(file as never);
		await vi.advanceTimersByTimeAsync(1500);
		await vi.runAllTimersAsync();

		expect(index.rescanFile).toHaveBeenCalledWith(file);
	});

	it('cancels queued work when unregistered', async () => {
		const { handlers, index, vault, watcher } = createHarness();

		handlers.get('modify')?.(createMarkdownFile('Reminders/Work.md') as never);
		watcher.unregister();
		await vi.runAllTimersAsync();

		expect(vault.offref).toHaveBeenCalledTimes(4);
		expect(index.rescanFile).not.toHaveBeenCalled();
	});
});
