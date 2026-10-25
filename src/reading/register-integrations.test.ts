import { afterEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { registerReading } from './register-integrations';
import { READING_VIEW_TYPE, clearRequestedReadingItem, requestedReadingItem } from './runtime';

vi.mock('./ui/plugin/reading-view', () => ({ ReadingView: class {} }));
vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<typeof import('obsidian')>(), addIcon: vi.fn() }));
vi.mock('./ui/plugin/add-link-modal', () => ({ AddReadingLinkModal: class {} }));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<typeof import('./runtime')>(), startReading: vi.fn(), stopReading: vi.fn() }));

// The mock TFile takes a path; the real one does not.
const note = (path: string) => new (TFile as unknown as new (path: string) => TFile)(path);
const id = '0cf86c65-51e2-4e2b-8987-0a4732473588';

type MockView = { file: TFile | null; leaf: { setViewState: ReturnType<typeof vi.fn> }; addAction: ReturnType<typeof vi.fn> };

function harness(enabled = true, frontmatter: Record<string, unknown> = { crate_reading_id: id }) {
	const handlers = new Map<string, (params: Record<string, string>) => void>();
	const events = new Map<string, () => void>();
	const leaf = { setViewState: vi.fn(async () => {}) };
	const views: MockView[] = [];
	const triggerForegroundSync = vi.fn();
	const plugin = {
		settings: { reading: { enabled, folderPath: 'Reading' } }, register: vi.fn(), registerView: vi.fn(), addCommand: vi.fn(),
		registerEvent: vi.fn(),
		registerObsidianProtocolHandler: (action: string, handler: (params: Record<string, string>) => void) => { handlers.set(action, handler); },
		syncRuntime: { triggerForegroundSync },
		app: {
			metadataCache: { getFileCache: () => ({ frontmatter }), on: vi.fn() },
			workspace: {
				getLeavesOfType: (type: string) => type === 'markdown' ? views.map(view => ({ view })) : [],
				getLeaf: () => leaf, revealLeaf: vi.fn(async () => {}), onLayoutReady: vi.fn(),
				on: (name: string, callback: () => void) => { events.set(name, callback); },
			},
		},
	} as unknown as CratePlugin;
	registerReading(plugin);
	const openNote = (path: string) => {
		const action = { remove: vi.fn() };
		const view: MockView = { file: note(path), leaf: { setViewState: vi.fn(async () => {}) }, addAction: vi.fn(() => action) };
		views.push(view); events.get('layout-change')!();
		return { view, action };
	};
	return { plugin, leaf, triggerForegroundSync, openNote, refresh: () => events.get('layout-change')!(), open: (params: Record<string, string>) => handlers.get('crate-reading')!({ action: 'crate-reading', ...params }) };
}

describe('crate-reading protocol', () => {
	afterEach(() => { vi.useRealTimers(); });

	it('syncs, opens reading and requests the saved article', async () => {
		const { plugin, leaf, triggerForegroundSync, open } = harness();
		open({ item: id.toUpperCase() });
		expect(triggerForegroundSync).toHaveBeenCalledWith('visible');
		await vi.waitFor(() => expect(leaf.setViewState).toHaveBeenCalledWith({ type: READING_VIEW_TYPE, active: true }));
		expect(requestedReadingItem(plugin)).toBe(id);
		clearRequestedReadingItem(plugin);
	});

	it('ignores malformed ids and expires unanswered requests', async () => {
		vi.useFakeTimers();
		const invalid = harness();
		invalid.open({ item: '../note' });
		await vi.waitFor(() => expect(invalid.leaf.setViewState).toHaveBeenCalled());
		expect(requestedReadingItem(invalid.plugin)).toBeUndefined();

		const stale = harness();
		stale.open({ item: id });
		await vi.waitFor(() => expect(stale.leaf.setViewState).toHaveBeenCalled());
		vi.advanceTimersByTime(120_000);
		expect(requestedReadingItem(stale.plugin)).toBeUndefined();
	});

	it('does not request an article while reading is disabled', () => {
		const { plugin, leaf, open } = harness(false);
		open({ item: id });
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(requestedReadingItem(plugin)).toBeUndefined();
	});
});

describe('open in reader header button', () => {
	it('opens the reading note in its own tab', async () => {
		const { plugin, leaf, openNote } = harness();
		const { view } = openNote('Reading/article.md');
		expect(view.addAction).toHaveBeenCalledOnce();
		((view.addAction.mock.calls[0] as unknown[])[2] as () => void)();
		await vi.waitFor(() => expect(view.leaf.setViewState).toHaveBeenCalledWith({ type: READING_VIEW_TYPE, active: true }));
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(requestedReadingItem(plugin)).toBe(id);
		clearRequestedReadingItem(plugin);
	});

	it('only appears on reading notes', () => {
		expect(harness().openNote('Notes/article.md').view.addAction).not.toHaveBeenCalled();
		expect(harness(true, { title: 'Article' }).openNote('Reading/article.md').view.addAction).not.toHaveBeenCalled();
		expect(harness(false).openNote('Reading/article.md').view.addAction).not.toHaveBeenCalled();
	});

	it('is removed when the tab moves to another note', () => {
		const { openNote, refresh } = harness();
		const { view, action } = openNote('Reading/article.md');
		view.file = note('Notes/other.md');
		refresh();
		expect(action.remove).toHaveBeenCalledOnce();
	});
});
